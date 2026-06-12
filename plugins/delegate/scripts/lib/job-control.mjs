import {
  listJobs,
  readJob,
  writeJob,
  finalizeJob,
  readTerminalLock,
  TERMINAL_STATUSES,
} from "./state.mjs";

// Only ever signal a real, single-process pid. process.kill() happily accepts
// 0 / negative / numeric-string pids and would signal whole process groups
// (kill(-1) = every process we may signal) — a polluted job JSON must never
// be able to do that.
export function safePid(pid) {
  const n = typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : pid;
  return Number.isInteger(n) && n > 1 ? n : null;
}

export function isPidAlive(pid) {
  const n = safePid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function reconcileDeadPids(stateDir, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const reconciled = [];
  for (const job of listJobs(stateDir)) {
    if (TERMINAL_STATUSES.has(job.status)) continue;
    const pid = safePid(job.pid);
    const lock = readTerminalLock(stateDir, job.id);
    if (lock) {
      // A terminal transition was claimed but the JSON never caught up (the
      // finalizer died, or a worker's running-write overlapped the claim).
      // Finish it for the winner: direct writeJob is correct here — the lock
      // already exists, so the CAS was won long ago; this is idempotent.
      if (pid && isAlive(pid)) continue; // live worker will settle on its own
      writeJob(stateDir, {
        ...job,
        status: lock.status ?? "failed",
        error: job.error ?? "finalizer died mid-transition (repaired from lock)",
      });
      reconciled.push(job.id);
      continue;
    }
    if (job.status !== "running" || !pid) continue;
    if (isAlive(pid)) continue;
    if (
      finalizeJob(stateDir, job.id, {
        status: "failed",
        error: "worker process died (reconciled dead pid)",
      })
    ) {
      reconciled.push(job.id);
    }
  }
  return reconciled;
}

// Order matters (lesson from codex-plugin-cc): consult the per-job file and
// claim the terminal transition FIRST; only the CAS winner may signal the pid.
// A loser must not signal — the pid may already be reused.
export function cancelJob(stateDir, jobId, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const killImpl = deps.killImpl ?? ((pid, sig) => process.kill(pid, sig));
  const job = readJob(stateDir, jobId);
  if (!job) return { ok: false, message: `No job ${jobId} in this workspace.` };
  if (TERMINAL_STATUSES.has(job.status)) {
    return { ok: false, message: `Job ${jobId} already ${job.status}.` };
  }
  deps.beforeFinalize?.(); // test seam: inject a worker interleaving here
  if (!finalizeJob(stateDir, jobId, { status: "cancelled" })) {
    const latest = readJob(stateDir, jobId);
    return {
      ok: false,
      message: `Job ${jobId} already ${latest?.status ?? "finalized"}.`,
    };
  }
  // Re-read the pid after winning the CAS: a queued job may have just turned
  // running, and finalizeJob's fresh-merge preserved the worker's pid stamp.
  // The post-finalize JSON wins — the first snapshot's pid may be stale.
  const pidToKill = safePid(readJob(stateDir, jobId)?.pid ?? job.pid);
  if (pidToKill && isAlive(pidToKill)) {
    try {
      killImpl(pidToKill, "SIGTERM");
    } catch {}
  }
  return { ok: true, message: `Cancelled ${jobId}.` };
}
