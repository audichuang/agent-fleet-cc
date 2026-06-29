import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  readJobFile,
  resolveJobDoneFile,
  resolveJobFile,
  resolveJobLockFile,
  resolveJobLogFile,
  saveState,
  writeCompletionSignalFile,
  writeJobFile
} from "../../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitDead(pid, ms = 2500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return !isAlive(pid);
}

// C1: cancel must signal the AUTHORITATIVE per-job pid, not the (possibly stale /
// absent) index pid the resolver hands back. The old code signalled `job.pid` (the
// index snapshot), so with no index pid it killed nothing while the real worker —
// recorded in the per-job file — kept running. cancel-signal's other tests use
// pid:null and miss this.
test("cancel signals the per-job pid even when the index pid is absent", async () => {
  const workspace = makeTempDir();
  const jobId = "job-cancel-perjob-pid";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const perJob = {
      id: jobId,
      status: "running",
      phase: "investigating",
      pid: child.pid, // the per-job file holds the live worker pid (authoritative)
      logFile,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    writeJobFile(workspace, jobId, perJob);
    // Index advertises the job running but with NO pid — the stale-index case the old
    // code fell back to and signalled nothing.
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [{ ...perJob, pid: null }] });

    const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], { cwd: workspace });
    assert.equal(result.status, 0, `cancel exited non-zero: ${result.stderr}`);
    assert.equal(
      await waitDead(child.pid),
      true,
      "cancel must terminate the per-job pid even when the index pid is absent"
    );
  } finally {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // already terminated by cancel
    }
  }
});

// C1: claim-then-signal. When the CAS loses (the job already finalized itself), cancel
// must NOT signal — the index's pid may have been recycled to an unrelated process.
// The old code killed the index pid BEFORE the CAS, so it would terminate a live,
// possibly-unrelated process for a job that already completed.
test("cancel does not signal the pid when it loses the terminal CAS", async () => {
  const workspace = makeTempDir();
  const jobId = "job-cancel-loser-no-kill";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    // Single source of truth = the per-job file. The job is still "running" (so cancel
    // RESOLVES it and its active-gate passes), but a concurrent finalizer has ALREADY
    // won the O_EXCL terminal.lock and not yet rewritten the record. cancel must lose
    // the terminal CAS here — and a loser must NOT signal the (possibly recycled) pid.
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      pid: child.pid,
      logFile,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z"
    };
    writeJobFile(workspace, jobId, running);
    // The winning finalizer's claim: a live owner + fresh stamp so it is never
    // reclaimed as stale, forcing cancel's claimTerminalTransition to EEXIST (lose).
    fs.writeFileSync(
      resolveJobLockFile(workspace, jobId),
      JSON.stringify({ status: "completed", pid: process.pid, stamp: new Date().toISOString() })
    );

    const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], { cwd: workspace });
    assert.equal(result.status, 0, `cancel exited non-zero: ${result.stderr}`);
    assert.notEqual(
      readJobFile(resolveJobFile(workspace, jobId)).status,
      "cancelled",
      "a cancel that lost the terminal CAS must not clobber the record to cancelled"
    );
    await sleep(250);
    assert.equal(
      isAlive(child.pid),
      true,
      "a cancel that lost the terminal CAS must not signal the (possibly recycled) pid"
    );
  } finally {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // expected to still be alive
    }
  }
});

test("cancel writes a cancelled .done signal so a waiting monitor wakes", () => {
  const workspace = makeTempDir();
  const jobId = "job-cancel";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");

  // A real, throwaway child so the job stays "running" (dead-PID reconcile does
  // not flip it before cancel runs). cancel's terminateProcessTree kills it.
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

  try {
    const job = {
      id: jobId,
      status: "running",
      phase: "investigating",
      pid: dummy.pid,
      logFile,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    writeJobFile(workspace, jobId, job);
    saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });

    const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], { cwd: workspace });
    assert.equal(result.status, 0, `cancel exited non-zero: ${result.stderr}`);

    const doneFile = resolveJobDoneFile(workspace, jobId);
    assert.equal(fs.existsSync(doneFile), true);
    assert.equal(JSON.parse(fs.readFileSync(doneFile, "utf8")).status, "cancelled");
  } finally {
    try {
      process.kill(dummy.pid, "SIGKILL");
    } catch {
      // already terminated by cancel
    }
  }
});

test("cancel does not clobber a job that reached a terminal state during the cancel handler", () => {
  const workspace = makeTempDir();
  const jobId = "job-cancel-race";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");

  // TOCTOU at the single source of truth: cancel resolves the job while its per-job
  // record is still "running" (active-gate passes), but a concurrent finalizer has
  // already won the O_EXCL terminal.lock AND written its completed .done. cancel must
  // LOSE the terminal CAS and NOT stomp the record/signal back to "cancelled" — first
  // terminal writer wins (pid:null so dead-PID reconcile leaves the running record alone).
  const running = {
    id: jobId,
    status: "running",
    phase: "running",
    pid: null,
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z"
  };
  writeJobFile(workspace, jobId, running);
  // The winning finalizer already published its terminal .done and holds the claim.
  writeCompletionSignalFile(workspace, jobId, { status: "completed" });
  fs.writeFileSync(
    resolveJobLockFile(workspace, jobId),
    JSON.stringify({ status: "completed", pid: process.pid, stamp: new Date().toISOString() })
  );

  const result = run("node", [SCRIPT, "cancel", jobId, "--cwd", workspace, "--json"], { cwd: workspace });
  assert.equal(result.status, 0, `cancel exited non-zero: ${result.stderr}`);

  assert.notEqual(
    readJobFile(resolveJobFile(workspace, jobId)).status,
    "cancelled",
    "a cancel that lost the terminal CAS must not clobber the record to cancelled"
  );
  assert.equal(
    JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).status,
    "completed",
    "the terminal .done signal must not be overwritten with cancelled"
  );
});
