import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpectedTriplet, assertWorktreeAlignment, sanitizeGitEnv, BROKER_ENDPOINT_ENV }
  from "../../plugins/codex/scripts/lib/worktree-guard.mjs";
import { TRIPLET_VECTORS, ALIGN_VECTORS } from "./worktree-guard-vectors.mjs";

test("parseExpectedTriplet honours all-or-none", () => {
  for (const v of TRIPLET_VECTORS) {
    if (v.throws) assert.throws(() => parseExpectedTriplet(v.source), /all-or-none/i, v.name);
    else assert.deepEqual(parseExpectedTriplet(v.source), v.expect, v.name);
  }
});

function fakeGit(table) {
  return (_cwd, args) => {
    const key = args.join(" ");
    const hit = table[key];
    if (!hit) return { status: 1, stdout: "" };
    return { status: hit.status, stdout: hit.stdout };
  };
}

test("assertWorktreeAlignment enforces L2(b)", () => {
  for (const v of ALIGN_VECTORS) {
    const env = {};
    const run = () => assertWorktreeAlignment({ cwd: v.cwd, expected: v.expected, env, runGit: fakeGit(v.git) });
    if (v.pass) assert.doesNotThrow(run, v.name);
    else assert.throws(run, /WorktreeMismatch|mismatch|not (a git|an ancestor)/i, v.name);
  }
});

test("sanitizeGitEnv strips git-control env", () => {
  const env = { GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_COMMON_DIR: "/z", KEEP: "1" };
  sanitizeGitEnv(env);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_COMMON_DIR, undefined);
  assert.equal(env.KEEP, "1");
});

test("expected mode drops foreign broker endpoint", () => {
  const env = { [BROKER_ENDPOINT_ENV]: "unix:/foreign/broker.sock" };
  const ok = ALIGN_VECTORS.find((v) => v.pass);
  assertWorktreeAlignment({ cwd: ok.cwd, expected: ok.expected, env, runGit: fakeGit(ok.git) });
  assert.equal(env[BROKER_ENDPOINT_ENV], undefined);
});
