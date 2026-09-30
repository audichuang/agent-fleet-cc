import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function turnCount(binDir) {
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  return state.nextTurnId;
}

test("e2e: a gated default model fails once and is not retried on gpt-6-sol", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // buildEnv drops CODEX_*, so the default model resolves to gpt-6.1-sol; the fake
  // rejects that slug. The companion must surface the failure and stop.
  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "a gated default must fail instead of switching models");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.modelFallback ?? null, null);
  assert.match(payload.errorMessage ?? result.stdout, /newer version of Codex/);
  assert.equal(turnCount(binDir), 2, "exactly one turn/start — no retry on a weaker slug");
});

test("e2e: an explicit --model gpt-6-sol still runs when the caller names it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing", "--model", "gpt-6-sol", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput ?? "", /Handled the requested task/);
  assert.equal(payload.modelFallback ?? null, null);
  assert.equal(turnCount(binDir), 2, "an explicit model runs once");
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

test("e2e: native `review --json` does not retry a gated model", () => {
  const repo = repoWithDiff();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.modelFallback ?? null, null);
  assert.match(payload.errorMessage ?? result.stdout, /newer version of Codex/);
  assert.equal(turnCount(binDir), 2, "native review is one turn");
});

test("e2e: `adversarial-review --json` does not retry a gated model", () => {
  const repo = repoWithDiff();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-fallback");

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.modelFallback ?? null, null);
  assert.match(payload.errorMessage ?? result.stdout, /newer version of Codex/);
  assert.equal(turnCount(binDir), 2, "adversarial review is one turn");
});

test("e2e: an explicit --model gpt-6-sol runs EXACTLY once even when that slug is unavailable", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error"); // rejects EVERY model, including the fallback slug
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing", "--model", "gpt-6-sol", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "an unavailable explicit model still fails");
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.nextTurnId, 2, "exactly one turn/start");
});

test("e2e: a gated default surfaces the failure and does not record a model switch", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error"); // default rejected → retry fallback → fallback also rejected
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
  assert.match(payload.errorMessage ?? "", /newer version of Codex/);
  assert.equal(payload.modelFallback ?? null, null);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.nextTurnId, 2, "exactly one turn/start");
});

test("e2e: a model-gate error after a started command is still a single turn", () => {
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
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.nextTurnId, 2, "a started command is not followed by a second turn");
});
