// shared/lib/core/liveness.mjs
// Passive liveness observability for the shared runWorker adopters (grok +
// antigravity). See ADR-0002 and
// docs/superpowers/specs/2026-07-14-fleet-liveness-observability-design.md.
//
// Layered so the judgement is a genuinely PURE fold (hermetically testable with
// fabricated observations) and the I/O is isolated in a thin collector:
//   - projectLiveness(observations) — pure fold, no I/O, returns the locked schema
//   - collectLiveness(stateDir, jobId, deps) — impure: reads job/events/lock,
//     probes pid, counts git, then calls the fold
//   - countWorkingTreeChanges(cwd, deps) — git working-tree-change count (or null)
//   - formatLiveness(projection) — shared compact one-line render (keeps the two
//     adopters from drifting on wording)
//
// The fold is READ-ONLY: it never writes job.json, so it cannot reintroduce the
// terminal-record resurrection hazard (no progress write races a finalize).
import { spawnSync } from "node:child_process";
import { TERMINAL_STATUSES } from "./job.mjs";
import { readEvents } from "./events.mjs";
import { readJob, jobDir, readTerminalLock } from "./state-store.mjs";
import { isPidAlive, safePid } from "./reconcile.mjs";

export const SNIPPET_MAX = 80;

function parseTs(value) {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function truncate(text, max = SNIPPET_MAX) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…"; // ellipsis, total length <= max
}

// PURE fold. Inputs are already-observed values — NO stateDir/jobId, NO runners.
// { job, events, terminalLockStatus, workerAlive, workingTreeChanges, nowMs }
export function projectLiveness({
  job,
  events = [],
  terminalLockStatus = null,
  workerAlive = null,
  workingTreeChanges = null,
  nowMs,
} = {}) {
  if (!job) throw new Error("projectLiveness requires a job record");

  // Authoritative status: a terminal terminal.lock wins over a job.json that is
  // still active (the finalize-window race — a finalizer claimed terminal but the
  // record write has not landed). readTerminalLock returns {status:null} for a
  // non-terminal/corrupt lock, so guard on TERMINAL_STATUSES.
  const status =
    terminalLockStatus && TERMINAL_STATUSES.has(terminalLockStatus)
      ? terminalLockStatus
      : job.status;

  const active = !TERMINAL_STATUSES.has(status);

  // alive is meaningful only while active; nullable (null = no valid worker pid
  // yet, e.g. a queued background job before the worker stamps its pid — reporting
  // false there would read as "dead").
  const alive = active ? (workerAlive ?? null) : null;

  // Require a finite clock; without one, durations are unknowable (null, never NaN).
  const now = Number.isFinite(nowMs) ? nowMs : null;

  // elapsed run time: origin = the spawned event ts. If a spawned event EXISTS
  // but its ts is unparseable, elapsed is genuinely unknown → null; we do NOT
  // fall back to createdAt (that would silently count queued time under the
  // wrong origin). Only when there is NO spawned event at all do we fall back to
  // createdAt (origin flagged so the render marks it approximate).
  const spawned = events.find((e) => e.type === "spawned");
  let elapsedOrigin = null;
  let originTs = null;
  if (spawned) {
    const t = parseTs(spawned.ts);
    if (t !== null) {
      originTs = t;
      elapsedOrigin = "spawned";
    }
  } else {
    const createdTs = parseTs(job.createdAt);
    if (createdTs !== null) {
      originTs = createdTs;
      elapsedOrigin = "createdAt";
    }
  }
  const elapsedMs =
    now !== null && originTs !== null ? Math.max(0, Math.round(now - originTs)) : null;
  if (elapsedMs === null) elapsedOrigin = null;

  // quiet time since the last event of ANY kind. null if no events / invalid ts / no clock.
  const lastEvent = events.length ? events[events.length - 1] : null;
  const lastEventTs = lastEvent ? parseTs(lastEvent.ts) : null;
  const quietMs =
    now !== null && lastEventTs !== null ? Math.max(0, Math.round(now - lastEventTs)) : null;

  // last activity: latest event whose text is a non-empty string once inner
  // whitespace/newlines are COLLAPSED — a multiline chunk must not turn one
  // heartbeat into several physical lines. The `typeof` guard is mandatory —
  // grok end/error events (and antigravity blank lines) carry no usable text.
  let lastActivity = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (typeof e.text !== "string") continue;
    const clean = e.text.replace(/\s+/g, " ").trim();
    if (clean !== "") {
      lastActivity = { text: truncate(clean), ts: e.ts ?? null };
      break;
    }
  }

  return {
    status,
    alive,
    elapsedMs,
    elapsedOrigin,
    quietMs,
    lastActivity,
    workingTreeChanges: Number.isInteger(workingTreeChanges) ? workingTreeChanges : null,
  };
}

// git working-tree-change count for a cwd. Current `git status --porcelain`
// entries — a working-tree delta, NOT provenance (pre-existing dirt counts; a new
// dir can collapse to one entry). Returns an int, or null outside a git repo / on
// any git failure. Never throws.
export function countWorkingTreeChanges(cwd, deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawnSync;
  if (!cwd) return null;
  try {
    const res = spawnImpl("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" });
    if (!res || res.error || res.status !== 0) return null;
    const out = String(res.stdout ?? "");
    if (!out.trim()) return 0;
    return out.split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return null;
  }
}

// Impure collector: gather observations for a job, then call the pure fold.
// deps: { isAlive, gitChanges, nowMs } — all injectable for hermetic tests.
export function collectLiveness(stateDir, jobId, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const gitChanges = deps.gitChanges ?? countWorkingTreeChanges;
  const nowMs = deps.nowMs ?? Date.now();
  const job = readJob(stateDir, jobId);
  if (!job) return null;
  const events = readEvents(jobDir(stateDir, jobId));
  const terminalLockStatus = readTerminalLock(stateDir, jobId)?.status ?? null;
  const pid = safePid(job.pid);
  const workerAlive = pid ? isAlive(pid) : null; // null = no valid worker pid yet
  const workingTreeChanges = gitChanges(job.cwd);
  return projectLiveness({ job, events, terminalLockStatus, workerAlive, workingTreeChanges, nowMs });
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

// Shared compact one-line render so grok and antigravity report liveness in the
// same shape. Generic fallback for a null lastActivity ("no output yet" — covers
// both a quiet turn and grok structured-output mode that emits no stream).
export function formatLiveness(p) {
  const parts = [];
  if (p.alive === true) parts.push("alive✓");
  else if (p.alive === false) parts.push("worker gone");
  else if (!TERMINAL_STATUSES.has(p.status)) parts.push("starting");
  if (p.elapsedMs !== null) {
    const approx = p.elapsedOrigin === "createdAt" ? "~" : "";
    parts.push(`⏱${approx}${formatDuration(p.elapsedMs)}`);
  }
  if (p.lastActivity) {
    const ago = p.quietMs !== null ? ` (${formatDuration(p.quietMs)} ago)` : "";
    parts.push(`last: "${p.lastActivity.text}"${ago}`);
  } else if (!TERMINAL_STATUSES.has(p.status)) {
    parts.push("no output yet");
  }
  if (p.workingTreeChanges !== null) parts.push(`Δwt: ${p.workingTreeChanges}`);
  return parts.join("  ·  ");
}
