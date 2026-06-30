import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import {
  finalizeJob,
  listJobs as sharedListJobs,
  markJobRunning,
  readJob,
  readTerminalLock,
  writeJob,
  sweepOrphanLockDirs,
} from "./shared/core/state-store.mjs";
import { isClaimOrphaned } from "./shared/core/reconcile.mjs";

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
// jobs/<id>/ holding job.json, log, done.json, terminal.lock, events.ndjson — the
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
    for (const name of ["job.json", "log", "done.json", "terminal.lock"]) {
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
  // R4: reap any lock-only zombie dir left by a delete above (or a prior saveState)
  // that crashed between the job.json unlink and the dir rmSync. Targeted deletes
  // never rescan the jobs root, so without this such a dir leaks forever.
  sweepOrphanLockDirs(resolveStateDir(cwd));
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

// R1: the terminal.lock is authoritative over a stale-active job.json. A
// markJobRunning-vs-finalizeJob race can leave job.json "running"/"queued" after a
// finalize already won the terminal.lock — the shared store tolerates that window
// rather than eliminating it (worker.test.mjs:289-294). So any reader deciding
// active-vs-terminal must interpret status through the lock. This overlays the lock's
// terminal status at READ time without rewriting the record; the persistent repair
// (when the finalizer actually died) is the dead-pid reconcile's job below.
function overlayTerminalLock(stateDir, job) {
  if (!job || !defaultActivePredicate(job)) {
    return job;
  }
  const lock = readTerminalLock(stateDir, job.id);
  if (lock && lock.status && TERMINAL_STATUSES.has(lock.status)) {
    return { ...job, status: lock.status };
  }
  return job;
}

/**
 * Atomically transitions a job record, as a thin adapter over the shared
 * directory-per-job store (Phase 1A / 1c-ii-b). Reads the per-job record (shared
 * `readJob`), verifies the job is still active (queued/running), runs an optional
 * `extraGuard` (e.g. PID identity), and routes the write by kind:
 *
 *  - TERMINAL patch (status ∈ completed/failed/cancelled) → shared `finalizeJob`,
 *    whose O_EXCL `terminal.lock` claim makes "first terminal writer wins" hold across
 *    the worker, watchdog, cancel handler, and dead-PID reconcile. A racing finalizer
 *    loses (EEXIST → `false` → `applied:false`).
 *  - NON-terminal patch (the queued→running promotion) → shared `markJobRunning`,
 *    which forces `status:"running"`, refuses if a terminal.lock already won, and never
 *    consumes the terminal claim.
 *
 * Progress no longer flows here (it appends `engine-event`s to events.ndjson under
 * Option A, 1c-ii-a), so B3 (a progress write clobbering a terminal record) is
 * structurally impossible — which is why the bespoke `.wlock` write mutex this adapter
 * replaced is gone.
 *
 * The active-state gate ALWAYS runs — callers cannot bypass it. `extraGuard` is an
 * additional check on top of it. `patchOrBuilder` may be a plain object or a function
 * receiving the stored job; return a falsy patch to skip the write.
 *
 * `indexPatchOrBuilder` (optional) writes a LIGHTER patch to the legacy `state.json`
 * index than the per-job file (the index is dead-for-reads since 1c-i but kept in sync
 * until 1e removes it). When omitted, the persisted record goes to the index.
 *
 * Returns `{ applied, stored, patch }`. `stored` is the record read BEFORE the write
 * (log paths / prior metadata); `patch` is the persisted terminal/running record.
 */
export function applyJobPatchIfActive(cwd, jobId, patchOrBuilder, extraGuard = null, indexPatchOrBuilder = null) {
  const stateDir = resolveStateDir(cwd);
  const stored = readJob(stateDir, jobId);
  if (!stored) {
    return { applied: false, stored: null, patch: null };
  }
  if (!defaultActivePredicate(stored)) {
    // C5: the job is ALREADY terminal — a prior finalize may have torn (terminal record
    // written but its .done signal lost to a crash/fs error). Heal the missing signal so
    // a `until [ -f .done ]` waiter is never stranded. Gated on a missing signal, so the
    // common already-terminal case is just one stat.
    if (TERMINAL_STATUSES.has(stored.status)) {
      ensureTerminalSignal(cwd, jobId, stored);
    }
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

  // The extraGuard runs once on `stored` above (cheap early-out), then AGAIN inside the
  // shared store on the fresh record it actually writes (finalizeJob's post-claim guard /
  // markJobRunning's guard). The second pass is what closes the read-then-write window:
  // e.g. the dead-pid reconcile's PID-identity guard rejects a job that respawned with a
  // different pid between this read and the write.
  const isTerminalTransition = Boolean(rawPatch.status && TERMINAL_STATUSES.has(rawPatch.status));
  let persisted;
  if (isTerminalTransition) {
    if (!finalizeJob(stateDir, jobId, rawPatch, extraGuard ? { guard: extraGuard } : {})) {
      // Lost the terminal claim, the guard rejected the fresh record, or the job was
      // finalized/pruned out from under us. C5: if a terminal record now exists, heal .done.
      const after = readJob(stateDir, jobId);
      if (after && TERMINAL_STATUSES.has(after.status)) {
        ensureTerminalSignal(cwd, jobId, after);
      }
      return { applied: false, stored, patch: null };
    }
    persisted = readJob(stateDir, jobId);
  } else {
    persisted = markJobRunning(stateDir, jobId, rawPatch, extraGuard ? { guard: extraGuard } : {});
    if (!persisted) {
      return { applied: false, stored, patch: null };
    }
  }

  // Keep the legacy state.json index in sync (dead-for-reads since 1c-i; removed in 1e)
  // so the index consumers (indexedTerminalStatus) still observe the transition.
  if (indexPatchOrBuilder == null) {
    upsertJob(cwd, { id: jobId, ...persisted });
  } else {
    const indexRaw =
      typeof indexPatchOrBuilder === "function" ? indexPatchOrBuilder(stored) : indexPatchOrBuilder;
    upsertJob(cwd, { id: jobId, ...indexRaw });
  }

  return { applied: true, stored, patch: persisted };
}

export function reconcileDeadPidJobs(cwd, jobs, deps = {}) {
  const stateDir = resolveStateDir(cwd);
  const nowMs = Date.now();
  const completedAt = nowIso();
  const applied = new Map();

  for (const job of jobs) {
    // Reconcile any active state. Background launches persist `queued` records carrying
    // the detached worker's child.pid before `runTrackedJob` promotes them to `running`;
    // both states are "active" and reconcilable.
    if (job?.status !== "running" && job?.status !== "queued") continue;
    const id = job.id;

    // C3 (orphan-lock recovery): a finalizer that crashed between the O_EXCL terminal.lock
    // claim and the job.json write leaves an orphan lock over a still-active record. The
    // worker can never finalize it (its finalize EEXISTs on the orphan lock). The shared
    // store moved stale-lock recovery out of the claim (codex's deleted claim+reclaim) and
    // into reconcile: reclaim a lock whose CLAIM is orphaned (owner dead, or stale/malformed
    // past the TTL) — keyed on the LOCK OWNER, not the worker, so a separate finalizer
    // (cancel/watchdog) that crashed while the worker still runs is still recovered. Re-read
    // fresh first so a winner that DID finish the write (or a prune) is never overwritten.
    const lock = readTerminalLock(stateDir, id);
    if (lock && isClaimOrphaned(stateDir, id, { isAlive: isProcessAlive, nowMs, workerPid: normalizeTrackedPid(job.pid) })) {
      const fresh = readJob(stateDir, id);
      if (!fresh || TERMINAL_STATUSES.has(fresh.status)) continue; // pruned, or already healed
      // Test seam: inject a prune (dir removal) between the fresh-read guard and the
      // write, to prove ensureDir:false does not resurrect a pruned job dir (R3).
      deps._hooks?.afterFreshRead?.(id);
      const status = lock.status ?? "failed"; // malformed lock (status null) -> failed
      const reason = "Codex finalizer died mid-transition; recovered from the terminal lock.";
      // R3 (mirrors shared reconcileDeadPids): ensureDir:false so a write whose dir a
      // concurrent prune removed between the fresh-read and here fails (ENOENT) instead
      // of recreating the directory and resurrecting the dead job. Abort the repair on
      // failure — the next reconcile retries if the dir is still present.
      try {
        writeJob(
          stateDir,
          { ...fresh, status, phase: status, pid: null, errorMessage: reason },
          { ensureDir: false },
        );
      } catch {
        continue; // dir pruned mid-repair — do not resurrect
      }
      applied.set(id, { status, phase: status, pid: null, errorMessage: reason });
      writeCompletionSignalFile(cwd, id, { status, reason });
      continue;
    }

    // Dead-pid finalize: a worker that died without reporting a terminal status. A `queued`
    // record with a dead tracked pid would otherwise wedge forever and block future
    // /codex:rescue runs (the active-job guard treats queued as active).
    const pid = normalizeTrackedPid(job.pid);
    if (pid === null || isProcessAlive(pid)) continue;

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
      // The PID-identity guard runs again on the FRESH record inside finalizeJob (see the
      // adapter): if the persisted PID no longer matches the one we observed as dead (job
      // re-spawned, or the OS recycled the PID), the finalize is rejected.
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
  const stateDir = resolveStateDir(cwd);
  const jobs = sharedListJobs(stateDir).sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  );
  // Reconcile first (persists orphan-lock + dead-pid recoveries), then overlay the
  // terminal.lock over any remaining stale-active record (R1): a markRunning-vs-finalize
  // race leaves job.json active while the lock is authoritative.
  return reconcileDeadPidJobs(cwd, jobs).map((job) => overlayTerminalLock(stateDir, job));
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
        // R2: overlay the authoritative terminal.lock (mirror listJobs) so a
        // cross-workspace reader never sees a stale-"running" record that a
        // finalize already superseded — else /codex:wait <foreign-id> polls
        // until timeout on a job that actually finished.
        return { job: overlayTerminalLock(workspaceStateDir, job), workspaceStateDir };
      }
    }
  }
  return null;
}

export function resolveJobDoneFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), "done.json");
}

// One-shot terminal-claim marker for a job: the shared finalizeJob's atomic O_EXCL
// creation of this file is the cross-process "first terminal writer wins" gate.
export function resolveJobLockFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), "terminal.lock");
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
