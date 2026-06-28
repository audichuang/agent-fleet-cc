import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  applyJobPatchIfActive,
  resolveJobFile,
  resolveJobLockFile,
  resolveJobWriteLockFile,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../../plugins/codex/scripts/lib/state.mjs";

const DEAD_PID = 2147483646; // above PID_MAX on Linux/macOS — never a live process

function seedRunning(workspace, jobId) {
  const running = {
    id: jobId,
    status: "running",
    phase: "starting",
    pid: 123,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, running);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [running] });
}

test("applyJobPatchIfActive writes the full patch to the per-job file but a lighter indexPatch to state.json", () => {
  const workspace = makeTempDir();
  const jobId = "job-idx";
  seedRunning(workspace, jobId);

  const res = applyJobPatchIfActive(
    workspace,
    jobId,
    () => ({ status: "completed", phase: "done", pid: null, result: { big: "payload" }, rendered: "RENDERED" }),
    null,
    () => ({ status: "completed", phase: "done", pid: null }) // index patch: deliberately light
  );

  assert.equal(res.applied, true);

  const file = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(file.status, "completed");
  assert.deepEqual(file.result, { big: "payload" }, "per-job file keeps the heavy result");
  assert.equal(file.rendered, "RENDERED");

  const index = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.find((j) => j.id === jobId);
  assert.equal(index.status, "completed");
  assert.equal(index.result, undefined, "state.json index stays light: no result payload");
  assert.equal(index.rendered, undefined, "state.json index stays light: no rendered text");
});

test("applyJobPatchIfActive without an indexPatch keeps writing the same patch to both (back-compat)", () => {
  const workspace = makeTempDir();
  const jobId = "job-compat";
  seedRunning(workspace, jobId);

  applyJobPatchIfActive(workspace, jobId, () => ({ status: "failed", phase: "failed", pid: null, errorMessage: "x" }));

  const index = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.find((j) => j.id === jobId);
  assert.equal(index.status, "failed");
  assert.equal(index.errorMessage, "x", "no indexPatch => index receives the same patch as before");
});

test("applyJobPatchIfActive still gates on active state when an indexPatch is supplied", () => {
  const workspace = makeTempDir();
  const jobId = "job-terminal";
  const done = {
    id: jobId,
    status: "failed",
    phase: "failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, jobId, done);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [done] });

  const res = applyJobPatchIfActive(
    workspace,
    jobId,
    () => ({ status: "completed", result: { x: 1 } }),
    null,
    () => ({ status: "completed" })
  );
  assert.equal(res.applied, false, "a terminal job is never resurrected, indexPatch or not");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "failed");
});

// B3 (per-job write mutex): a non-terminal (progress) patch must never resurrect a
// terminal record by writing {...stored, ...patch} after another process finalized
// the job. applyJobPatchIfActive now serializes its read-check-write under a per-job
// write lock that BOTH progress and terminal transitions take, so a progress write
// can no longer land between a terminal claim and its record write.
//
// The mutex replaces an earlier existsSync(.lock) gate that (a) was still
// check-then-write and (b) had no stale-lock reclamation — a terminal claim left by
// a finalizer that crashed before writing its record (record still active) blocked
// EVERY later non-terminal write forever: progress (turn identity never persisted ->
// orphaned turns un-reapable) and the B2 queued->running promotion (a real job
// silently aborted). A stale terminal claim must NOT suppress non-terminal writes.
test("applyJobPatchIfActive lets a progress write proceed past a stale terminal claim lock", () => {
  const workspace = makeTempDir();
  const jobId = "job-stale-claim-progress";
  seedRunning(workspace, jobId);
  // A finalizer crashed after claiming the terminal lock but before writing the
  // terminal record: a .lock with a dead owner while the record is still active.
  fs.writeFileSync(
    resolveJobLockFile(workspace, jobId),
    `${JSON.stringify({ status: "cancelled", pid: DEAD_PID })}\n`,
    "utf8"
  );

  const res = applyJobPatchIfActive(workspace, jobId, { phase: "investigating", threadId: "t1", turnId: "u1" });

  assert.equal(res.applied, true, "a stale terminal claim must not block a progress write");
  const file = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(file.phase, "investigating");
  assert.equal(file.threadId, "t1", "turn identity (needed to reap an orphaned turn) must be recorded");
});

test("applyJobPatchIfActive releases its per-job write lock after a write", () => {
  const workspace = makeTempDir();
  const jobId = "job-wlock-release";
  seedRunning(workspace, jobId);

  applyJobPatchIfActive(workspace, jobId, { phase: "investigating" });

  assert.equal(
    fs.existsSync(resolveJobWriteLockFile(workspace, jobId)),
    false,
    "the per-job write lock must not be left behind after a normal write"
  );
});

test("applyJobPatchIfActive reclaims a stale per-job write lock owned by a dead pid", () => {
  const workspace = makeTempDir();
  const jobId = "job-wlock-stale";
  seedRunning(workspace, jobId);
  // A previous writer crashed while holding the write lock.
  fs.writeFileSync(
    resolveJobWriteLockFile(workspace, jobId),
    `${JSON.stringify({ pid: DEAD_PID })}\n`,
    "utf8"
  );

  const res = applyJobPatchIfActive(workspace, jobId, { phase: "investigating" });

  assert.equal(res.applied, true, "a stale write lock must be reclaimed, not wedge the write");
  assert.equal(
    fs.existsSync(resolveJobWriteLockFile(workspace, jobId)),
    false,
    "the reclaimed write lock must be released"
  );
});

// A write lock observed EMPTY/unparseable is a holder caught between creating the
// O_EXCL file and writing its owner payload — NOT a dead owner. Stealing it (the
// earlier `catch { return true }`) would break mutual exclusion and re-open B3. The
// acquirer must treat it as held and fail open after the budget, leaving it intact.
test("applyJobPatchIfActive does not steal a write lock it cannot parse (a holder mid-acquire)", () => {
  const workspace = makeTempDir();
  const jobId = "job-wlock-empty";
  seedRunning(workspace, jobId);
  fs.writeFileSync(resolveJobWriteLockFile(workspace, jobId), "", "utf8"); // empty: holder mid-create

  const res = applyJobPatchIfActive(workspace, jobId, { phase: "investigating" });

  assert.equal(res.applied, true, "fails open after the budget rather than wedging");
  assert.equal(
    fs.existsSync(resolveJobWriteLockFile(workspace, jobId)),
    true,
    "an unparseable write lock must not be stolen from a possible live holder"
  );
});

// Invariant: a progress write never resurrects a job already finalized on disk.
test("applyJobPatchIfActive does not let a progress write resurrect a finalized job", () => {
  const workspace = makeTempDir();
  const jobId = "job-no-resurrect";
  seedRunning(workspace, jobId);
  applyJobPatchIfActive(workspace, jobId, () => ({ status: "cancelled", phase: "cancelled", pid: null }));

  const res = applyJobPatchIfActive(workspace, jobId, { phase: "investigating" });

  assert.equal(res.applied, false, "a progress write must not apply once the job is terminal");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")).status, "cancelled");
});
