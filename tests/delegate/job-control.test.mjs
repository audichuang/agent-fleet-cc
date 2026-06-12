import { makeTempDir } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  reconcileDeadPids,
  cancelJob,
  safePid,
} from "../../plugins/delegate/scripts/lib/job-control.mjs";
import {
  writeJob,
  readJob,
  finalizeJob,
  markJobRunning,
  jobFilePath,
} from "../../plugins/delegate/scripts/lib/state.mjs";

test("reconcileDeadPids fails running jobs whose pid is gone", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-dead", status: "running", pid: 99999, createdAt: "a" });
  writeJob(stateDir, { id: "dlg-live", status: "running", pid: 11111, createdAt: "b" });
  const reconciled = reconcileDeadPids(stateDir, {
    isAlive: (pid) => pid === 11111,
  });
  assert.deepEqual(reconciled, ["dlg-dead"]);
  assert.equal(readJob(stateDir, "dlg-dead").status, "failed");
  assert.equal(readJob(stateDir, "dlg-live").status, "running");
});

test("cancelJob claims terminal BEFORE signalling, and never signals a finalized job", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-c1", status: "running", pid: 4242, createdAt: "a" });
  const killed = [];
  const r1 = cancelJob(stateDir, "dlg-c1", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(r1.ok, true);
  assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  assert.equal(readJob(stateDir, "dlg-c1").status, "cancelled");

  // 已終態的 job：不可再 kill
  writeJob(stateDir, { id: "dlg-c2", status: "running", pid: 4343, createdAt: "b" });
  finalizeJob(stateDir, "dlg-c2", { status: "completed" });
  const killed2 = [];
  const r2 = cancelJob(stateDir, "dlg-c2", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed2.push([pid, sig]),
  });
  assert.equal(r2.ok, false);
  assert.deepEqual(killed2, [], "stale pid must never be signalled");
});

// CAS-loser path: job status is still 'running' when cancelJob reads it,
// but the terminal-transition lock was already claimed by a concurrent winner.
// cancelJob must lose the finalizeJob CAS race and MUST NOT signal the pid.
test("cancelJob CAS-loser: job reads as running but lock already taken — must not signal", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-c3", status: "running", pid: 5555, createdAt: "c" });

  // Steal the O_EXCL lock without changing the job file — simulates a concurrent
  // finalizer that claimed the lock just before our cancelJob call.
  // The job dir was already created by writeJob above.
  const lockFile = jobFilePath(stateDir, "dlg-c3") + ".lock";
  fs.writeFileSync(lockFile, "concurrent-winner", { flag: "wx" });

  const killed3 = [];
  const r3 = cancelJob(stateDir, "dlg-c3", {
    isAlive: () => true, // pid looks alive — without CAS guard this would signal
    killImpl: (pid, sig) => killed3.push([pid, sig]),
  });
  // CAS loser: cannot claim terminal transition
  assert.equal(r3.ok, false);
  assert.deepEqual(killed3, [], "CAS loser must never signal — pid may be reused");
});

test("cancelJob on unknown job reports cleanly", () => {
  const stateDir = makeTempDir();
  const r = cancelJob(stateDir, "nope", { isAlive: () => true, killImpl: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /No job/);
});

test("safePid rejects group/global/garbage pids", () => {
  for (const bad of [-1, 0, 1, "0", "-1", "1 2", 1.2, NaN, undefined, null, ""]) {
    assert.equal(safePid(bad), null, `safePid(${JSON.stringify(bad)})`);
  }
  assert.equal(safePid(4242), 4242);
  assert.equal(safePid("4242"), 4242);
});

test("cancelJob never signals unsafe pids even when JSON is polluted", () => {
  const stateDir = makeTempDir();
  const killed = [];
  const deps = { isAlive: () => true, killImpl: (pid, sig) => killed.push([pid, sig]) };
  let n = 0;
  for (const pid of [-1, 0, "0", "-1", 1.2]) {
    const id = `dlg-bad-${n++}`;
    writeJob(stateDir, { id, status: "running", pid, createdAt: "a" });
    const r = cancelJob(stateDir, id, deps);
    assert.equal(r.ok, true, "state machine still cancels");
  }
  assert.deepEqual(killed, [], "no unsafe pid is ever signalled");
});

test("cancelJob re-reads pid after CAS win (queued job that just turned running)", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-late", status: "queued", createdAt: "a" });
  const killed = [];
  const r = cancelJob(stateDir, "dlg-late", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
    // cancel 讀到的是 queued（無 pid）；worker 在 finalize 前轉 running 補 pid。
    // finalizeJob 的 fresh-merge 保留 pid，cancel 的重讀必須殺到它。
    beforeFinalize: () => markJobRunning(stateDir, "dlg-late", { pid: 6066 }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(killed, [[6066, "SIGTERM"]], "fresh-merged pid is signalled");
});

test("cancelJob prefers the fresh-merged pid over a stale snapshot pid", () => {
  const stateDir = makeTempDir();
  // 初始 JSON 帶著舊（已重用的）pid — 不可殺它
  writeJob(stateDir, { id: "dlg-stale", status: "queued", pid: 9999, createdAt: "a" });
  const killed = [];
  const r = cancelJob(stateDir, "dlg-stale", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
    beforeFinalize: () => markJobRunning(stateDir, "dlg-stale", { pid: 6066 }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(killed, [[6066, "SIGTERM"]], "post-finalize pid wins over stale snapshot");
});

test("reconcile repairs lock-claimed job whose finalizer died (status from lock)", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-rp1", status: "running", pid: 4444, createdAt: "a" });
  fs.writeFileSync(
    jobFilePath(stateDir, "dlg-rp1") + ".lock",
    JSON.stringify({ status: "cancelled" }),
    { flag: "wx" },
  );
  const reconciled = reconcileDeadPids(stateDir, { isAlive: () => false });
  assert.ok(reconciled.includes("dlg-rp1"));
  assert.equal(readJob(stateDir, "dlg-rp1").status, "cancelled");
});

test("reconcile repair falls back to failed on garbage lock content", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-rp2", status: "running", pid: 4445, createdAt: "a" });
  fs.writeFileSync(jobFilePath(stateDir, "dlg-rp2") + ".lock", "concurrent-winner", {
    flag: "wx",
  });
  reconcileDeadPids(stateDir, { isAlive: () => false });
  assert.equal(readJob(stateDir, "dlg-rp2").status, "failed");
});

test("reconcile repair leaves live workers alone", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-rp3", status: "running", pid: 4446, createdAt: "a" });
  fs.writeFileSync(
    jobFilePath(stateDir, "dlg-rp3") + ".lock",
    JSON.stringify({ status: "cancelled" }),
    { flag: "wx" },
  );
  const reconciled = reconcileDeadPids(stateDir, { isAlive: () => true });
  assert.deepEqual(reconciled, []);
  assert.equal(readJob(stateDir, "dlg-rp3").status, "running");
});

test("reconcile repairs queued job with claimed lock and no pid", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-rp4", status: "queued", createdAt: "a" });
  fs.writeFileSync(
    jobFilePath(stateDir, "dlg-rp4") + ".lock",
    JSON.stringify({ status: "cancelled" }),
    { flag: "wx" },
  );
  const reconciled = reconcileDeadPids(stateDir, { isAlive: () => false });
  assert.ok(reconciled.includes("dlg-rp4"));
  assert.equal(readJob(stateDir, "dlg-rp4").status, "cancelled");
});
