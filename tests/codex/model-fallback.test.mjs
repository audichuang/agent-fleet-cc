import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { isModelUnavailableFailure, MODEL_FALLBACK_SLUG } from "../../plugins/codex/scripts/lib/codex.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

const ENVELOPE_400 = {
  message: JSON.stringify({
    type: "error",
    status: 400,
    error: { type: "invalid_request_error", message: "The 'gpt-5.6-sol' model requires a newer version of Codex." }
  })
};

test("isModelUnavailableFailure matches the model-unavailable 400 envelope", () => {
  assert.equal(isModelUnavailableFailure({ status: 1, error: ENVELOPE_400 }), true);
});

test("isModelUnavailableFailure matches the confirmed model-gate signal (model + 'requires a newer version')", () => {
  for (const message of [
    "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade.",
    "requires a newer version of Codex to use the gpt-5.6-sol model" // order-independent
  ]) {
    assert.equal(isModelUnavailableFailure({ status: 1, error: { message } }), true, `should match: ${message}`);
  }
});

test("isModelUnavailableFailure is narrow — it does NOT match generic or speculative phrasings", () => {
  for (const message of [
    "401 Unauthorized",
    "429 Too Many Requests",
    "Something else broke",
    // requires-a-newer-version but NOT about a model → must not model-switch
    "This MCP integration requires a newer version of Codex",
    // "model" + a keyword, but not the confirmed gate → deliberately not matched
    "unsupported model output format",
    "model output has an unsupported content type",
    "model failed with an unknown transport error",
    "model gpt-5.6-sol not found"
  ]) {
    assert.equal(isModelUnavailableFailure({ status: 1, error: { message } }), false, `must NOT match: ${message}`);
  }
});

test("isModelUnavailableFailure checks BOTH sources (turn.error must not mask a model error in the notification)", () => {
  // A generic turn.error alongside a model-unavailable error notification must still fall back.
  const result = {
    status: 1,
    turn: { error: { message: "turn ended" } },
    error: { message: "The 'gpt-5.6-sol' model requires a newer version of Codex." }
  };
  assert.equal(isModelUnavailableFailure(result), true);
});

test("isModelUnavailableFailure is false for a successful result", () => {
  assert.equal(isModelUnavailableFailure({ status: 0, error: null }), false);
});

// The safety property, now structural rather than regex-conservative: the model gate is
// an HTTP 400 (`badRequest`), so any OTHER structured code is a genuine failure and must
// never be model-switched — even if its prose happens to carry the gate phrase.
test("isModelUnavailableFailure never fires when codexErrorInfo says the failure is something else", () => {
  const gatePhrase = "The 'gpt-5.6-sol' model requires a newer version of Codex.";
  for (const codexErrorInfo of [
    "unauthorized",
    "usageLimitExceeded",
    "contextWindowExceeded",
    "serverOverloaded",
    { responseStreamDisconnected: { httpStatusCode: 500 } }
  ]) {
    assert.equal(
      isModelUnavailableFailure({ status: 1, error: { message: gatePhrase, codexErrorInfo } }),
      false,
      `must NOT model-switch on ${JSON.stringify(codexErrorInfo)}`
    );
  }
  // The two codes a gate can arrive under BOTH still fall back. `other` is the one that
  // matters: an upstream 400 is CodexErrorDetails::UnexpectedStatus, which maps to the
  // `other` catch-all — a live 0.146.0 rejection returned `[other]`, so an allow-list of
  // `badRequest` alone would silently disable the whole 1.4.0 fallback.
  for (const codexErrorInfo of ["badRequest", "other"]) {
    assert.equal(
      isModelUnavailableFailure({ status: 1, error: { message: gatePhrase, codexErrorInfo } }),
      true,
      `must still fall back on ${codexErrorInfo}`
    );
  }
  // The gate on one source is not suppressed by another source's unrelated code.
  assert.equal(
    isModelUnavailableFailure({
      status: 1,
      turn: { error: { message: "turn ended", codexErrorInfo: "usageLimitExceeded" } },
      error: { message: gatePhrase, codexErrorInfo: "badRequest" }
    }),
    true
  );
});

test("e2e: `task --json` auto-falls back to gpt-5.6-terra when the default model is unavailable", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // buildEnv drops CODEX_*, so the default model resolves to gpt-5.6-sol; the fake
  // rejects sol as unavailable and accepts gpt-5.6-terra.
  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, `fallback to terra should succeed: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput ?? "", /Handled the requested task/, "the terra retry must produce the real result");
  assert.equal(payload.modelFallback?.from, "gpt-5.6-sol");
  assert.equal(payload.modelFallback?.to, MODEL_FALLBACK_SLUG);
});

test("e2e: an explicit --model gpt-5.6-terra does not trigger a redundant fallback", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing", "--model", "gpt-5.6-terra", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput ?? "", /Handled the requested task/);
  assert.equal(payload.modelFallback ?? null, null, "already-terra must not record a fallback");
});

// Diff-bearing repo helper for the review paths.
function repoWithDiff() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return repo;
}

test("e2e: native `review --json` auto-falls back to gpt-5.6-terra", () => {
  const repo = repoWithDiff();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.modelFallback?.to, MODEL_FALLBACK_SLUG, "native review must fall back too");
});

test("e2e: `adversarial-review --json` auto-falls back to gpt-5.6-terra", () => {
  const repo = repoWithDiff();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.modelFallback?.to, MODEL_FALLBACK_SLUG, "adversarial review must fall back too");
});

test("e2e: an explicit --model gpt-5.6-terra runs EXACTLY once even when terra is unavailable (guard)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error"); // rejects EVERY model, including terra
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing", "--model", "gpt-5.6-terra", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "terra also fails, so the job fails");
  // The guard (requestedModel === fallback) must prevent a pointless terra→terra retry.
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.nextTurnId, 2, "exactly one turn/start — no redundant terra retry");
});

test("e2e: when terra ALSO fails, the failure is surfaced (not swallowed) and the attempt is recorded", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error"); // sol rejected → retry terra → terra also rejected
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.errorMessage ?? "", /newer version of Codex/, "terra's failure reason must still surface");
  assert.equal(payload.modelFallback?.to, MODEL_FALLBACK_SLUG, "the fallback attempt must be recorded");
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.nextTurnId, 3, "exactly two turn/starts — sol then terra");
});

test("e2e: fallback is skipped when the failed turn already STARTED a command (--write safety)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-error-after-command"); // command starts, then model-gate error
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing", "--write", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "the model-gate error still fails the job");
  // Even though the error is model-unavailable, a command already started — retrying would
  // re-run it. The startedSideEffect guard must keep this to a single attempt.
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.nextTurnId, 2, "a turn that already started a command must NOT be retried");
});
