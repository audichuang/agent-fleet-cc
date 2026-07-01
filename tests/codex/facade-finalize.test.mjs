// Phase 1A / 1c-ii-b: state.mjs's applyJobPatchIfActive becomes a thin adapter over
// the shared finalizeJob (terminal) / markJobRunning (promotion), and the bespoke
// .wlock + codex claimTerminalTransition machinery is deleted. These tests pin the
// two behaviours that the deletion must NOT regress, exercised through the codex
// FACADE (listJobs / the dead-pid reconcile) rather than the shared primitives:
//
//   R1  — a stale-"running" job.json left by a markRunning-vs-finalize race must be
//         reported as its terminal status: the terminal.lock is authoritative (the
//         shared store does not eliminate that window, worker.test.mjs:289-294).
//   C3  — codex's claim-time stale-lock reclaim goes away with the bespoke claim, so
//         the dead-pid reconcile must take over the orphan-lock recovery (a finalizer
//         that crashed between the O_EXCL claim and the job.json write), or a job
//         wedges forever behind a lock finalizeJob can never re-win.

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobDoneFile,
  resolveJobFile,
  resolveJobLockFile,
  writeJobFile,
} from "../../plugins/codex/scripts/lib/state.mjs";

const DEAD_PID = 2147483646; // above PID_MAX on Linux/macOS — never a live process

// R1: a terminal.lock is authoritative over a stale-"running" job.json. listJobs is
// the facade every status/active decision routes through, so the overlay must live
// there, not only in the resolveAuthoritativeStatus helper.
test("listJobs reports the terminal.lock status over a stale-running job.json (R1)", () => {
  const workspace = makeTempDir();
  const jobId = "job-stale-running";
  // Alive pid so the dead-pid reconcile leaves it alone — this isolates the R1
  // overlay from the C3 reconcile path below.
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "running",
    pid: process.pid,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    resolveJobLockFile(workspace, jobId),
    `${JSON.stringify({ status: "cancelled", pid: process.pid })}\n`,
    "utf8",
  );

  const [job] = listJobs(workspace);
  assert.equal(
    job.status,
    "cancelled",
    "a job whose terminal.lock won must surface as terminal, not the stale running record",
  );
});

// C3: a finalizer that crashed between the O_EXCL claim and the job.json write leaves
// an orphan terminal.lock over a still-active record with a dead pid. The bespoke
// claim used to reclaim such a lock; finalizeJob never can (EEXIST). The dead-pid
// reconcile must repair the record from the lock so the job reaches a terminal state
// and its .done signal is written (no waiter stranded forever).
test("listJobs reconcile repairs an orphan-lock job from the lock status (C3)", () => {
  const workspace = makeTempDir();
  const jobId = "job-orphan-lock";
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "running",
    pid: DEAD_PID, // the worker died
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  // The crashed finalizer's orphan claim: it won the O_EXCL lock (status "failed")
  // but died before rewriting job.json.
  fs.writeFileSync(
    resolveJobLockFile(workspace, jobId),
    `${JSON.stringify({ status: "failed", pid: DEAD_PID })}\n`,
    "utf8",
  );

  const [job] = listJobs(workspace);
  assert.equal(job.status, "failed", "the orphan-lock job must be recovered to the lock's terminal status");
  assert.equal(
    readJobFile(resolveJobFile(workspace, jobId)).status,
    "failed",
    "the recovery must persist to job.json, not just the in-memory overlay",
  );
  assert.equal(
    fs.existsSync(resolveJobDoneFile(workspace, jobId)),
    true,
    "a recovered terminal job must get its .done signal so a waiter is never stranded",
  );
});
