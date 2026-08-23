import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { findJobByIdAcrossWorkspaces, getConfig, jobFilePath, listJobs, readJobFile, resolveStateDir } from "./state.mjs";
import { readProgressSnapshot } from "./codex-progress.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const STALE_LOG_THRESHOLD_MS = 2 * 60 * 1000;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function parseLogLine(line) {
  const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!match) return null;
  return { timestamp: match[1], text: match[2].trim() };
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

function formatRelativeAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s ago`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  return `${minutes}m ${seconds}s ago`;
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const now = Date.now();
  const result = [];
  const rawLines = fs.readFileSync(logFile, "utf8").split(/\r?\n/);

  for (const raw of rawLines) {
    const trimmed = raw.trimEnd();
    if (!trimmed || !trimmed.startsWith("[")) continue;
    const parsed = parseLogLine(trimmed);
    if (!parsed || !parsed.text || isProgressBlockTitle(parsed.text)) continue;
    const lineTime = Date.parse(parsed.timestamp);
    const ago = Number.isFinite(lineTime) ? formatRelativeAgo(now - lineTime) : null;
    result.push(ago ? `[${ago}] ${parsed.text}` : parsed.text);
  }

  return result.slice(-maxLines);
}

function computeIdleInfo(logFile) {
  if (!logFile) return null;
  let stat;
  try {
    stat = fs.statSync(logFile);
  } catch {
    return null;
  }
  const lastActivityMs = stat.mtimeMs;
  const idleMs = Math.max(0, Date.now() - lastActivityMs);
  return {
    lastActivityAt: new Date(lastActivityMs).toISOString(),
    idleForMs: idleMs,
    idleFor: formatRelativeAgo(idleMs)
  };
}

function stripRelativePrefix(line) {
  return line.replace(/^\[[^\]]+ago\]\s*/, "");
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = stripRelativePrefix(progressPreview[index]).toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const isActive = job.status === "queued" || job.status === "running";
  const idle = isActive ? computeIdleInfo(job.logFile) : null;

  const timeoutAt = typeof job.timeoutAt === "string" ? Date.parse(job.timeoutAt) : null;
  const timeoutRemainingMs =
    isActive && Number.isFinite(timeoutAt) ? Math.max(0, timeoutAt - Date.now()) : null;

  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null,
    lastActivityAt: idle?.lastActivityAt ?? null,
    idleForMs: idle?.idleForMs ?? null,
    idleFor: idle?.idleFor ?? null,
    staleLog: Boolean(idle && idle.idleForMs > STALE_LOG_THRESHOLD_MS),
    timeoutRemainingMs,
    timeoutRemaining:
      timeoutRemainingMs == null ? null : formatRelativeAgo(timeoutRemainingMs)?.replace(/ ago$/, "")
  };

  // Option A: live progress (phase/threadId/turnId) lives in events.ndjson, not the
  // record, so overlay it for the display surfaces. Identity is folded for any job
  // (a finished job's resume hint, an active job's interrupt id); the live phase only
  // overrides for ACTIVE jobs — a terminal record keeps its final phase.
  const snapshot = options.stateDir
    ? readProgressSnapshot(options.stateDir, job.id)
    : { threadId: null, turnId: null, phase: null };

  return {
    ...enriched,
    threadId: enriched.threadId ?? snapshot.threadId,
    turnId: enriched.turnId ?? snapshot.turnId,
    phase:
      (isActive ? snapshot.phase : null) ??
      enriched.phase ??
      inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  // jobFilePath, not resolveJobFile: this is a pure READ, and resolveJobFile mkdirs the
  // per-job dir on the way there. A /codex:result racing a prune would otherwise
  // re-create an empty jobs/<id>/ with no terminal.lock — invisible to the orphan sweep
  // and to the job list, i.e. leaked forever (see state.mjs jobFilePath).
  const jobFile = jobFilePath(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

// A detached background worker is spawned BEFORE enqueueBackgroundTask finishes writing
// the job file (spawnWorker then writeJobFile, no await between). Normally the parent's
// synchronous write wins the race against the child's Node bootstrap, but under scheduler
// pressure the child can reach the read first — a hard first-miss throw then kills the
// background job instantly. Bounded-wait for the file instead of betting on the order.
// ponytail: bounded retry (~2s), not a spawn/write barrier — the parent write is a few
// synchronous lines after spawn, so this window swallows the race with no new shared state.
export async function readStoredJobWithRetry(workspaceRoot, jobId, deps = {}) {
  const readFn = deps.readFn ?? readStoredJob;
  const sleepFn = deps.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.attempts ?? 40;
  const intervalMs = deps.intervalMs ?? 50;
  for (let i = 0; i < attempts; i++) {
    const job = readFn(workspaceRoot, jobId);
    if (job) {
      return job;
    }
    if (i < attempts - 1) {
      await sleepFn(intervalMs);
    }
  }
  return null;
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  // A reference that resolves against the UNFILTERED list is not unknown — the job
  // exists and is merely in the wrong state for this action. Return null so the
  // caller's own state-specific message runs ("already completed", "still running");
  // claiming "no job found" sends the operator hunting for a job /codex:status shows
  // plainly. Only a genuinely unknown reference is an error.
  if (jobs.some((job) => job.id === reference || job.id.startsWith(reference))) {
    return null;
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const stateDir = resolveStateDir(workspaceRoot);

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines, stateDir }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines, stateDir }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines, stateDir }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const allowCrossWorkspace = options.allowCrossWorkspace !== false; // default preserves current behaviour
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  let selected;
  try {
    selected = matchJobReference(jobs, reference);
  } catch (error) {
    // An explicit, full job id not found locally may belong to a job dispatched
    // from another workspace. Fall back to an exact cross-workspace lookup
    // (read-only) so the id does not dead-end as "Job not found". A bare prefix
    // won't match the per-job file, so it correctly re-throws the local error.
    // In expected (worktree) mode allowCrossWorkspace=false: skip the fallback
    // so lookups stay workspace-scoped and never bleed into sibling worktrees.
    if (allowCrossWorkspace && reference) {
      const found = findJobByIdAcrossWorkspaces(cwd, reference);
      if (found) {
        return {
          workspaceRoot: found.job.workspaceRoot ?? workspaceRoot,
          // The PHYSICAL state dir where the job actually lives. Re-deriving it
          // from job.workspaceRoot under the current CLAUDE_PLUGIN_DATA can miss
          // (different host/root), so callers needing the per-job file must use this.
          stateDir: found.workspaceStateDir,
          job: enrichJob(found.job, {
            maxProgressLines: options.maxProgressLines,
            stateDir: found.workspaceStateDir
          }),
          crossWorkspace: true
        };
      }
    }
    throw error;
  }
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, {
      maxProgressLines: options.maxProgressLines,
      stateDir: resolveStateDir(workspaceRoot)
    })
  };
}

// allowCrossWorkspace accepted for caller-uniformity; already workspace-scoped (no cross-workspace fallback here)
export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    // Option A: the resume-hint thread/turn id lives in events.ndjson, not the
    // terminal record, so overlay it for the result surface.
    const { threadId, turnId } = readProgressSnapshot(resolveStateDir(workspaceRoot), selected.id);
    return {
      workspaceRoot,
      job: { ...selected, threadId: selected.threadId ?? threadId, turnId: selected.turnId ?? turnId }
    };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

// allowCrossWorkspace accepted for caller-uniformity; already workspace-scoped (no cross-workspace fallback here)
export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const isActive = (job) => job.status === "queued" || job.status === "running";
  const activeJobs = jobs.filter(isActive);

  if (reference) {
    // Match against the FULL list with an active-only predicate (not a pre-filtered
    // list): that is what lets the matcher tell an already-finished job apart from an
    // unknown id, so a just-completed job is reported as finished, not as missing.
    const selected = matchJobReference(jobs, reference, isActive);
    if (!selected) {
      const finished = jobs.find((job) => job.id === reference || job.id.startsWith(reference));
      throw new Error(
        finished
          ? `Job ${finished.id} is already ${finished.status}; nothing to cancel.`
          : `No active job found for "${reference}".`
      );
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
