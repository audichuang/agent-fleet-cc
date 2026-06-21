import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
