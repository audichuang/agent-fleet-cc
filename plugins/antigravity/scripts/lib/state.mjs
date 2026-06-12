/**
 * Job state persistence. Stores job metadata and results in a workspace-specific
 * directory tree.
 *
 * Directory layout:
 *   <stateRoot>/<slug>-<hash>/
 *     state.json        — global config + job index
 *     jobs/
 *       <job-id>.json   — full job record
 *       <job-id>.log    — timestamped progress log
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withJobMutex, withWorkspaceMutex, writeJsonAtomic } from "./atomic-state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "antigravity");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function slugify(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function hashPath(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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

function stateRootDir() {
  return process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_STATE_ROOT_DIR;
}

export function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const slug = slugify(path.basename(root));
  const hash = hashPath(root);
  return path.join(stateRootDir(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobLockFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.lock`);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_STATUSES = new Set(["queued", "running"]);

/** A job is "active" (still finalizable) when queued or running. */
export function isActiveJob(job) {
  return Boolean(job) && ACTIVE_STATUSES.has(job.status);
}

/**
 * Liveness probe for a tracked pid. EPERM means the pid exists but is owned by
 * another user (recycled) — treated as ALIVE here so the stale-lock reclaim and
 * cancel paths never assume a still-running process is gone.
 */
export function isProcessAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(Math.trunc(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isStaleTerminalLock(cwd, jobId, lockFile) {
  let ownerPid = null;
  try {
    ownerPid = Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid);
  } catch {
    return false; // unreadable lock → treat as NOT stale (safer)
  }
  if (!Number.isFinite(ownerPid) || ownerPid <= 0 || isProcessAlive(ownerPid)) {
    return false;
  }
  // Only stale if the owner is dead AND the job is still active.
  return isActiveJob(readJobFile(cwd, jobId));
}

/**
 * First-terminal-writer-wins gate. Atomically creates `<job>.lock` with
 * O_CREAT|O_EXCL ("wx"); only one process across the machine can succeed.
 * If the lock already exists but its owner pid is dead and the job is still
 * active (a crashed finalizer), the lock is reclaimed once and retried.
 *
 * @returns {boolean} true if this caller won the terminal claim.
 */
export function claimTerminalTransition(cwd, jobId, status, stamp) {
  ensureStateDir(cwd);
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
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 0 && isStaleTerminalLock(cwd, jobId, lockFile)) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Lost the reclaim race to another process; fall through to retry.
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function stripDetailFields(patch) {
  const { request: _r, result: _re, stdout: _s, ...rest } = patch;
  return rest;
}

/**
 * Patch a job's per-job file (source of truth) + index ONLY while it is still
 * active, and — for terminal transitions — only if this caller wins the O_EXCL
 * terminal claim. The read+gate+claim+write run inside the per-job mutex and
 * the freshest on-disk record is re-read inside the lock, so a stale snapshot
 * cannot resurrect a job another writer just finalized.
 *
 * @returns {Promise<{applied: boolean, stored: object|null, patch: object|null}>}
 */
export async function applyJobPatchIfActive(
  cwd,
  jobId,
  patchOrBuilder,
  extraGuard = null,
  indexPatchOrBuilder = null,
) {
  let outcome = { applied: false, stored: null, patch: null };

  await withJobMutex(cwd, jobId, async () => {
    const stored = readJobFile(cwd, jobId);
    if (!isActiveJob(stored)) {
      outcome = { applied: false, stored: stored ?? null, patch: null };
      return;
    }
    if (extraGuard && !extraGuard(stored)) {
      outcome = { applied: false, stored, patch: null };
      return;
    }

    const patch = typeof patchOrBuilder === "function" ? patchOrBuilder(stored) : patchOrBuilder;
    const updatedAt = new Date().toISOString();

    if (TERMINAL_STATUSES.has(patch.status) && !claimTerminalTransition(cwd, jobId, patch.status, updatedAt)) {
      outcome = { applied: false, stored, patch: null };
      return;
    }

    const merged = { ...stored, ...patch, id: jobId, updatedAt };
    writeJobFileUnlocked(cwd, jobId, merged);
    outcome = { applied: true, stored, patch };
  });

  if (outcome.applied) {
    const indexPatch = indexPatchOrBuilder
      ? typeof indexPatchOrBuilder === "function"
        ? indexPatchOrBuilder(outcome.stored)
        : indexPatchOrBuilder
      : outcome.patch;
    await upsertJob(cwd, { id: jobId, ...stripDetailFields(indexPatch) });
  }

  return outcome;
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

/**
 * Move a corrupt file aside (so it is not re-read or re-corrupted) and warn,
 * instead of silently swallowing the parse error. Best-effort: a failed rename
 * (e.g. lost race) is non-fatal.
 */
function quarantineCorruptFile(filePath, label) {
  const dest = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, dest);
    process.stderr.write(`antigravity: corrupt ${label} at ${filePath} quarantined to ${dest}\n`);
  } catch {
    // Best-effort; another process may have already moved/removed it.
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      }
    };
  } catch {
    quarantineCorruptFile(stateFile, "state.json");
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Reconcile a caller-supplied state snapshot with the current on-disk state.
 *
 * Rules:
 * - Jobs from the current on-disk state are preserved (so a stale caller
 *   snapshot cannot silently drop another writer's in-flight job).
 * - Jobs in the incoming snapshot overwrite fields for matching ids.
 * - The resulting job list is then capped to MAX_JOBS by most-recent
 *   `updatedAt`, matching the previous pruning behavior.
 */
function reconcileState(current, incoming) {
  const byId = new Map();
  for (const job of current.jobs ?? []) {
    if (job && job.id) byId.set(job.id, job);
  }
  for (const job of incoming?.jobs ?? []) {
    if (!job || !job.id) continue;
    const prev = byId.get(job.id);
    byId.set(job.id, prev ? { ...prev, ...job } : job);
  }
  const cappedJobs = pruneJobs(Array.from(byId.values()));

  return {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(current.config ?? {}),
      ...(incoming?.config ?? {})
    },
    jobs: cappedJobs
  };
}

function saveStateUnlocked(cwd, state) {
  ensureStateDir(cwd);
  // Re-load current on-disk state inside the mutex so we reconcile against
  // the freshest snapshot and never unlink another writer's files.
  const current = loadState(cwd);
  const nextState = reconcileState(current, state);

  writeJsonAtomic(resolveStateFile(cwd), nextState);

  // Prune job artifacts only for jobs that were dropped by reconciliation
  // (i.e. the MAX_JOBS cap). Jobs absent from the caller's snapshot but
  // still present in `current` are retained by `reconcileState`, so they
  // will survive here.
  const retainedIds = new Set(nextState.jobs.map((j) => j.id));
  for (const prevJob of current.jobs ?? []) {
    if (!retainedIds.has(prevJob.id)) {
      removeFileIfExists(resolveJobFile(cwd, prevJob.id));
      removeFileIfExists(resolveJobLogFile(cwd, prevJob.id));
      removeFileIfExists(resolveJobLockFile(cwd, prevJob.id));
    }
  }
}

export async function saveState(cwd, state) {
  return withWorkspaceMutex(cwd, async () => {
    saveStateUnlocked(cwd, state);
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export async function setConfig(cwd, patch) {
  return withWorkspaceMutex(cwd, async () => {
    const state = loadState(cwd);
    state.config = { ...state.config, ...patch };
    saveStateUnlocked(cwd, state);
  });
}

/**
 * Synchronous dead-PID sweep. For every active job whose tracked worker pid is
 * gone, win the terminal claim and mark it failed (per-job file + index). The
 * pid-identity re-check and O_EXCL claim make this safe under concurrent
 * reconcilers and against a job that re-spawned with a new pid.
 *
 * @returns {object[]} the (possibly reconciled) job index entries.
 */
export function reconcileDeadPidJobs(cwd, jobs) {
  const dead = [];
  for (const job of jobs) {
    if (!ACTIVE_STATUSES.has(job?.status)) continue;
    const pid = Number(job.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (isProcessAlive(pid)) continue;
    dead.push({ id: job.id, pid });
  }
  if (dead.length === 0) return jobs;

  const completedAt = new Date().toISOString();
  const patched = new Map();
  for (const { id, pid } of dead) {
    const current = readJobFile(cwd, id);
    if (!isActiveJob(current)) continue; // per-job file (truth) already terminal
    if (Number(current.pid) !== pid) continue; // re-spawned / recycled pid — skip
    if (!claimTerminalTransition(cwd, id, "failed", completedAt)) continue; // lost the race
    const patch = {
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage: `Worker process PID ${pid} exited without reporting a terminal status; auto-reconciled as failed.`,
      healthStatus: "failed",
      autoReconciled: true,
      reconciledDeadPid: pid,
    };
    try {
      writeJobFileUnlocked(cwd, id, { ...current, ...patch, id, updatedAt: completedAt });
      appendJobLog(cwd, id, `[reconcile] worker pid ${pid} gone; marked failed`);
    } catch {
      continue;
    }
    patched.set(id, stripDetailFields(patch));
  }
  if (patched.size === 0) return jobs;

  // Persist the index too so later reads (and other processes) see the failure.
  try {
    const state = loadState(cwd);
    state.jobs = state.jobs.map((j) =>
      patched.has(j.id) ? { ...j, ...patched.get(j.id), updatedAt: completedAt } : j,
    );
    saveStateUnlocked(cwd, state);
  } catch {
    // Best-effort index sync; per-job files remain authoritative.
  }

  return jobs.map((j) =>
    patched.has(j.id) ? { ...j, ...patched.get(j.id), updatedAt: completedAt } : j,
  );
}

export function listJobs(cwd) {
  return reconcileDeadPidJobs(cwd, loadState(cwd).jobs);
}

export async function upsertJob(cwd, job) {
  return withWorkspaceMutex(cwd, async () => {
    const state = loadState(cwd);
    const index = state.jobs.findIndex((j) => j.id === job.id);
    const now = new Date().toISOString();
    const updated = { ...job, updatedAt: now };

    if (index >= 0) {
      state.jobs[index] = { ...state.jobs[index], ...updated };
    } else {
      state.jobs.push({ ...updated, createdAt: now });
    }

    saveStateUnlocked(cwd, state);
  });
}

export function readJobFile(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null; // missing/unreadable — not corruption
  }
  try {
    return JSON.parse(raw);
  } catch {
    // The file exists but is unparseable (writeJsonAtomic means readers never
    // see a partial write, so this is genuine corruption). Quarantine it.
    quarantineCorruptFile(filePath, "job file");
    return null;
  }
}

/**
 * Record a progress/heartbeat timestamp on an active job so the health
 * classifier can report it as 'active' rather than drifting to a misleading
 * 'possibly_stalled'. No-op (applied:false) once the job is terminal.
 */
export async function touchJobProgress(cwd, jobId) {
  const now = new Date().toISOString();
  return applyJobPatchIfActive(cwd, jobId, { lastProgressAt: now, lastHeartbeatAt: now });
}

/**
 * Internal atomic write. Callers are responsible for holding the per-job
 * mutex; exposed so higher-level helpers that already hold the mutex (e.g.
 * `recordJobEvent`) can persist without re-acquiring.
 */
export function writeJobFileUnlocked(cwd, jobId, data) {
  ensureStateDir(cwd);
  const filePath = resolveJobFile(cwd, jobId);
  writeJsonAtomic(filePath, data);
}

export async function writeJobFile(cwd, jobId, data) {
  return withJobMutex(cwd, jobId, async () => {
    writeJobFileUnlocked(cwd, jobId, data);
  });
}

export function appendJobLog(cwd, jobId, line) {
  ensureStateDir(cwd);
  const logPath = resolveJobLogFile(cwd, jobId);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${timestamp}] ${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readJobLog(cwd, jobId) {
  const logPath = resolveJobLogFile(cwd, jobId);
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}
