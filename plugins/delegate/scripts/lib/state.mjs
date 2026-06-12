import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
]);

export function resolveDataRoot(env = process.env) {
  if (env.DELEGATE_PLUGIN_DATA) return env.DELEGATE_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), ".claude", "plugins", "data", "delegate");
}

export function workspaceStateDir(dataRoot, cwd) {
  const slug =
    path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32) || "ws";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function jobsDir(stateDir) {
  return path.join(stateDir, "jobs");
}
export function jobFilePath(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.json`);
}
export function promptFilePath(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.prompt.txt`);
}
export function logFilePath(stateDir, jobId) {
  return path.join(jobsDir(stateDir), `${jobId}.log`);
}
function lockFilePath(stateDir, jobId) {
  return jobFilePath(stateDir, jobId) + ".lock";
}

export function newJobId(now = Date.now()) {
  return `dlg-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  // 0600/0700: jobs carry prompts, results, and logs — keep them owner-only.
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJob(stateDir, job) {
  writeJsonAtomic(jobFilePath(stateDir, job.id), {
    ...job,
    updatedAt: new Date().toISOString(),
  });
}

export function readJob(stateDir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFilePath(stateDir, jobId), "utf8"));
  } catch {
    return null;
  }
}

export function listJobs(stateDir) {
  let entries;
  try {
    entries = fs.readdirSync(jobsDir(stateDir));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(jobsDir(stateDir), name), "utf8")));
    } catch {
      // corrupt/in-flight file — skip, never fatal
    }
  }
  return jobs.sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

// Cross-process CAS: O_EXCL lock file, first terminal writer wins. The lock
// content records the intended terminal status so a repair pass (see
// job-control reconcileDeadPids) can finish the transition if the winner dies
// between claiming the lock and writing the job JSON.
function claimTerminalTransition(stateDir, jobId, status) {
  fs.mkdirSync(jobsDir(stateDir), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      lockFilePath(stateDir, jobId),
      JSON.stringify({ pid: process.pid, status, at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// null when no lock; { status } when claimed. Lock content may be a legacy
// bare pid or garbage — JSON.parse("12345") is VALID JSON (a number), so the
// guard must check for an object with a known terminal status.
export function readTerminalLock(stateDir, jobId) {
  let raw;
  try {
    raw = fs.readFileSync(lockFilePath(stateDir, jobId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && TERMINAL_STATUSES.has(parsed.status)) {
      return { status: parsed.status };
    }
  } catch {}
  return { status: null };
}

export function finalizeJob(stateDir, jobId, patch) {
  if (!TERMINAL_STATUSES.has(patch.status)) {
    throw new Error(`finalizeJob requires a terminal status, got ${patch.status}`);
  }
  // Terminal JSON means someone already won the CAS — refuse even if prune
  // removed the lock, so a stale finalizer can never revive a pruned job.
  const existing = readJob(stateDir, jobId);
  if (!existing || TERMINAL_STATUSES.has(existing.status)) return false;
  if (!claimTerminalTransition(stateDir, jobId, patch.status)) return false;
  // Re-read after the claim: if prune deleted the JSON in between, undo our
  // lock and bail. Safe because prune unlinks JSON before lock (see pruneJobs),
  // and while we hold the lock every other finalizer fails with EEXIST.
  const fresh = readJob(stateDir, jobId);
  if (!fresh) {
    try {
      fs.unlinkSync(lockFilePath(stateDir, jobId));
    } catch {}
    return false;
  }
  // fresh-merge keeps fields written after our first read (e.g. the worker's
  // pid stamp) — cancelJob relies on this to find the pid to signal.
  writeJob(stateDir, { ...fresh, ...patch });
  return true;
}

// queued → running transition guarded against a concurrent canceller. Returns
// the running job, or null when the job is gone/terminal/lock-claimed — the
// caller must NOT spawn anything on null. If the lock appears while we write
// (residual race), JSON is transiently "running"; the reconcile repair pass
// converges it from the lock content. hooks.beforeRecheck is a test seam.
export function markJobRunning(stateDir, jobId, patch = {}, hooks = {}) {
  if (readTerminalLock(stateDir, jobId)) return null;
  const job = readJob(stateDir, jobId);
  if (!job || TERMINAL_STATUSES.has(job.status)) return null;
  writeJob(stateDir, { ...job, ...patch, status: "running" });
  hooks.beforeRecheck?.();
  if (readTerminalLock(stateDir, jobId)) return null;
  return readJob(stateDir, jobId);
}

export function pruneJobs(stateDir, { max = 50 } = {}) {
  const jobs = listJobs(stateDir);
  const activeCount = jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const terminal = jobs
    .filter((j) => TERMINAL_STATUSES.has(j.status))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const keep = Math.max(0, max - activeCount);
  for (const job of terminal.slice(keep)) {
    // Unlink order is load-bearing: JSON must go BEFORE the lock. finalizeJob
    // re-reads the JSON after claiming the lock and relies on "lock was
    // prunable ⇒ JSON already gone" to detect and undo a post-prune claim.
    for (const file of [
      jobFilePath(stateDir, job.id),
      lockFilePath(stateDir, job.id),
      promptFilePath(stateDir, job.id),
      logFilePath(stateDir, job.id),
    ]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
}
