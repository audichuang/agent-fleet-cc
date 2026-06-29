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

test("sanitizeGitEnv returns a git-control-free COPY and does not mutate its input", () => {
  const env = { GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_COMMON_DIR: "/z", KEEP: "1" };
  const cleaned = sanitizeGitEnv(env);
  assert.equal(cleaned.GIT_DIR, undefined);
  assert.equal(cleaned.GIT_WORK_TREE, undefined);
  assert.equal(cleaned.GIT_COMMON_DIR, undefined);
  assert.equal(cleaned.KEEP, "1");
  // D: the input (process.env by default) must NOT be mutated — the old in-place delete
  // silently stripped GIT_* from the whole companion process.
  assert.equal(env.GIT_DIR, "/x", "sanitizeGitEnv must not mutate its input");
  assert.equal(env.GIT_WORK_TREE, "/y");
  assert.equal(env.GIT_COMMON_DIR, "/z");
});

test("assertWorktreeAlignment isolates git env in expected mode: probes AND the process env go GIT_*-free", () => {
  // D: the git probes must run GIT_*-free (a foreign GIT_DIR must not redirect them) AND
  // the deliberate isolation must strip GIT_* from the process env so EVERY other git
  // caller (workspace/state/resume resolution reads process.env) is protected too. The
  // sanitizeGitEnv HELPER is pure (tested above); the global strip here is intentional,
  // paired with the broker-endpoint drop. Non-git keys survive.
  const ok = ALIGN_VECTORS.find((v) => v.pass);
  const env = {
    GIT_DIR: "/foreign/.git",
    GIT_WORK_TREE: "/foreign",
    KEEP: "1",
    [BROKER_ENDPOINT_ENV]: "unix:/foreign/broker.sock"
  };
  const probeEnvs = [];
  const runGit = (cwd, args, probeEnv) => {
    probeEnvs.push(probeEnv);
    const hit = ok.git[args.join(" ")];
    return hit ? { status: hit.status, stdout: hit.stdout } : { status: 1, stdout: "" };
  };

  assertWorktreeAlignment({ cwd: ok.cwd, expected: ok.expected, env, runGit });

  assert.ok(probeEnvs.length > 0, "git probes ran");
  for (const probeEnv of probeEnvs) {
    assert.equal(probeEnv.GIT_DIR, undefined, "git probe env has GIT_DIR stripped");
    assert.equal(probeEnv.GIT_WORK_TREE, undefined, "git probe env has GIT_WORK_TREE stripped");
  }
  // Deliberate global isolation: the process env's GIT_* is gone (protects other git callers).
  assert.equal(env.GIT_DIR, undefined, "GIT_DIR stripped from the process env (protects other git callers)");
  assert.equal(env.GIT_WORK_TREE, undefined, "GIT_WORK_TREE stripped from the process env");
  assert.equal(env.KEEP, "1", "non-git keys survive");
  assert.equal(env[BROKER_ENDPOINT_ENV], undefined, "expected mode also drops the foreign broker endpoint");
});

test("expected mode drops foreign broker endpoint", () => {
  const env = { [BROKER_ENDPOINT_ENV]: "unix:/foreign/broker.sock" };
  const ok = ALIGN_VECTORS.find((v) => v.pass);
  assertWorktreeAlignment({ cwd: ok.cwd, expected: ok.expected, env, runGit: fakeGit(ok.git) });
  assert.equal(env[BROKER_ENDPOINT_ENV], undefined);
});
