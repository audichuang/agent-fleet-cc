import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { resolveJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { describeTurnError } from "../../plugins/codex/scripts/lib/codex.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

// Drive the REAL companion CLI against a fake codex whose turn/review/start ACKs
// then emits a terminal `error` notification — the production silent-death path.
// A pre-fix companion emitted status:1 with an empty result and no errorMessage.
function commitInitial(repo) {
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

// The observed silent-death shape: the app-server delivered the HTTP-400
// model-unavailable error with `.message` being a JSON-encoded envelope, so the
// human text was buried one JSON level deep.
const ENVELOPE_400 = {
  message: JSON.stringify({
    type: "error",
    status: 400,
    error: {
      type: "invalid_request_error",
      message: "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
    }
  })
};

test("describeTurnError unwraps the JSON-encoded app-server error envelope", () => {
  assert.equal(
    describeTurnError(ENVELOPE_400),
    "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
  );
});

test("describeTurnError reads a directly-nested { error: { message } } envelope", () => {
  assert.equal(
    describeTurnError({ error: { message: "401 Unauthorized" } }),
    "401 Unauthorized"
  );
});

test("describeTurnError passes a plain message through verbatim", () => {
  assert.equal(describeTurnError({ message: "permanent auth failure" }), "permanent auth failure");
});

test("describeTurnError falls back to stderr, then null", () => {
  assert.equal(describeTurnError(null, "  boom on stderr  "), "boom on stderr");
  assert.equal(describeTurnError(null, ""), null);
  assert.equal(describeTurnError(undefined), null);
});

test("describeTurnError never throws on a malformed error object", () => {
  assert.doesNotThrow(() => describeTurnError({ message: "{not valid json" }));
  // A non-JSON-looking message is returned as-is even though it starts oddly.
  assert.equal(describeTurnError({ message: "{not valid json" }), "{not valid json");
});

// The v2 `TurnError` carries `codexErrorInfo` + `additionalDetails` alongside
// `message`; both were being dropped, so a delegating commander reading --json got
// prose only. Tag the code and keep the details.
test("describeTurnError surfaces the structured codexErrorInfo code", () => {
  assert.equal(
    describeTurnError({ message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" }),
    "Usage limit reached [usageLimitExceeded]"
  );
});

test("describeTurnError reads the tag from an object-form codexErrorInfo", () => {
  assert.equal(
    describeTurnError({ message: "stream died", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }),
    "stream died [httpConnectionFailed]"
  );
});

test("describeTurnError appends additionalDetails without duplicating it", () => {
  assert.equal(
    describeTurnError({ message: "Bad request", additionalDetails: "model gpt-5.6-sol is gated" }),
    "Bad request — model gpt-5.6-sol is gated"
  );
  // Already contained in the message → no duplicate tail.
  assert.equal(
    describeTurnError({ message: "Bad request: it is gated", additionalDetails: "it is gated" }),
    "Bad request: it is gated"
  );
});

test("describeTurnError annotates a stderr-only failure too, and ignores malformed error info", () => {
  assert.equal(describeTurnError({ codexErrorInfo: "unauthorized" }, "boom"), "boom [unauthorized]");
  for (const codexErrorInfo of [null, "", "   ", [], 7, {}]) {
    assert.equal(describeTurnError({ message: "plain", codexErrorInfo }), "plain");
  }
});

test("runTrackedJob persists errorMessage when the runner RETURNS a failed execution (turn-error path)", async () => {
  // This is the silent-death regression: a turn ended by an `error` notification
  // makes the runner RETURN { exitStatus: 1 } (it does not throw). Before the fix,
  // the success-return finalize wrote result/rendered but NO errorMessage, so
  // /codex:status + --json showed a bare "failed". Assert the reason is persisted.
  const workspace = makeTempDir();
  const jobId = "job-returned-failed";
  const reason = describeTurnError(ENVELOPE_400);

  const execution = await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({
      exitStatus: 1,
      threadId: "th-x",
      turnId: "tn-x",
      payload: { status: 1, rawOutput: "", touchedFiles: [], reasoningSummary: [] },
      rendered: "boom\n",
      errorMessage: reason,
      summary: reason
    }),
    {}
  );

  assert.equal(execution.exitStatus, 1);
  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.errorMessage, reason, "a failed RETURN must persist errorMessage onto the job record");
});

test("runTrackedJob falls back to summary when a failed execution carries no explicit errorMessage", async () => {
  const workspace = makeTempDir();
  const jobId = "job-returned-failed-summaryonly";

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({
      exitStatus: 1,
      payload: { status: 1, rawOutput: "" },
      rendered: "boom\n",
      summary: "something went wrong"
    }),
    {}
  );

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.errorMessage, "something went wrong");
});

test("runTrackedJob does NOT set errorMessage on a completed job", async () => {
  const workspace = makeTempDir();
  const jobId = "job-returned-ok";

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({
      exitStatus: 0,
      payload: { status: 0, rawOutput: "the answer" },
      rendered: "the answer\n",
      summary: "the answer"
    }),
    {}
  );

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "completed");
  assert.equal(record.errorMessage ?? null, null, "a completed job must not carry an errorMessage");
});

test("e2e: foreground `task --json` surfaces the failure reason on a terminal turn error", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "a terminal turn error must exit non-zero");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);
  // The whole point: the foreground --json payload (not only the persisted record)
  // must carry the unwrapped reason, not { status:1, rawOutput:"" }.
  assert.match(
    payload.errorMessage ?? "",
    /newer version of Codex/,
    "foreground task --json must surface the failure reason"
  );
});

test("e2e: foreground `review --json` surfaces the failure reason (native review branch)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(
    payload.errorMessage ?? "",
    /newer version of Codex/,
    "native review --json must surface the failure reason, not a success-sounding summary"
  );
});

test("e2e: foreground `adversarial-review --json` surfaces the failure reason", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.errorMessage ?? "", /newer version of Codex/);
});

// Second failure shape (Codex second-pass finding): the turn fails via a terminal
// turn/completed carrying turn.error, with NO preceding standalone `error`
// notification, so state.error stays null. failureReasonFor must still surface the
// real reason from result.turn.error rather than the generic fallback.
test("e2e: `task --json` surfaces turn.error from a failed turn/completed (no error notification)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-completed-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(
    payload.errorMessage ?? "",
    /401 Unauthorized/,
    "the failure reason from turn.error must not be lost to the generic fallback"
  );
});

test("e2e: `review --json` surfaces turn.error from a failed turn/completed (no error notification)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-completed-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.errorMessage ?? "", /401 Unauthorized/);
});
