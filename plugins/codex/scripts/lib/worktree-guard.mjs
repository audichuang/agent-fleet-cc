import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";

export class WorktreeMismatchError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "WorktreeMismatchError";
    this.detail = detail;
  }
}

const FIELDS = [
  ["worktreePath", "expected-worktree"],
  ["worktreeBranch", "expected-branch"],
  ["worktreeBase", "expected-base"]
];

// all-or-none. null when none present; throw when partial.
export function parseExpectedTriplet(source = {}) {
  const picked = {};
  let present = 0;
  for (const [camel, flag] of FIELDS) {
    const value = source[flag] ?? source[camel];
    if (value != null && value !== "") {
      picked[camel] = String(value);
      present += 1;
    }
  }
  if (present === 0) return null;
  if (present !== FIELDS.length) {
    throw new WorktreeMismatchError(
      "expected-worktree contract is all-or-none: provide worktreePath, worktreeBranch, and worktreeBase together.",
      { picked }
    );
  }
  return picked;
}

// Return a COPY of env with the git-control vars removed. Pure — never mutates the
// input. assertWorktreeAlignment defaults env to process.env, so an in-place delete here
// used to silently strip GIT_* from the whole companion process; the sanitized copy is
// only ever handed to the git probes that must not inherit a foreign GIT_DIR.
export function sanitizeGitEnv(env) {
  const { GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, ...rest } = env;
  return rest;
}

function realpathOr(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value; // path may not exist (tests, fresh worktree) — fall back to literal compare
  }
}

function defaultRunGit(cwd, args, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

// Hard L2(b) check. Does NOT trust resolveWorkspaceRoot fallback. No-op when expected is null.
export function assertWorktreeAlignment({ cwd, expected, env = process.env, runGit = defaultRunGit }) {
  if (!expected) return;
  // expected mode: DELIBERATELY isolate this process's git env from a foreign GIT_*. A
  // stale GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR would re-point not just our probes below
  // but every OTHER git call in this process (workspace/state/resume resolution reads
  // process.env) at the wrong repo. This intentional global delete — like the
  // broker-endpoint drop below — is what protects those callers; sanitizeGitEnv alone
  // only cleans the probe copy. (Pre-guard resolution is unaffected, same as before.)
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  // Probes additionally run with a sanitized COPY so they are clean even if `env` is not
  // process.env (e.g. tests inject their own).
  const gitEnv = sanitizeGitEnv(env);

  const top = runGit(cwd, ["rev-parse", "--show-toplevel"], gitEnv);
  if (top.status !== 0) {
    throw new WorktreeMismatchError(`cwd is not inside a git repository (no fallback): ${cwd}`, { cwd });
  }
  const actualTop = realpathOr(top.stdout.trim());
  const wantTop = realpathOr(expected.worktreePath);
  if (actualTop !== wantTop) {
    throw new WorktreeMismatchError(`worktree mismatch: toplevel ${actualTop} != expected ${wantTop}`, { actualTop, wantTop });
  }

  const branch = runGit(cwd, ["branch", "--show-current"], gitEnv).stdout.trim();
  if (branch !== expected.worktreeBranch) {
    throw new WorktreeMismatchError(`branch mismatch: ${branch || "(detached)"} != ${expected.worktreeBranch}`, { branch });
  }

  const anc = runGit(cwd, ["merge-base", "--is-ancestor", expected.worktreeBase, "HEAD"], gitEnv);
  if (anc.status !== 0) {
    throw new WorktreeMismatchError(`baseline ${expected.worktreeBase} is not an ancestor of HEAD (reset/rebase?).`, { base: expected.worktreeBase });
  }

  // expected mode: never let a stale/foreign broker endpoint override the cwd-derived
  // broker. This DELIBERATELY mutates the caller's env (process.env in production), which
  // is the surface broker resolution reads — that isolation is the whole point.
  delete env[BROKER_ENDPOINT_ENV];
}
