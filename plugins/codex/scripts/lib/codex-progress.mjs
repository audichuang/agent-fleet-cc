// Codex-only progress + turn-identity layer for the shared directory-per-job
// store (Phase 1A / Gap-2 Option A; see
// docs/superpowers/plans/2026-06-29-codex-gap2-b3-resolution.md).
//
// Under Option A, live progress (phase/threadId/turnId) is appended to the
// per-job events.ndjson as `engine-event`s instead of being written into
// job.json. That keeps job.json single-writer-per-transition (markJobRunning +
// finalizeJob only), so a progress write can never resurrect a terminal record
// (B3 becomes structurally impossible). This module is the read side: it
// recovers the *current* turn identity that the watchdog, cancel, crash-net, and
// timeout interrupt paths previously read off job.json.

import { jobDir, readJob, readTerminalLock } from "./shared/core/state-store.mjs";
import { readEvents } from "./shared/core/events.mjs";
import { TERMINAL_STATUSES } from "./shared/core/job.mjs";

// Recover the current { threadId, turnId } for a job by folding its event log.
//
// The progress emitter dedups threadId and turnId INDEPENDENTLY (it re-emits
// only the id that changed), so a single engine-event may carry just one of
// them. Keep the latest non-null value of EACH id separately — taking only the
// last event's turnId would drop a threadId set earlier and never re-emitted.
// readEvents already skips torn/junk lines and never bounds on a `finalized`
// event (externally-finalized jobs have none), which is exactly the contract the
// interrupt readers need: they must recover identity even for a job a separate
// process finalized.
export function readCurrentTurnIdentity(stateDir, jobId) {
  let threadId = null;
  let turnId = null;
  for (const event of readEvents(jobDir(stateDir, jobId))) {
    if (event.type !== "engine-event") continue;
    if (event.threadId) threadId = event.threadId;
    if (event.turnId) turnId = event.turnId;
  }
  return { threadId, turnId };
}

// The job's status, treating the terminal.lock as authoritative over job.json
// (R1). markJobRunning can leave job.json stale-"running" after a finalize claimed
// the terminal.lock (Blocker 1 / worker.test.mjs:289-294): the shared store does
// not eliminate that window, so any reader that decides "is this job still active"
// off raw job.json.status can mis-report a finalized job as running. Consult the
// lock first: a present terminal.lock means a finalize won, regardless of a stale
// record. Returns null only when the job is absent.
//
// ponytail: a corrupt lock (claimer crashed between open and write, lock.status
// null — the rare C3 window) falls through to job.json.status here, which the
// store's TTL reclaim self-heals; tighten to a "failed" fallback only if a reader
// is shown to surface that window.
export function resolveAuthoritativeStatus(stateDir, jobId) {
  const lock = readTerminalLock(stateDir, jobId);
  if (lock && TERMINAL_STATUSES.has(lock.status)) return lock.status;
  return readJob(stateDir, jobId)?.status ?? null;
}
