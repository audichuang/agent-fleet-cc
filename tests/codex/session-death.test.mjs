import { spawn, execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/codex/scripts/codex-companion.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function brokersFor(repo) {
  try {
    return execFileSync("pgrep", ["-f", `app-server-broker.mjs.*${repo}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

function jobStatuses(repo, env) {
  const snapshot = JSON.parse(run("node", [SCRIPT, "status", "--json"], { cwd: repo, env }).stdout);
  return [...(snapshot.running ?? []), ...(snapshot.latestFinished ? [snapshot.latestFinished] : [])].map((job) => job.status);
}

// 2.0.0 removed the SessionEnd hook that killed a session's foreground job and tore down the
// broker. Measured before removing it: across 52 real jobs it had never ended one. What replaces
// it is pinned here: when the foreground companion dies mid-turn with no hook to clean up, the
// next status read reconciles the job to failed, and the broker (with the app-server and the
// orphaned turn under it) shuts itself down once its last client is gone. Also checked once
// against real Codex: failed within ~1 s, broker and app-server gone within ~6 s.
test("a foreground run killed mid-turn is reconciled and its broker exits, with no SessionEnd hook", { skip: process.platform === "win32" }, async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task"); // the turn takes 5 s
  initGitRepo(repo);
  const env = { ...buildEnv(binDir), CLAUDE_CODE_SESSION_ID: "dying-session" };

  const child = spawn("node", [SCRIPT, "task", "a slow thing"], { cwd: repo, env, stdio: "ignore", detached: true });
  // The job record turns running before the broker is up, so wait for both.
  let running = [];
  let live = [];
  for (let i = 0; i < 50 && !(running.includes("running") && live.length === 1); i++) {
    await sleep(100);
    running = jobStatuses(repo, env);
    live = brokersFor(repo);
  }
  assert.deepEqual(running, ["running"], "the turn must be in flight before the session dies");
  assert.equal(live.length, 1, "the run must have started its broker");

  process.kill(-child.pid, "SIGKILL"); // the session dies; nothing runs on its behalf
  await sleep(300);
  assert.deepEqual(jobStatuses(repo, env), ["failed"], "the next read reconciles the dead worker");

  let brokers = brokersFor(repo);
  for (let i = 0; i < 100 && brokers.length > 0; i++) {
    await sleep(100);
    brokers = brokersFor(repo);
  }
  assert.equal(brokers.length, 0, "the broker idles out once its last client is gone");
});
