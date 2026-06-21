import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../../plugins/codex/scripts/lib/workspace.mjs";

const COMPANION = path.resolve("plugins/codex/scripts/codex-companion.mjs");

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtguard-"));
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "-b", "feat"]);
  run(["config", "user.email", "t@t"]); run(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "f"), "1");
  run(["add", "."]); run(["commit", "-qm", "base"]);
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, base };
}

function runTask(cwd, extraArgs, env = {}) {
  return spawnSync(process.execPath, [COMPANION, "task", "--cwd", cwd, "--prompt", "noop", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "pd-")), ...env }
  });
}

test("task: mismatched expected-worktree exits non-zero before engine", () => {
  const { dir, base } = makeRepo();
  const r = runTask(dir, ["--expected-worktree", "/definitely/not/here", "--expected-branch", "feat", "--expected-base", base]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /worktree mismatch|WorktreeMismatch/i);
});

test("task: partial triplet is rejected (all-or-none)", () => {
  const { dir } = makeRepo();
  const r = runTask(dir, ["--expected-worktree", dir]); // missing branch+base
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /all-or-none/i);
});

test("task: valid triplet passes the gate and enqueues the job (--background)", () => {
  const { dir, base } = makeRepo();
  // branch is "feat" (from git init -b feat), base is the HEAD commit SHA
  const r = runTask(dir, [
    "--expected-worktree", dir,
    "--expected-branch", "feat",
    "--expected-base", base,
    "--background"
  ]);
  assert.equal(r.status, 0, `expected exit 0 but got ${r.status}; stderr: ${r.stderr}`);
  // renderQueuedTaskLaunch emits "started in the background" and the sentinel
  assert.match(r.stdout, /started in the background|status=dispatched/i);
});

test("task-worker: re-verifies expected from stored request, exits non-zero on mismatch", () => {
  const { dir, base } = makeRepo();
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "pd-worker-"));
  // Override CLAUDE_PLUGIN_DATA for this process so writeJobFile uses the same state dir
  const origPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  let workspaceRoot, jobId;
  try {
    workspaceRoot = resolveWorkspaceRoot(dir);
    jobId = "test-worker-gate-" + Date.now();
    const record = {
      id: jobId,
      status: "queued",
      phase: "queued",
      workspaceRoot,
      title: "test",
      summary: "test",
      request: {
        cwd: dir,
        prompt: "noop",
        // expected points at a non-existent path — this should cause mismatch
        expected: {
          worktreePath: "/nope",
          worktreeBranch: "feat",
          worktreeBase: base
        }
      }
    };
    writeJobFile(workspaceRoot, jobId, record);
  } finally {
    // Always restore so we don't affect other tests even if an exception occurs
    if (origPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = origPluginData;
    }
  }

  const r = spawnSync(process.execPath, [COMPANION, "task-worker", "--cwd", dir, "--job-id", jobId], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData }
  });

  assert.notEqual(r.status, 0, `expected non-zero exit but got ${r.status}; stdout: ${r.stdout}; stderr: ${r.stderr}`);
  assert.match(r.stderr + r.stdout, /worktree mismatch|WorktreeMismatch/i,
    `expected mismatch message but got:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
});

test("review: mismatched expected-worktree exits non-zero before engine", () => {
  const { dir, base } = makeRepo();
  const r = spawnSync(process.execPath,
    [COMPANION, "review", "--cwd", dir, "--scope", "working-tree",
     "--expected-worktree", "/nope", "--expected-branch", "feat", "--expected-base", base],
    { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "pd-")) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /worktree mismatch|WorktreeMismatch/i);
});
