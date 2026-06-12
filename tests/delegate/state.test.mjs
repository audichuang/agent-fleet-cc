import { makeTempDir } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  resolveDataRoot,
  workspaceStateDir,
  newJobId,
  writeJob,
  readJob,
  listJobs,
  finalizeJob,
  markJobRunning,
  readTerminalLock,
  pruneJobs,
  jobFilePath,
  promptFilePath,
  logFilePath,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from "../../plugins/delegate/scripts/lib/state.mjs";
import { reconcileDeadPids } from "../../plugins/delegate/scripts/lib/job-control.mjs";

test("resolveDataRoot prefers DELEGATE_PLUGIN_DATA then CLAUDE_PLUGIN_DATA", () => {
  assert.equal(resolveDataRoot({ DELEGATE_PLUGIN_DATA: "/a", CLAUDE_PLUGIN_DATA: "/b" }), "/a");
  assert.equal(resolveDataRoot({ CLAUDE_PLUGIN_DATA: "/b" }), "/b");
  assert.ok(resolveDataRoot({}).includes(".claude"));
});

test("workspaceStateDir is stable per cwd and collision-resistant", () => {
  const root = makeTempDir();
  const a = workspaceStateDir(root, "/home/u/proj");
  const b = workspaceStateDir(root, "/home/u/proj");
  const c = workspaceStateDir(root, "/home/other/proj");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("write/read/list jobs round-trips and sorts newest first", () => {
  const stateDir = makeTempDir();
  const j1 = { id: newJobId(1000), status: "queued", createdAt: "2026-01-01T00:00:00Z" };
  const j2 = { id: newJobId(2000), status: "queued", createdAt: "2026-01-02T00:00:00Z" };
  writeJob(stateDir, j1);
  writeJob(stateDir, j2);
  assert.equal(readJob(stateDir, j1.id).id, j1.id);
  assert.equal(readJob(stateDir, "missing"), null);
  const listed = listJobs(stateDir);
  assert.deepEqual(listed.map((j) => j.id), [j2.id, j1.id]);
  assert.ok(listed[0].updatedAt, "writeJob stamps updatedAt");
});

test("finalizeJob: first terminal writer wins (CAS)", () => {
  const stateDir = makeTempDir();
  const job = { id: newJobId(), status: "running", createdAt: "2026-01-01T00:00:00Z" };
  writeJob(stateDir, job);
  assert.equal(finalizeJob(stateDir, job.id, { status: "completed" }), true);
  assert.equal(finalizeJob(stateDir, job.id, { status: "cancelled" }), false);
  assert.equal(readJob(stateDir, job.id).status, "completed");
});

test("corrupt job file is skipped by listJobs, not fatal", () => {
  const stateDir = makeTempDir();
  const job = { id: newJobId(), status: "queued", createdAt: "x" };
  writeJob(stateDir, job);
  fs.writeFileSync(path.join(stateDir, "jobs", "broken.json"), "{nope");
  assert.equal(listJobs(stateDir).length, 1);
});

test("pruneJobs caps terminal jobs but never evicts active ones", () => {
  const stateDir = makeTempDir();
  for (let i = 0; i < 6; i++) {
    const id = `dlg-prune-${i}`;
    writeJob(stateDir, {
      id,
      status: i < 2 ? "running" : "completed",
      createdAt: `2026-01-0${i + 1}T00:00:00Z`,
    });
  }
  pruneJobs(stateDir, { max: 3 });
  const remaining = listJobs(stateDir);
  const running = remaining.filter((j) => j.status === "running");
  assert.equal(running.length, 2, "active jobs survive");
  assert.ok(remaining.length <= 3);
});

test("finalizeJob: missing job → false, leaves no lock or json behind", () => {
  const stateDir = makeTempDir();
  assert.equal(finalizeJob(stateDir, "ghost", { status: "completed" }), false);
  assert.equal(readJob(stateDir, "ghost"), null);
  assert.ok(!fs.existsSync(jobFilePath(stateDir, "ghost") + ".lock"));
});

test("finalizeJob: terminal JSON without lock → false, creates no lock", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-t", status: "cancelled", createdAt: "a" });
  assert.equal(finalizeJob(stateDir, "dlg-t", { status: "completed" }), false);
  assert.equal(readJob(stateDir, "dlg-t").status, "cancelled");
  assert.ok(!fs.existsSync(jobFilePath(stateDir, "dlg-t") + ".lock"));
});

test("finalizeJob after prune cannot revive the job (tombstone regression)", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-rev", status: "running", createdAt: "a" });
  assert.equal(finalizeJob(stateDir, "dlg-rev", { status: "cancelled" }), true);
  pruneJobs(stateDir, { max: 0 });
  assert.equal(finalizeJob(stateDir, "dlg-rev", { status: "completed" }), false);
  assert.equal(listJobs(stateDir).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "jobs")), []);
});

test("finalizeJob lock records the terminal status as parseable JSON", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-lk", status: "running", createdAt: "a" });
  finalizeJob(stateDir, "dlg-lk", { status: "timed-out" });
  const lock = JSON.parse(
    fs.readFileSync(jobFilePath(stateDir, "dlg-lk") + ".lock", "utf8"),
  );
  assert.equal(lock.status, "timed-out");
});

test("readTerminalLock tolerates legacy and garbage lock contents", () => {
  const stateDir = makeTempDir();
  const id = "dlg-locks";
  writeJob(stateDir, { id, status: "running", createdAt: "a" });
  assert.equal(readTerminalLock(stateDir, id), null);
  const lockFile = jobFilePath(stateDir, id) + ".lock";
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, status: "cancelled" }));
  assert.equal(readTerminalLock(stateDir, id).status, "cancelled");
  fs.writeFileSync(lockFile, "concurrent-winner"); // 垃圾字串
  assert.equal(readTerminalLock(stateDir, id).status, null);
  fs.writeFileSync(lockFile, "12345"); // 遺留裸 pid — 注意這是合法 JSON number
  assert.equal(readTerminalLock(stateDir, id).status, null);
});

test("markJobRunning claims a queued job and stamps the pid", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-mr", status: "queued", createdAt: "a" });
  const job = markJobRunning(stateDir, "dlg-mr", { pid: 1234 });
  assert.ok(job);
  const after = readJob(stateDir, "dlg-mr");
  assert.equal(after.status, "running");
  assert.equal(after.pid, 1234);
});

test("markJobRunning: existing lock → null, JSON untouched", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-mr2", status: "queued", createdAt: "a" });
  fs.writeFileSync(
    jobFilePath(stateDir, "dlg-mr2") + ".lock",
    JSON.stringify({ status: "cancelled" }),
    { flag: "wx" },
  );
  assert.equal(markJobRunning(stateDir, "dlg-mr2", { pid: 1 }), null);
  assert.equal(readJob(stateDir, "dlg-mr2").status, "queued");
});

test("markJobRunning: missing or already-terminal job → null", () => {
  const stateDir = makeTempDir();
  assert.equal(markJobRunning(stateDir, "ghost", {}), null);
  writeJob(stateDir, { id: "dlg-mr3", status: "cancelled", createdAt: "a" });
  assert.equal(markJobRunning(stateDir, "dlg-mr3", {}), null);
});

// B 修法核心收斂測試：double-check 負責「絕不 spawn」，repair 負責「JSON 收斂」。
test("markJobRunning residual window: lock during write → null, reconcile repairs JSON", () => {
  const stateDir = makeTempDir();
  writeJob(stateDir, { id: "dlg-mr4", status: "queued", createdAt: "a" });
  const result = markJobRunning(stateDir, "dlg-mr4", { pid: 4321 }, {
    beforeRecheck: () => {
      fs.writeFileSync(
        jobFilePath(stateDir, "dlg-mr4") + ".lock",
        JSON.stringify({ status: "cancelled" }),
        { flag: "wx" },
      );
    },
  });
  assert.equal(result, null, "loser must not get the job (never spawn)");
  assert.equal(readJob(stateDir, "dlg-mr4").status, "running", "JSON transiently wrong");
  const repaired = reconcileDeadPids(stateDir, { isAlive: () => false });
  assert.ok(repaired.includes("dlg-mr4"));
  assert.equal(readJob(stateDir, "dlg-mr4").status, "cancelled", "repair converges from lock");
});

test("status sets are disjoint and cover the lifecycle", () => {
  for (const s of ACTIVE_STATUSES) assert.ok(!TERMINAL_STATUSES.has(s));
  assert.ok(TERMINAL_STATUSES.has("completed"));
  assert.ok(TERMINAL_STATUSES.has("timed-out"));
});
