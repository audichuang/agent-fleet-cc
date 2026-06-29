import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  applyJobPatchIfActive,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLockFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  updateState,
  upsertJob,
  writeJobFile
} from "../../plugins/codex/scripts/lib/state.mjs";

const DEAD_PID = 2147483646; // above PID_MAX on Linux/macOS — never a live process

// The bespoke claim-time stale-lock reclaim (codex's deleted claimTerminalTransition)
// is gone. Its end-to-end purpose — recover a job whose finalizer crashed between the
// O_EXCL claim and the job.json write — now lives in the dead-pid reconcile's
// lock-repair branch, covered by facade-finalize.test.mjs ("reconcile repairs an
// orphan-lock job from the lock status (C3)").

test("applyJobPatchIfActive wins the cross-process terminal CAS and records an O_EXCL claim", () => {
  const workspace = makeTempDir();
  const jobId = "job-cas-win";
  writeJobFile(workspace, jobId, { id: jobId, status: "running", phase: "running", pid: null });

  const result = applyJobPatchIfActive(workspace, jobId, () => ({ status: "completed", phase: "done" }));

  assert.equal(result.applied, true);
  assert.equal(fs.existsSync(resolveJobLockFile(workspace, jobId)), true, "the terminal claim file must exist");
  assert.equal(readJobFile(resolveJobFile(workspace, jobId)).status, "completed");
});

test("applyJobPatchIfActive loses the terminal CAS when another process already claimed it (O_EXCL)", () => {
  const workspace = makeTempDir();
  const jobId = "job-cas-lose";
  // The per-job file is still active (a real cross-process race: this process
  // read it as running before the competitor's terminal write landed).
  writeJobFile(workspace, jobId, { id: jobId, status: "running", phase: "running", pid: null });
  // Simulate the competitor having already claimed the terminal transition.
  fs.writeFileSync(resolveJobLockFile(workspace, jobId), "completed\n", "utf8");

  const result = applyJobPatchIfActive(workspace, jobId, () => ({ status: "failed", phase: "failed" }));

  assert.equal(result.applied, false, "must not write a second terminal record after losing the claim");
  assert.equal(
    readJobFile(resolveJobFile(workspace, jobId)).status,
    "running",
    "the per-job record must not be clobbered after losing the terminal claim"
  );
});

test("applyJobPatchIfActive does not claim a terminal lock for a non-terminal (progress) patch", () => {
  const workspace = makeTempDir();
  const jobId = "job-progress";
  writeJobFile(workspace, jobId, { id: jobId, status: "running", phase: "starting", pid: null });

  const result = applyJobPatchIfActive(workspace, jobId, () => ({ phase: "investigating" }));

  assert.equal(result.applied, true);
  assert.equal(
    fs.existsSync(resolveJobLockFile(workspace, jobId)),
    false,
    "progress updates must not consume the one-shot terminal claim"
  );
});

test("resolveStateDir uses a temp-backed per-workspace directory when CLAUDE_PLUGIN_DATA is unset", () => {
  const workspace = makeTempDir();
  // This test asserts the temp-backed FALLBACK, which only applies when
  // CLAUDE_PLUGIN_DATA is not set. A real plugin install (or a Claude Code
  // session) sets CLAUDE_PLUGIN_DATA to a $HOME path, which would otherwise
  // make `startsWith(os.tmpdir())` fail — so control it here for determinism.
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = resolveJobsDir(workspace);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  // Directory-per-job layout: jobs/ holds one directory per retained job.
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`).sort()
  );
});

function seedActiveJob(workspace, overrides = {}) {
  const job = {
    id: overrides.id ?? "task-seed",
    status: overrides.status ?? "running",
    phase: overrides.phase ?? "investigating",
    pid: overrides.pid ?? process.pid,
    logFile: overrides.logFile ?? resolveJobLogFile(workspace, overrides.id ?? "task-seed"),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
  writeJobFile(workspace, job.id, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return job;
}

test("applyJobPatchIfActive applies patch and updates both persistence layers", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace);

  const result = applyJobPatchIfActive(workspace, job.id, {
    status: "failed",
    phase: "failed",
    errorMessage: "boom"
  });

  assert.equal(result.applied, true);
  assert.equal(result.stored.status, "running");
  assert.equal(result.patch.status, "failed");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.errorMessage, "boom");

  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
});

test("applyJobPatchIfActive skips writes when the job is already terminal", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace, { id: "task-terminal", status: "completed" });

  const result = applyJobPatchIfActive(workspace, job.id, {
    status: "failed",
    errorMessage: "would clobber"
  });

  assert.equal(result.applied, false);
  assert.equal(result.stored.status, "completed");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.errorMessage, undefined);
});

test("applyJobPatchIfActive runs extraGuard in addition to the built-in active-state check", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace, { id: "task-pid-guard", pid: 99001 });

  const matchingPid = applyJobPatchIfActive(
    workspace,
    job.id,
    { status: "failed" },
    (stored) => stored.pid === 99001
  );
  assert.equal(matchingPid.applied, true);

  seedActiveJob(workspace, { id: "task-pid-guard", pid: 99001 });

  const mismatchPid = applyJobPatchIfActive(
    workspace,
    "task-pid-guard",
    { status: "failed", errorMessage: "wrong pid" },
    (stored) => stored.pid === 77777
  );
  assert.equal(mismatchPid.applied, false);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "task-pid-guard"), "utf8"));
  assert.equal(persisted.status, "running");
  assert.equal(persisted.errorMessage, undefined);
});

test("applyJobPatchIfActive never bypasses the active-state check even if extraGuard returns true for a terminal record", () => {
  const workspace = makeTempDir();
  seedActiveJob(workspace, { id: "task-terminal-extra", status: "failed" });

  const result = applyJobPatchIfActive(
    workspace,
    "task-terminal-extra",
    { status: "completed", errorMessage: "would overwrite" },
    () => true // extraGuard says yes, but the built-in gate must still veto
  );
  assert.equal(result.applied, false);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "task-terminal-extra"), "utf8"));
  assert.equal(persisted.status, "failed");
});

test("applyJobPatchIfActive stamps updatedAt on every applied patch", () => {
  const workspace = makeTempDir();
  const job = seedActiveJob(workspace, { id: "task-updated-at" });
  const before = new Date().toISOString();

  const result = applyJobPatchIfActive(workspace, job.id, { phase: "verifying" });

  assert.equal(result.applied, true);
  assert.ok(result.patch.updatedAt, "returned patch must include updatedAt");
  assert.ok(result.patch.updatedAt >= before, "updatedAt must be recent");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.updatedAt, result.patch.updatedAt);
});

test("applyJobPatchIfActive returns applied=false when the per-job file is missing", () => {
  const workspace = makeTempDir();
  // Don't seed anything. Helper must not throw.
  const result = applyJobPatchIfActive(workspace, "task-missing", { status: "failed" });
  assert.equal(result.applied, false);
  assert.equal(result.stored, null);
});

test("listJobs auto-reconciles a running job when its tracked pid is dead", () => {
  const workspace = makeTempDir();
  const deadPid = 2147483645; // well above PID_MAX on Linux/macOS
  const job = seedActiveJob(workspace, { id: "task-zombie", pid: deadPid });

  const [reconciled] = listJobs(workspace);

  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.phase, "failed");
  assert.equal(reconciled.pid, null);
  assert.equal(reconciled.autoReconciled, true);
  assert.equal(reconciled.reconciledDeadPid, deadPid);
  assert.match(reconciled.errorMessage ?? "", /exited without reporting/);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.autoReconciled, true);
});

test("listJobs leaves running jobs alone when the tracked pid is alive", () => {
  const workspace = makeTempDir();
  seedActiveJob(workspace, { id: "task-live", pid: process.pid });

  const [job] = listJobs(workspace);
  assert.equal(job.status, "running");
  assert.equal(job.pid, process.pid);
});

test("listJobs reconciliation: a terminal per-job record is never downgraded, even carrying a dead pid", () => {
  const workspace = makeTempDir();
  const deadPid = 2147483644;

  // Single source of truth = the per-job file. A record that already reached a
  // terminal status must never be reconciled to "failed", even if it still carries
  // a (now-dead) pid: the dead-PID reconciler only considers ACTIVE (queued/running)
  // records, so the status gate must come before the pid check.
  const completedJob = {
    id: "task-race-completed",
    status: "completed",
    phase: "done",
    pid: deadPid,
    logFile: resolveJobLogFile(workspace, "task-race-completed"),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z"
  };
  writeJobFile(workspace, completedJob.id, completedJob);

  const [job] = listJobs(workspace);
  assert.equal(job.status, "completed"); // not downgraded
  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, completedJob.id), "utf8"));
  assert.equal(persisted.status, "completed"); // per-job file preserved
  assert.equal(persisted.autoReconciled, undefined);
});

test("listJobs reconciles dead-PID queued jobs so a crashed background launcher cannot block future tasks", () => {
  // Regression for the blocker found in the third Codex review round:
  // `/codex:rescue --background` persists the record as status:"queued"
  // with the detached child's pid, and only flips to "running" after the
  // worker takes over. If the worker dies before that promotion, the
  // record must still be reconciled — otherwise it stays "queued" forever
  // and the active-job guard in codex-companion.mjs treats it as a live
  // task and rejects every subsequent /codex:rescue dispatch.
  const workspace = makeTempDir();
  const deadPid = 2147483642;
  seedActiveJob(workspace, {
    id: "task-dead-queued",
    status: "queued",
    phase: "queued",
    pid: deadPid
  });

  const [reconciled] = listJobs(workspace);

  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.autoReconciled, true);
  assert.equal(reconciled.reconciledDeadPid, deadPid);
});

test("reconcile PID-identity defense: a terminal write is rejected when the per-job pid drifts", () => {
  // The dead-PID reconciler passes an extraGuard `stored.pid === <observed dead pid>`
  // to applyJobPatchIfActive so a job RE-SPAWNED with a new pid between the listJobs
  // scan and the reconcile write is never wrongly failed (a cross-process race;
  // under single-source dir-scan the scan and write read the same file, so this guard
  // is exercised at the mechanism level here). When the stored pid no longer matches
  // the observed-dead pid, the guard fails and NO terminal write lands.
  const workspace = makeTempDir();
  const observedDeadPid = 2147483643;
  const respawnedPid = process.pid; // the per-job was relaunched with a live, different pid

  const job = {
    id: "task-pid-drift",
    status: "running",
    phase: "investigating",
    pid: respawnedPid,
    logFile: resolveJobLogFile(workspace, "task-pid-drift"),
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, job.id, job);

  const result = applyJobPatchIfActive(
    workspace,
    job.id,
    () => ({ status: "failed", autoReconciled: true }),
    (stored) => stored.pid === observedDeadPid // pid drifted -> guard fails
  );

  assert.equal(result.applied, false);
  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(persisted.status, "running");
  assert.equal(persisted.autoReconciled, undefined);
});

// B1: saveState computed its deletion set from a FRESH disk read of the index but
// the retention set from the CALLER's (possibly stale) snapshot. A job another
// process enqueued after the caller loaded — but before it saved — appeared in the
// fresh read, was absent from the stale snapshot, and got its per-job file (the
// watchdog's source of truth) plus .log/.done/.lock deleted. saveState must only
// delete artifacts for jobs the caller actually knew about and dropped.
test("saveState does not delete the artifacts of a job another process enqueued concurrently", () => {
  const workspace = makeTempDir();

  // Process A's in-memory snapshot: one running job it knows about.
  const known = {
    id: "job-known",
    status: "running",
    phase: "starting",
    pid: process.pid,
    logFile: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, known.id, known);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [known] });

  // Process B concurrently enqueues a NEW active job (per-job file + index) AFTER
  // process A loaded its snapshot but before A persists.
  const enqueued = {
    id: "job-enqueued-elsewhere",
    status: "queued",
    phase: "queued",
    pid: process.pid,
    logFile: null,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
  writeJobFile(workspace, enqueued.id, enqueued);
  upsertJob(workspace, enqueued);

  // Process A persists its STALE snapshot (it never saw job-enqueued-elsewhere).
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [known] });

  assert.ok(
    fs.existsSync(resolveJobFile(workspace, enqueued.id)),
    "saveState must not delete the per-job file of a job enqueued by another process"
  );
});

// Guard against over-correcting B1: a job the caller intentionally removes via
// updateState (e.g. SessionEnd cleanup dropping its own terminal jobs) must still
// have its artifacts cleaned up.
test("updateState still deletes the artifacts of a job the caller intentionally removed", () => {
  const workspace = makeTempDir();
  const doomed = {
    id: "job-doomed",
    status: "completed",
    phase: "done",
    pid: null,
    logFile: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  writeJobFile(workspace, doomed.id, doomed);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [doomed] });

  updateState(workspace, (state) => {
    state.jobs = state.jobs.filter((job) => job.id !== doomed.id);
  });

  assert.equal(
    fs.existsSync(resolveJobFile(workspace, doomed.id)),
    false,
    "a job the caller dropped from its own snapshot must have its per-job file deleted"
  );
});
