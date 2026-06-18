import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import {
  createJob,
  readJob,
  writeJob,
  finalizeJob,
  markJobRunning,
  lockFilePath,
} from "../../shared/lib/core/state-store.mjs";
import { cancelJob } from "../../shared/lib/core/job-control.mjs";

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cancel-"));

// 目錄式佈局(spec §3):job 以 createJobRecord + createJob 建立,prompt 一併寫入。
function seedJob(stateDir, overrides = {}) {
  const record = { ...createJobRecord({ engine: "delegate" }), ...overrides };
  createJob(stateDir, record, "prompt");
  return record;
}

test("cancelJob claims terminal BEFORE signalling, and never signals a finalized job", () => {
  const stateDir = makeTempDir();
  seedJob(stateDir, { id: "delegate-c1", status: "running", pid: 4242 });
  const killed = [];
  const r1 = cancelJob(stateDir, "delegate-c1", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(r1.ok, true);
  assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  assert.equal(readJob(stateDir, "delegate-c1").status, "cancelled");

  // 已終態的 job:不可再 kill
  seedJob(stateDir, { id: "delegate-c2", status: "running", pid: 4343 });
  finalizeJob(stateDir, "delegate-c2", { status: "completed" });
  const killed2 = [];
  const r2 = cancelJob(stateDir, "delegate-c2", {
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
  seedJob(stateDir, { id: "delegate-c3", status: "running", pid: 5555 });

  // Steal the O_EXCL lock without changing the job file — simulates a concurrent
  // finalizer that claimed the lock just before our cancelJob call.
  // The job dir was already created by createJob above.
  fs.writeFileSync(lockFilePath(stateDir, "delegate-c3"), "concurrent-winner", {
    flag: "wx",
  });

  const killed3 = [];
  const r3 = cancelJob(stateDir, "delegate-c3", {
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

test("cancelJob never signals unsafe pids even when JSON is polluted", () => {
  const stateDir = makeTempDir();
  const killed = [];
  const deps = { isAlive: () => true, killImpl: (pid, sig) => killed.push([pid, sig]) };
  let n = 0;
  for (const pid of [-1, 0, "0", "-1", 1.2]) {
    const id = `delegate-bad-${n++}`;
    seedJob(stateDir, { id, status: "running", pid });
    const r = cancelJob(stateDir, id, deps);
    assert.equal(r.ok, true, "state machine still cancels");
  }
  assert.deepEqual(killed, [], "no unsafe pid is ever signalled");
});

test("cancelJob re-reads pid after CAS win (queued job that just turned running)", () => {
  const stateDir = makeTempDir();
  seedJob(stateDir, { id: "delegate-late", status: "queued" });
  const killed = [];
  const r = cancelJob(stateDir, "delegate-late", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
    // cancel 讀到的是 queued(無 pid);worker 在 finalize 前轉 running 補 pid。
    // finalizeJob 的 fresh-merge 保留 pid,cancel 的重讀必須殺到它。
    beforeFinalize: () => markJobRunning(stateDir, "delegate-late", { pid: 6066 }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(killed, [[6066, "SIGTERM"]], "fresh-merged pid is signalled");
});

test("cancelJob prefers the fresh-merged pid over a stale snapshot pid", () => {
  const stateDir = makeTempDir();
  // 初始 JSON 帶著舊(已重用的)pid — 不可殺它
  seedJob(stateDir, { id: "delegate-stale", status: "queued", pid: 9999 });
  const killed = [];
  const r = cancelJob(stateDir, "delegate-stale", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
    beforeFinalize: () => markJobRunning(stateDir, "delegate-stale", { pid: 6066 }),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(killed, [[6066, "SIGTERM"]], "post-finalize pid wins over stale snapshot");
});

// 兩段式殺的第一段(spec §5):cancelJob 對 worker pid 發單一純 SIGTERM。
// killImpl 收到的 pid 必須是正整數的 worker pid,絕不是負的 pgid——
// process-group kill 是第二段,由 worker 的 installCancelForwarder 完成。
test("cancelJob uses injectable killImpl with plain SIGTERM to the worker pid", () => {
  const stateDir = makeTempDir();
  seedJob(stateDir, { id: "delegate-kill", status: "running", pid: 7373 });
  const killed = [];
  const r = cancelJob(stateDir, "delegate-kill", {
    isAlive: () => true,
    killImpl: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(r.ok, true);
  assert.equal(killed.length, 1);
  const [pid, sig] = killed[0];
  assert.equal(sig, "SIGTERM", "stage one is a plain SIGTERM, not SIGKILL");
  assert.ok(Number.isInteger(pid) && pid > 1, "worker pid is a positive integer");
  assert.ok(pid > 0, "never a negative pgid — group kill is the worker's job (stage two)");
});
