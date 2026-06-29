// Regression tests for the Phase 1A read-side gap: the lock-as-authority overlay
// (R1) was wired into listJobs but NOT into the readers that read job.json
// directly — attach/logs --follow (R1) and the cross-workspace lookup (R2). The
// markJobRunning-vs-finalizeJob window the .wlock removal opened can leave job.json
// stale-"running" while terminal.lock holds the true terminal status; these readers
// must consult the lock or they over-wait / over-tail a job that already finished.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  writeJobFile,
  resolveJobLogFile,
  findJobByIdAcrossWorkspaces,
} from "../../plugins/codex/scripts/lib/state.mjs";
import { handleAttach } from "../../plugins/codex/scripts/codex-companion.mjs";

// Seed the exact state the markRunning-vs-finalize window leaves behind: job.json
// stale-"running" plus a COMPLETE terminal claim owned by a LIVE finalizer
// (process.pid is alive, so reconcile's isClaimOrphaned returns false and never
// repairs job.json). The read-side overlay is then the ONLY thing that can report
// the true terminal status.
function seedStaleRunningWithTerminalLock(workspace, jobId, lockStatus = "completed") {
  const logFile = resolveJobLogFile(workspace, jobId);
  const job = {
    id: jobId,
    workspaceRoot: workspace,
    sessionId: "S1",
    status: "running",
    phase: "starting",
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  writeJobFile(workspace, jobId, job);
  fs.appendFileSync(logFile, "tail line\n");
  const lockFile = path.join(path.dirname(logFile), "terminal.lock");
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, status: lockStatus, at: new Date().toISOString() })
  );
  return job;
}

test("R1: handleAttach stops on the terminal.lock status, not the stale-running job.json", async () => {
  const workspace = makeTempDir();
  const jobId = "task-r1-stale";
  seedStaleRunningWithTerminalLock(workspace, jobId, "completed");

  // Do NOT inject readStatus — exercise handleAttach's real status closure.
  const status = await handleAttach([jobId, "--cwd", workspace], {
    readChunk: () => "",
    sleep: async () => {},
    pollIntervalMs: 0,
    maxPolls: 5, // unfixed: a never-terminal job.json runs to here and returns "running"
  });
  assert.equal(status, "completed", "must honor the authoritative terminal.lock, not the stale job.json");
});

test("R2: cross-workspace lookup overlays the terminal.lock onto a stale-running record", async () => {
  const workspace = makeTempDir();
  const jobId = "task-r2-foreign";
  seedStaleRunningWithTerminalLock(workspace, jobId, "completed");

  // findJobByIdAcrossWorkspaces is the raw read every cross-workspace reader funnels
  // through. From a DIFFERENT cwd it must report the lock's terminal status, not the
  // stale-running job.json (else /codex:wait <foreign-id> polls until timeout).
  const found = findJobByIdAcrossWorkspaces(makeTempDir(), jobId);
  assert.ok(found, "the foreign job id must be located");
  assert.equal(found.job.status, "completed", "cross-workspace record must reflect the authoritative terminal.lock");
});
