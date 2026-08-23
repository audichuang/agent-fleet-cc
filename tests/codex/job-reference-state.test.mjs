// A job reference that names a REAL job in the wrong state for the action must be
// reported as such, never as "No job found" — that message tells the operator the
// record is gone and sends them hunting for a job /codex:status shows plainly.
// Found by a real-engine smoke: `/codex:cancel <id>` on a job that had just completed
// answered `No job found for "<id>"`. Same root cause made resolveResultJob's own
// "still running" message unreachable for an explicit reference.

import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";

import { resolveJobsDir, writeJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { readStoredJob, resolveCancelableJob, resolveResultJob } from "../../plugins/codex/scripts/lib/job-control.mjs";

function seedRecord(workspace, id, overrides) {
  writeJobFile(workspace, id, {
    id,
    status: "running",
    phase: "starting",
    // A live seed needs a live pid: reconcileDeadPidJobs flips an active job with a
    // dead pid to failed on the first read.
    pid: process.pid,
    jobClass: "task",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  });
}

test("cancel on an already-finished job says it is finished, not that it is missing", () => {
  const workspace = makeTempDir();
  for (const status of ["completed", "failed", "cancelled"]) {
    const id = `job-${status}`;
    seedRecord(workspace, id, { status, phase: "done", pid: null, completedAt: "2026-01-01T00:01:00.000Z" });
    assert.throws(() => resolveCancelableJob(workspace, id), new RegExp(`already ${status}; nothing to cancel`, "i"));
    assert.doesNotMatch(
      (() => {
        try {
          resolveCancelableJob(workspace, id);
          return "";
        } catch (error) {
          return error.message;
        }
      })(),
      /No job found|No active job found/i
    );
  }
});

test("cancel on a genuinely unknown reference still reports it as unknown", () => {
  const workspace = makeTempDir();
  seedRecord(workspace, "job-live", {});
  assert.throws(() => resolveCancelableJob(workspace, "totally-unknown-zzz"), /No job found/i);
});

test("cancel still resolves an active job by exact id and by unique prefix", () => {
  const workspace = makeTempDir();
  seedRecord(workspace, "job-live-abc", {});
  assert.equal(resolveCancelableJob(workspace, "job-live-abc").job.id, "job-live-abc");
  assert.equal(resolveCancelableJob(workspace, "job-live-a").job.id, "job-live-abc");
});

test("an ambiguous prefix across active jobs is still ambiguous, not reinterpreted", () => {
  const workspace = makeTempDir();
  seedRecord(workspace, "job-live-aaa", {});
  seedRecord(workspace, "job-live-bbb", {});
  assert.throws(() => resolveCancelableJob(workspace, "job-live-"), /ambiguous/i);
});

test("result on a still-running job reaches its own state-specific message", () => {
  const workspace = makeTempDir();
  seedRecord(workspace, "job-live", {});
  assert.throws(() => resolveResultJob(workspace, "job-live"), /job-live is still running/i);
});

// resolveJobFile mkdirs the per-job dir on its way to job.json, so reading a job that
// a concurrent prune just removed RE-CREATED jobs/<id>/ — empty, no terminal.lock, so
// sweepOrphanLockDirs never collects it and the job list skips it: a permanent leak.
// A read must derive the path purely (state.mjs jobFilePath).
test("readStoredJob leaves no job directory behind when the job does not exist", () => {
  const workspace = makeTempDir();

  assert.equal(readStoredJob(workspace, "task-never-existed"), null);
  assert.equal(
    fs.existsSync(path.join(resolveJobsDir(workspace), "task-never-existed")),
    false,
    "a read must not create the job directory it failed to find"
  );
});
