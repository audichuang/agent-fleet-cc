// Phase 1A / Gap-2 Option A resolution (see
// docs/superpowers/plans/2026-06-29-codex-gap2-b3-resolution.md).
//
// Option A moves job progress (phase/threadId/turnId) off job.json into the
// append-only events.ndjson, so the progress-clobbers-terminal race (B3) is
// structurally impossible: job.json is written only by markJobRunning +
// finalizeJob. These tests exercise that contract against the SHARED store
// directly (the layout/CRUD facade wiring lands in later 1a/1b/1c sub-steps).

import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  createJob,
  finalizeJob,
  jobDir,
  readJob,
  writeJob,
} from "../../plugins/codex/scripts/lib/shared/core/state-store.mjs";
import { appendEvent } from "../../plugins/codex/scripts/lib/shared/core/events.mjs";
import { TERMINAL_STATUSES } from "../../plugins/codex/scripts/lib/shared/core/job.mjs";
import {
  readCurrentTurnIdentity,
  resolveAuthoritativeStatus,
} from "../../plugins/codex/scripts/lib/codex-progress.mjs";

function seedJob(stateDir, id) {
  createJob(
    stateDir,
    { id, engine: "codex", status: "running", createdAt: "2026-01-01T00:00:00.000Z" },
    "the prompt",
  );
  return jobDir(stateDir, id);
}

// Blocker 4: progress dedups threadId and turnId INDEPENDENTLY (only the changed
// id is re-emitted), so a given engine-event may carry only one of them. A naive
// "last engine-event with a turnId" reader would lose the threadId. The reader
// must fold in order and keep the latest non-null of EACH id.
test("readCurrentTurnIdentity keeps the latest non-null threadId and turnId independently", () => {
  const stateDir = makeTempDir();
  const dir = seedJob(stateDir, "job-id");

  appendEvent(dir, "engine-event", { threadId: "T1", turnId: "U1", phase: "starting" });
  appendEvent(dir, "engine-event", { turnId: "U2", phase: "investigating" }); // turn advances; thread unchanged
  appendEvent(dir, "engine-event", { phase: "editing" }); // neither id present

  const { threadId, turnId } = readCurrentTurnIdentity(stateDir, "job-id");
  assert.equal(threadId, "T1", "latest non-null threadId survives later id-less events");
  assert.equal(turnId, "U2", "latest non-null turnId");
});

// The headline no-clobber proof, deterministic and hookless (Blocker 2): the
// stale progress write is sequenced to land AFTER the finalize. Under Option A
// progress is an appendEvent that never opens job.json, so the terminal record
// cannot be resurrected — and the current turn identity is still recoverable.
test("Option A: a progress event after a finalize never resurrects the terminal record", () => {
  const stateDir = makeTempDir();
  const dir = seedJob(stateDir, "job-keep");
  appendEvent(dir, "engine-event", { threadId: "T1", turnId: "U1", phase: "investigating" });

  const stored = readJob(stateDir, "job-keep"); // P_prog reads ACTIVE
  assert.equal(stored.status, "running");

  finalizeJob(stateDir, "job-keep", { status: "failed", errorMessage: "watchdog" }); // P_term finalizes

  // P_prog's progress, Option A: append an engine-event (never touches job.json),
  // landing AFTER the terminal write.
  appendEvent(dir, "engine-event", { phase: "still-emitting", turnId: "U1" });

  const job = readJob(stateDir, "job-keep");
  assert.ok(TERMINAL_STATUSES.has(job.status), "terminal record is never resurrected to active");
  assert.equal(job.status, "failed", "first terminal writer wins");

  const { threadId, turnId } = readCurrentTurnIdentity(stateDir, "job-keep");
  assert.ok(threadId && turnId, "current turn identity still recoverable from events.ndjson");
});

// Teeth (fails-first proof the scenario genuinely reproduces B3): model the
// REJECTED variant-(i) facade (progress = readJob(active) ... writeJob(stale),
// lockless/unconditional) with its two steps straddling the finalize. This is
// the exact B3-reopening shape; it MUST resurrect, or the proof above is vacuous.
test("teeth: the naive variant-(i) progress facade DOES resurrect a finalized job (B3)", () => {
  const stateDir = makeTempDir();
  seedJob(stateDir, "job-bug");

  const stored = readJob(stateDir, "job-bug"); // step 1: read + active-gate passes (running)
  assert.equal(stored.status, "running");

  finalizeJob(stateDir, "job-bug", { status: "failed" }); // concurrent terminal write

  // step 2: the unconditional writeJob lands with the STALE active snapshot.
  writeJob(stateDir, { ...stored, phase: "running" });

  const job = readJob(stateDir, "job-bug");
  assert.equal(job.status, "running", "the naive lockless writeJob clobbers the terminal record (the bug Option A removes)");
});

// Blocker 1: markJobRunning is a SECOND active-status job.json writer. If a
// finalize claims the terminal.lock between markJobRunning's queued-read and its
// running-write, the running-write lands last and leaves job.json stale-"running"
// (the shared suite documents this at worker.test.mjs:289-294). The shared store
// does NOT eliminate that window; its contract is that the terminal.lock is
// authoritative. R1: codex's status/list readers must honour the lock, so a
// cancelled-during-promotion job is never reported as still running.
test("R1: a terminal.lock is authoritative over a stale-running job.json (markRunning vs finalize)", () => {
  const stateDir = makeTempDir();
  createJob(
    stateDir,
    { id: "job-mr", engine: "codex", status: "queued", createdAt: "2026-01-01T00:00:00.000Z" },
    "the prompt",
  );

  // Model the dangerous interleave deterministically: read queued (markJobRunning
  // :150-151) -> concurrent finalize claims+writes cancelled -> the stale running
  // promotion (markJobRunning :152) lands last.
  const queued = readJob(stateDir, "job-mr");
  assert.equal(queued.status, "queued");
  finalizeJob(stateDir, "job-mr", { status: "cancelled" });
  writeJob(stateDir, { ...queued, status: "running" });

  assert.equal(readJob(stateDir, "job-mr").status, "running", "job.json is left stale-running");
  assert.equal(
    resolveAuthoritativeStatus(stateDir, "job-mr"),
    "cancelled",
    "the terminal.lock is authoritative — R1 readers report terminal, not the stale running",
  );
});
