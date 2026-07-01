// R3 (codex facade): the shared reconcileDeadPids lock-repair was hardened to write
// with ensureDir:false so a concurrent prune that deletes the job dir between the
// fresh-read and the write cannot be resurrected (tests/shared/reconcile-no-resurrect).
// codex's state.mjs carries its OWN duplicate orphan-lock repair in reconcileDeadPidJobs
// (deleted only once the migration to the shared reconcile completes). This pins that
// the duplicate honours the same no-resurrect invariant — it was the one branch the
// shared R3 fix missed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir } from "./helpers.mjs";
import {
  reconcileDeadPidJobs,
  resolveJobFile,
  resolveJobLockFile,
  writeJobFile,
} from "../../plugins/codex/scripts/lib/state.mjs";

const DEAD_PID = 2147483646; // above PID_MAX — never a live process, so the claim is orphaned

test("reconcileDeadPidJobs orphan-lock repair does not resurrect a job dir pruned after the fresh-read (R3)", () => {
  const workspace = makeTempDir();
  const jobId = "job-orphan-pruned";
  const jobDir = path.dirname(resolveJobFile(workspace, jobId));

  // Active record + orphan COMPLETE claim by a dead claimer → the lock-repair branch fires.
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "running",
    phase: "running",
    pid: DEAD_PID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    resolveJobLockFile(workspace, jobId),
    `${JSON.stringify({ status: "failed", pid: DEAD_PID })}\n`,
    "utf8",
  );

  reconcileDeadPidJobs(workspace, [{ id: jobId, status: "running", pid: DEAD_PID }], {
    _hooks: {
      // A concurrent prune deletes the whole dir AFTER the fresh-read, BEFORE the write.
      afterFreshRead: () => fs.rmSync(jobDir, { recursive: true, force: true }),
    },
  });

  assert.equal(
    fs.existsSync(jobDir),
    false,
    "lock-repair must not recreate a dir pruned mid-repair (ensureDir:false)",
  );
});
