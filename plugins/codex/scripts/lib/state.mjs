import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { listJobs as sharedListJobs } from "./shared/core/state-store.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function nowIso() {
  return new Date().toISOString();
}

// Write a file atomically: write to a unique temp file in the same directory,
// then rename it into place (rename is atomic on POSIX/NTFS within a dir). This
// guarantees a concurrent reader never observes a half-written state.json /
// per-job record / .done signal. It does NOT serialize concurrent writers — two
// processes can still last-write-wins the whole-file index; see saveState.
let atomicWriteCounter = 0;
function atomicWriteFileSync(filePath, data) {
  atomicWriteCounter += 1;
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${atomicWriteCounter}.tmp`
  );
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: the rename failed, so the temp is the only orphan.
    }
    throw error;
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

// Directory-per-job layout (Phase 1A / 1a): every job owns a directory
// jobs/<id>/ holding job.json, log, done.json, terminal.lock, write.lock — the
// shared directory-per-job store's shape (shared/lib/core/state-store.mjs). The
// path helpers below resolve into this dir and ensure it exists (mirroring the
// pre-migration helpers that ensured jobs/).
function jobDirPath(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), jobId);
}

function ensureJobDir(cwd, jobId) {
  const dir = jobDirPath(cwd, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  // NEVER prune an active (queued/running) job: saveState deletes the per-job
  // files of any job dropped from the index, and the watchdog reads those files
  // to keep a hung/live background job alive. Evicting an active job by a stale
  // updatedAt would destroy the last liveness backstop. Keep all active jobs
  // (even beyond MAX_JOBS) and fill the remaining budget with the newest
  // terminal jobs.
  const isActive = (job) => job.status === "queued" || job.status === "running";
  const active = sorted.filter(isActive);
  const terminal = sorted.filter((job) => !isActive(job));
  const terminalBudget = Math.max(0, MAX_JOBS - active.length);
  return [...active, ...terminal.slice(0, terminalBudget)];
}

export function saveState(cwd, state, { removedJobs = [] } = {}) {
  ensureStateDir(cwd);
  const callerJobs = state.jobs ?? [];
  const nextJobs = pruneJobs(callerJobs);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  // Only delete artifacts for jobs the CALLER actually knew about and dropped:
  // jobs it explicitly removed (`removedJobs`, threaded from updateState) plus
  // jobs pruned out of its own snapshot by pruneJobs (terminal eviction past
  // MAX_JOBS; pruneJobs never drops an active job). We must NOT delete based on a
  // fresh disk read of the index: a job another process enqueued after the caller
  // loaded would appear there, be absent from this snapshot, and lose its per-job
  // file — the watchdog's source of truth (B1 cross-process delete race).
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  const deletedIds = new Set();
  for (const job of [...removedJobs, ...callerJobs]) {
    if (!job || retainedIds.has(job.id) || deletedIds.has(job.id)) {
      continue;
    }
    deletedIds.add(job.id);
    // Directory-per-job deletion. Preserve the shared store's load-bearing unlink
    // ORDER (job.json before terminal.lock): a concurrent finalize claims the lock
    // then re-reads job.json to detect a prune, so job.json MUST disappear first or
    // a stale finalizer could resurrect a pruned job (see shared pruneJobs). Use
    // pure jobDirPath joins (NOT the resolve* helpers, which mkdir) so we never
    // recreate the dir we are deleting; rmSync sweeps any leftovers (prompt.txt,
    // events.ndjson) and the now-empty dir.
    const dir = jobDirPath(cwd, job.id);
    for (const name of ["job.json", "log", "done.json", "terminal.lock", "write.lock"]) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // already gone — best effort
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Atomic write so a concurrent reader never sees a torn index. NOTE: this does
  // not prevent a cross-process lost update — two processes that each loadState,
  // mutate a different job, then write will clobber each other's whole-array
  // snapshot. The per-job files remain the source of truth; the index is a cache
  // rebuilt on every write. Eliminating the lost update would need a
  // workspace-level lock (deliberately out of scope here).
  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  // Snapshot the job ids BEFORE the mutation so saveState can clean up exactly the
  // jobs this caller removed (and only those) — see the B1 note in saveState.
  // Copy the array so an in-place mutation (splice/reassign) does not corrupt it.
  const beforeJobs = [...(state.jobs ?? [])];
  mutate(state);
  const afterIds = new Set((state.jobs ?? []).map((job) => job.id));
  const removedJobs = beforeJobs.filter((job) => !afterIds.has(job.id));
  return saveState(cwd, state, { removedJobs });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

function normalizeTrackedPid(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  return Math.trunc(pid);
}

function defaultActivePredicate(stored) {
  return stored?.status === "queued" || stored?.status === "running";
}

// A terminal claim is held only for the microseconds between the O_EXCL CAS and the
// terminal-record write — a live finalize never straddles this. So a claim still
// present on a STILL-ACTIVE job after this long is a crashed claimer, whatever the pid
// liveness says. Generous (clearly beyond any GC/IO stall) yet small enough that a
// wedged job self-heals within a minute.
const TERMINAL_LOCK_TTL_MS = 60_000;

// Age of a terminal claim: prefer its recorded stamp; fall back to the lock file's
// mtime when the payload is empty/malformed (a claimer that crashed mid-write left no
// stamp). Returns NaN if the lock vanished mid-check (let the EEXIST retry resolve it).
function terminalLockAgeMs(lockFile, payload) {
  const stampMs = payload?.stamp ? Date.parse(payload.stamp) : NaN;
  if (Number.isFinite(stampMs)) {
    return Date.now() - stampMs;
  }
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

// True only when an existing .lock is stale and may be reclaimed. A finalized job
// legitimately keeps its lock, so we never reclaim once the per-job record is terminal
// (the active gate below). Three crash shapes reach the reclaim path:
//   - owner pid recoverable AND dead → reclaim immediately (the original behaviour).
//   - owner pid alive but the claim is older than the TTL → a RECYCLED pid (the real
//     claimer died; pid reuse takes minutes, so a >60s-old claim is never the holder).
//   - lock empty/unparseable AND older than the TTL → claimer crashed between
//     openSync('wx') and writeSync. (A FRESH empty lock is a live holder mid-acquire —
//     refuse it.)
// Without the TTL, the last two wedged an active job forever (C3).
//
// ponytail: TTL, not process start-time identity. Start-time would detect a recycled
// pid faster, but pid reuse is slow enough that the TTL already catches it cleanly, and
// start-time is Linux-only (/proc) — extra platform code for no real gain. The residual
// (a LIVE holder frozen >60s mid-finalize getting reclaimed → double-write) is the same
// irreducible fail-open the per-job write mutex already tolerates; the real fix is the
// directory-per-job state-store migration (roadmap), not a smarter lock.
function isStaleTerminalClaim(cwd, jobId, lockFile) {
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    payload = null; // empty/malformed: claimer crashed between open and write
  }
  const ownerPid = payload ? normalizeTrackedPid(payload.pid) : null;

  if (ownerPid !== null && isProcessAlive(ownerPid)) {
    // Live pid — normally the holder. Only an expired claim means a recycled pid.
    if (terminalLockAgeMs(lockFile, payload) <= TERMINAL_LOCK_TTL_MS) {
      return false;
    }
  } else if (ownerPid === null) {
    // No recoverable pid — a live holder mid-acquire unless it has gone stale.
    if (terminalLockAgeMs(lockFile, payload) <= TERMINAL_LOCK_TTL_MS) {
      return false;
    }
  }
  // else: owner pid recoverable AND dead → reclaim now (no TTL wait).

  let stored;
  try {
    stored = readJobFile(resolveJobFile(cwd, jobId));
  } catch {
    return false;
  }
  return defaultActivePredicate(stored);
}

// Cross-process CAS for a job's terminal transition. The first process to
// atomically create the per-job .lock (O_CREAT | O_EXCL) wins and may write the
// terminal record; a racing writer in another process gets EEXIST and backs off.
// In the normal path the whole read-check-claim-write runs under withJobWriteLock,
// so two LIVE finalizers cannot both win. The lock records the owner pid + stamp so
// a claim left behind by a crashed owner (dead pid, OR a recycled/empty lock past the
// TTL — see isStaleTerminalClaim) can be reclaimed instead of wedging the job forever.
// Returns true if this process won the claim. Exported so the recreate fallbacks
// (per-job file pruned mid-run) go through the same CAS instead of writing terminal
// records unguarded.
//
// ponytail: the stale-lock reclaim below uses a bare unlink, so two simultaneous
// reclaimers OUTSIDE the write lock could in theory both delete-and-recreate and both
// "win" (double finalize). That window is the same irreducible fail-open the per-job
// write mutex tolerates (the normal path is serialized by it); closing it fully needs
// the directory-per-job state-store migration (roadmap), not a bigger file lock.
export function claimTerminalTransition(cwd, jobId, status, stamp) {
  const lockFile = resolveJobLockFile(cwd, jobId);
  const payload = `${JSON.stringify({ status, stamp, pid: process.pid })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (attempt === 0 && isStaleTerminalClaim(cwd, jobId, lockFile)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Lost the unlink race to another reclaimer; fall through to retry/EEXIST.
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

// Synchronous sleep without busy-spinning the CPU. Used only on per-job write-lock
// contention, where a holder keeps the lock for a single read-check-write
// (microseconds), so the wait is near-zero in practice.
function sleepMsSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer/Atomics unavailable — fall back to a bounded busy wait.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

// Recoverable owner pid of a write lock, or null when the file is empty,
// unparseable, or carries no pid. A holder acquires by openSync("wx") THEN writes
// its payload, so a racer can briefly observe an EMPTY lock mid-acquire — that is a
// LIVE holder, not a dead one. Returning null (and never reclaiming a null owner)
// keeps us from stealing such a lock, mirroring isStaleTerminalClaim's conservative
// "refuse the steal when the owner is unrecoverable" choice.
function readWriteLockOwnerPid(lockFile) {
  try {
    return normalizeTrackedPid(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid);
  } catch {
    return null;
  }
}

// Bounded fail-open ceiling for write-lock acquisition. A holder keeps the lock for
// one read-check-write, so contention clears in microseconds; this only bounds the
// pathological case (a leaked lock) so a job is never wedged behind a write lock.
const WRITE_LOCK_BUDGET_MS = 1000;

// Cross-process per-job write mutex. Holds an O_EXCL <id>.wlock for the duration of
// `fn` (a single per-job-file read-check-write). Since Option A (progress -> events),
// progress no longer touches job.json, so B3 is already structurally gone; this lock
// now only serializes the remaining applyJobPatchIfActive writers (queued->running
// promotion and terminal transitions). It is removed in 1c-ii-b once terminals route
// through the shared finalizeJob O_EXCL terminal.lock.
//
// A lock left by a crashed holder (parseable, dead owner pid) is reclaimed AT MOST
// ONCE per call by moving it aside with an atomic rename — never a bare unlink: only
// one racing reclaimer wins the rename (the rest get ENOENT), so a fresh lock a
// winner just created is never displaced. An empty/unparseable lock is treated as a
// live holder mid-acquire and is NOT reclaimed. The acquire is FAIL-OPEN: if the
// budget elapses we proceed without the lock (last-writer-wins, the pre-mutex
// behavior) rather than drop the write or wedge the job.
//
// ponytail: a pure-fs file mutex cannot be made fully race-free without OS advisory
// locks — a second reclaimer can still displace a fresh lock inside the one-syscall
// gap between its re-confirm and its rename. That residual degrades to the same
// fail-open last-writer-wins this function already tolerates; eliminating it needs
// the directory-per-job state-store migration (roadmap), not a bigger file lock.
function withJobWriteLock(cwd, jobId, fn) {
  const lockFile = resolveJobWriteLockFile(cwd, jobId);
  const payload = `${JSON.stringify({ pid: process.pid })}\n`;
  const deadline = Date.now() + WRITE_LOCK_BUDGET_MS;
  let held = false;
  let reclaimAttempted = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      held = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const ownerPid = readWriteLockOwnerPid(lockFile);
      if (!reclaimAttempted && ownerPid !== null && !isProcessAlive(ownerPid)) {
        reclaimAttempted = true;
        const aside = `${lockFile}.${process.pid}.stale`;
        try {
          // Re-confirm the SAME dead owner immediately before moving it, so a lock
          // already replaced by a live holder (different owner) is left untouched.
          if (readWriteLockOwnerPid(lockFile) === ownerPid) {
            fs.renameSync(lockFile, aside);
            try {
              fs.unlinkSync(aside);
            } catch {
              // Best effort: the stale artifact is harmless if it lingers.
            }
          }
        } catch {
          // Lost the reclaim race (already moved/replaced) — just retry.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        break; // fail-open: never wedge a job behind a write lock.
      }
      sleepMsSync(5);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Best effort: a reclaimer may have already moved it.
      }
    }
  }
}

/**
 * Atomically transitions a job record. Reads the per-job JSON, verifies the
 * job is still in an active status (queued/running), optionally runs an
 * `extraGuard` for stricter checks (e.g. PID identity), and only if ALL
 * gates pass writes the patch to both the per-job file and the state.json
 * index. Because all fs operations here are synchronous the whole
 * read-check-write sequence cannot interleave with another async writer in
 * the same process, so timeout catch, dead-PID reconcile, and progress
 * updates cannot clobber each other's metadata within one Node process.
 *
 * Across PROCESSES the active-state gate alone is not enough (two processes can
 * both read the job as active before either writes), so a TERMINAL transition
 * additionally wins a per-job O_EXCL claim file: the first process to create it
 * may write the terminal record; a racing process gets EEXIST and returns
 * `applied:false`. This makes "first terminal writer wins" hold across the
 * worker, watchdog, cancel handler, and dead-PID reconcile.
 *
 * The active-state gate ALWAYS runs — callers cannot bypass it. `extraGuard`
 * is an additional check on top of it. This prevents a future caller from
 * accidentally widening the helper past terminal-state protection.
 *
 * `patchOrBuilder` may be a plain object or a function receiving the stored
 * job that returns the patch. Return `null`/`undefined`/`false` from the
 * builder to skip the write (useful when the stored state already matches).
 *
 * `indexPatchOrBuilder` (optional) lets a caller write a LIGHTER patch to the
 * `state.json` index than to the per-job file. This keeps the index small
 * (e.g. the success path stores `result`/`rendered` in the per-job file but
 * not in the index). When omitted, the same patch goes to both (back-compat).
 *
 * Returns `{ applied, stored, patch }`. `stored` is the persisted record
 * that was read (useful for reading log paths or prior metadata without
 * reopening the file). `patch` is what was actually written to the per-job
 * file, including the `updatedAt` timestamp the helper stamps.
 */
export function applyJobPatchIfActive(cwd, jobId, patchOrBuilder, extraGuard = null, indexPatchOrBuilder = null) {
  // Serialize the whole read-check-(claim)-write under the per-job write mutex so a
  // progress write and a terminal transition (both flow through here) cannot
  // interleave: without it a progress write that read the record as active could
  // re-persist {...stored, ...patch} AFTER another process finalized the job,
  // resurrecting a stale active status over the terminal record (B3).
  const result = withJobWriteLock(cwd, jobId, () => {
    const jobFile = resolveJobFile(cwd, jobId);
    let stored;
    try {
      stored = readJobFile(jobFile);
    } catch {
      return { applied: false, stored: null, patch: null };
    }

    if (!defaultActivePredicate(stored)) {
      return { applied: false, stored, patch: null };
    }
    if (extraGuard && !extraGuard(stored)) {
      return { applied: false, stored, patch: null };
    }

    const rawPatch =
      typeof patchOrBuilder === "function" ? patchOrBuilder(stored) : patchOrBuilder;
    if (!rawPatch) {
      return { applied: false, stored, patch: null };
    }

    const updatedAt = nowIso();
    const patch = { ...rawPatch, updatedAt };
    const isTerminalTransition = Boolean(patch.status && TERMINAL_STATUSES.has(patch.status));

    // For a terminal transition, additionally win the cross-process O_EXCL terminal
    // claim so a worker, watchdog, cancel, and dead-PID reconcile cannot all
    // finalize the same job (first-terminal-writer-wins). The write mutex above
    // already serializes the file write itself.
    if (isTerminalTransition && !claimTerminalTransition(cwd, jobId, patch.status, updatedAt)) {
      return { applied: false, stored, patch: null };
    }

    try {
      writeJobFile(cwd, jobId, { ...stored, ...patch });

      if (indexPatchOrBuilder == null) {
        upsertJob(cwd, { id: jobId, ...patch });
      } else {
        const indexRaw =
          typeof indexPatchOrBuilder === "function" ? indexPatchOrBuilder(stored) : indexPatchOrBuilder;
        upsertJob(cwd, { id: jobId, ...indexRaw, updatedAt });
      }
    } catch (error) {
      if (isTerminalTransition) {
        // We won the claim but failed to persist; release it so a later attempt
        // can still finalize the job instead of wedging behind a stale lock.
        try {
          fs.unlinkSync(resolveJobLockFile(cwd, jobId));
        } catch {
          // Best effort.
        }
      }
      throw error;
    }

    return { applied: true, stored, patch };
  });

  // C5: if we lost the active-state gate because the job is ALREADY terminal, a prior
  // finalize may have torn (terminal record written but its .done signal lost to a crash
  // or fs error). Write the missing signal from the record so a `until [ -f .done ]`
  // waiter is never stranded. Done OUTSIDE the write lock and gated on a missing signal,
  // so the common already-terminal case is just one stat.
  if (!result.applied && result.stored && TERMINAL_STATUSES.has(result.stored.status)) {
    ensureTerminalSignal(cwd, jobId, result.stored);
  }
  return result;
}

function reconcileDeadPidJobs(cwd, jobs) {
  const deadCandidates = [];
  for (const job of jobs) {
    // Reconcile any active state with a tracked PID. Background launches
    // persist `queued` records carrying the detached worker's child.pid
    // before `runTrackedJob` promotes them to `running`; if the worker
    // dies in that window, a `queued`-only check would leave the job
    // stuck forever and permanently block all future /codex:rescue runs
    // because the active-job guard in codex-companion.mjs treats queued
    // as active.
    if (job?.status !== "running" && job?.status !== "queued") continue;
    const pid = normalizeTrackedPid(job.pid);
    if (pid === null) continue;
    if (isProcessAlive(pid)) continue;
    deadCandidates.push({ id: job.id, pid });
  }

  if (deadCandidates.length === 0) {
    return jobs;
  }

  const completedAt = nowIso();
  const applied = new Map();

  for (const { id, pid } of deadCandidates) {
    const result = applyJobPatchIfActive(
      cwd,
      id,
      () => ({
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage: `Worker process PID ${pid} exited without reporting a terminal status; auto-reconciled as failed.`,
        completedAt,
        autoReconciled: true,
        reconciledDeadPid: pid
      }),
      // Active-state check runs first inside the helper; this extra guard
      // enforces PID identity. If the persisted PID no longer matches the
      // one we observed as dead (job re-spawned with a new PID, or OS
      // recycled the PID to an unrelated process), reconcile skips.
      (stored) => normalizeTrackedPid(stored.pid) === pid
    );

    if (!result.applied) continue;

    applied.set(id, result.patch);

    // Emit the terminal signal so a monitor waiting on <jobId>.done wakes, and
    // so the watchdog (which sees this job as already terminal) does not exit
    // leaving the signal unwritten.
    writeCompletionSignalFile(cwd, id, {
      status: "failed",
      reason: `Worker process PID ${pid} exited without reporting a terminal status; auto-reconciled as failed.`
    });

    // Human-visible marker in the job log so the next /codex:status renders
    // something explanatory in the progress preview instead of going silent.
    const logTarget = result.stored?.logFile ?? null;
    if (logTarget) {
      try {
        fs.appendFileSync(
          logTarget,
          `[${completedAt}] Auto-reconciled: worker process PID ${pid} exited without reporting a terminal status. Job marked failed.\n`,
          "utf8"
        );
      } catch {
        // Best effort; never let logging failures crash status reads.
      }
    }
  }

  if (applied.size === 0) {
    return jobs;
  }

  return jobs.map((job) => {
    const patch = applied.get(job.id);
    return patch ? { ...job, ...patch } : job;
  });
}

export function listJobs(cwd) {
  // Directory-per-job is the source of truth: scan jobs/<id>/job.json (shared
  // listJobs skips empty dirs / unreadable records) instead of the legacy
  // state.json index. Shared listJobs sorts by createdAt; codex consumers expect
  // newest-by-updatedAt (sortJobsNewestFirst semantics), so re-sort here (must-fix).
  const jobs = sharedListJobs(resolveStateDir(cwd)).sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  );
  return reconcileDeadPidJobs(cwd, jobs);
}

// True when the workspace has at least one still-active background job. Used to
// keep the shared per-workspace broker alive at SessionEnd: a background job that
// outlives its session must not have the broker (its app-server) reaped out from
// under it.
export function hasActiveBackgroundJobs(cwd) {
  return listJobs(cwd).some(
    (job) => job.background === true && (job.status === "queued" || job.status === "running")
  );
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), "log");
}

export function resolveJobFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), "job.json");
}

// Resolve a per-job file from an ALREADY-KNOWN physical state dir, without
// re-deriving it from a workspace path. Used when a job was located across
// workspaces (its physical dir may not match the slug-hash a re-derivation
// from job.workspaceRoot under the current CLAUDE_PLUGIN_DATA would produce).
export function resolveJobFileInStateDir(stateDir, jobId) {
  return path.join(stateDir, JOBS_DIR_NAME, jobId, "job.json");
}

// All plausible state-root directories whose per-workspace subdirs may hold jobs:
// the active CLAUDE_PLUGIN_DATA/state, the $TMPDIR fallback, and every
// ~/.claude/plugins/data/codex-*/state. Only existing roots are returned. Used to
// locate a job id given in one workspace from a command run in another.
export function collectCandidateStateRoots(cwd, options = {}) {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const roots = new Set();

  const pluginDataDir = env[PLUGIN_DATA_ENV];
  if (pluginDataDir) {
    roots.add(path.join(pluginDataDir, "state"));
  }
  roots.add(FALLBACK_STATE_ROOT_DIR);

  if (homedir) {
    const pluginsData = path.join(homedir, ".claude", "plugins", "data");
    try {
      for (const entry of fs.readdirSync(pluginsData, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith("codex")) {
          roots.add(path.join(pluginsData, entry.name, "state"));
        }
      }
    } catch {
      // ~/.claude/plugins/data may not exist — fine.
    }
  }

  return [...roots].filter((root) => {
    try {
      return fs.existsSync(root);
    } catch {
      return false;
    }
  });
}

// Locate a job by its EXACT id across all candidate workspace state dirs. Used
// ONLY as a fallback when an explicit job id is not found in the current
// workspace; the default (no id) selection stays workspace/session-scoped to
// avoid cross-workspace mis-selection.
export function findJobByIdAcrossWorkspaces(cwd, jobId, options = {}) {
  if (!jobId) {
    return null;
  }
  for (const stateRoot of collectCandidateStateRoots(cwd, options)) {
    let workspaceDirs;
    try {
      workspaceDirs = fs.readdirSync(stateRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of workspaceDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspaceStateDir = path.join(stateRoot, entry.name);
      const jobFile = path.join(workspaceStateDir, JOBS_DIR_NAME, jobId, "job.json");
      let job = null;
      try {
        job = readJobFile(jobFile); // throws ENOENT when absent, or on malformed JSON
      } catch {
        continue;
      }
      if (job && job.id === jobId) {
        return { job, workspaceStateDir };
      }
    }
  }
  return null;
}

export function resolveJobDoneFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), "done.json");
}

// One-shot terminal-claim marker for a job (see claimTerminalTransition). Its
// atomic O_EXCL creation is the cross-process "first terminal writer wins" gate.
export function resolveJobLockFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), "terminal.lock");
}

// Short-lived per-job write mutex (see withJobWriteLock). Distinct from the one-shot
// terminal .lock: held only for the duration of a single read-check-write in
// applyJobPatchIfActive, now by the promotion + terminal writers (progress moved to
// events.ndjson under Option A). Removed in 1c-ii-b when terminals route through
// finalizeJob's terminal.lock.
export function resolveJobWriteLockFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), "write.lock");
}

/**
 * Writes a terminal "done" signal file for a job. A monitor (the Claude-side
 * `until [ -f signalFile ]` loop, or the detached watchdog) tails this file to
 * learn that a background job has reached a terminal state, so a completed or
 * failed job surfaces instead of leaving the caller waiting forever. The
 * payload mirrors the job record's terminal status plus a human-readable
 * reason for failures.
 */
export function writeCompletionSignalFile(cwd, jobId, signal = {}) {
  const doneFile = resolveJobDoneFile(cwd, jobId);
  const payload = {
    status: signal.status ?? "completed",
    reason: signal.reason ?? null,
    signaledAt: nowIso()
  };
  atomicWriteFileSync(doneFile, `${JSON.stringify(payload, null, 2)}\n`);
  return doneFile;
}

/**
 * Writes a job's <jobId>.done signal from its authoritative per-job record when that
 * signal is missing. The per-job record is the source of truth; the .done file is a
 * separate cache that a Claude-side `until [ -f <jobId>.done ]` waiter blocks on. If a
 * finalizer crashed (or an fs write threw) after the terminal record but before its .done,
 * the waiter hangs forever and the watchdog — seeing the job already terminal — exits
 * without writing it (C5). Any actor that observes the already-terminal record (the
 * watchdog stop path, a late finalizer) calls this to heal the stranded signal.
 *
 * SIGNAL-ONLY by design. It deliberately does NOT repair the state.json index: an index
 * write routes through saveState → pruneJobs, which (with a full set of active jobs)
 * would EVICT this terminal job and DELETE its per-job record + .done — destroying the
 * very source of truth we read from. A stale index (terminal record but index still
 * "running") is a separate, rarer, non-hanging symptom (`wait` has a deadline) whose safe
 * fix is the directory-per-job state-store migration (roadmap), not an upsert here.
 *
 * Idempotent: a present .done means the finalize landed, so this no-ops. `record` may be
 * passed to avoid re-reading. Returns true iff it wrote the signal.
 *
 * ponytail: the existsSync→write is not atomic, so a healer can still overwrite a caller's
 * richer .done written in that window — but both carry the same terminal status from the
 * same record, and /codex:result reads the per-job record (not .done) for detail, so the
 * lost nuance (e.g. a non-error completion summary that lives only in the index) is
 * cosmetic. A torn-write recovery with a slightly-less-rich signal beats a hung waiter.
 */
export function ensureTerminalSignal(cwd, jobId, record = null) {
  let stored = record;
  if (!stored) {
    try {
      stored = readJobFile(resolveJobFile(cwd, jobId));
    } catch {
      return false;
    }
  }
  if (!stored || !TERMINAL_STATUSES.has(stored.status)) {
    return false;
  }
  if (fs.existsSync(resolveJobDoneFile(cwd, jobId))) {
    return false;
  }
  writeCompletionSignalFile(cwd, jobId, {
    status: stored.status,
    reason: stored.errorMessage ?? stored.reason ?? null
  });
  return true;
}
