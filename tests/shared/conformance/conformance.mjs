// tests/shared/conformance/conformance.mjs
// 參數化合約測試(spec §7:十劇本)。任何 adapter + fake fixture 進來,
// 自動驗形態無關五不變量。Plan B/C 的 claude/agy adapter 直接重用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../../shared/lib/core/job.mjs";
import { readEvents } from "../../../shared/lib/core/events.mjs";
import {
  createJob,
  readJob,
  finalizeJob,
  jobDir,
} from "../../../shared/lib/core/state-store.mjs";
import { runWorker } from "../../../shared/lib/runtime/worker.mjs";
import { killProcessGroup } from "../../../shared/lib/runtime/spawn.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-conf-"));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
};

async function runScenario({ makeAdapter, mode, timeoutMs = 8000, prompt = "hello", onChild }) {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "conformance", timeoutMs });
  createJob(stateDir, record, prompt);
  const adapter = makeAdapter({ mode });
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { graceMs: 200, ...(onChild ? { onChild } : {}) },
  });
  return { stateDir, record, code, job: readJob(stateDir, record.id) };
}

function assertInvariants(stateDir, record, job) {
  assert.ok(
    ["completed", "failed", "cancelled", "timed-out"].includes(job.status),
    `invariant 1: terminal state reached, got ${job.status}`,
  );
  const types = readEvents(jobDir(stateDir, record.id)).map((e) => e.type);
  for (const required of ["job-created", "spawned", "finalized"]) {
    assert.ok(types.includes(required), `invariant 2: ${required} event written`);
  }
}

export function runConformanceSuite({ makeAdapter }) {
  test("scenario 1 — normal completion", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "ok" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "completed");
    assert.match(job.resultText, /^echo:/);
    assert.equal(job.sessionId, "fake-session-1");
  });

  test("scenario 2 — midway drop fails the JOB, not the runner", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "midway-drop" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, 1);
  });

  test("scenario 3 — stream noise is tolerated", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "noise" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "completed");
    assert.equal(job.resultText, "survived noise");
  });

  test("scenario 4 — hang hits timeout and reaps the group", async () => {
    const { stateDir, record, job } = await runScenario({
      makeAdapter,
      mode: "hang",
      timeoutMs: 400,
    });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "timed-out");
  });

  test("scenario 5 — instant exit with no output", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "instant-exit" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, 7);
  });

  test("scenario 6 — cancel race: first terminal writer wins, worker never overwrites", async () => {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "conformance", timeoutMs: 8000 });
    createJob(stateDir, record, "p");
    const adapter = makeAdapter({ mode: "hang" });
    const workerDone = runWorker({
      stateDir,
      jobId: record.id,
      adapter,
      deps: {
        graceMs: 100,
        onChild(child) {
          // canceller 搶先 finalize,然後殺群(模擬 cancelJob 的順序)
          assert.equal(finalizeJob(stateDir, record.id, { status: "cancelled" }), true);
          killProcessGroup(child.pid, "SIGKILL");
        },
      },
    });
    await workerDone;
    const job = readJob(stateDir, record.id);
    assert.equal(job.status, "cancelled", "cancel must never be overwritten by the worker");
    assertInvariants(stateDir, record, job);
  });

  test("scenario 7 — resume args reach the engine", async () => {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "conformance", timeoutMs: 8000 });
    createJob(stateDir, record, "continue please");
    const adapter = makeAdapter({ mode: "resume", resumeSessionId: "fake-session-1" });
    await runWorker({ stateDir, jobId: record.id, adapter, deps: {} });
    assert.equal(readJob(stateDir, record.id).resultText, "resumed");
  });

  test("scenario 8 — huge output (≈256KB) survives streaming", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "huge-output" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "completed");
    assert.equal(job.resultText, `huge:${64 * 1024 * 4}`);
  });

  test("scenario 9 — auth expiring mid-job classifies as auth", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "auth-expire-midway" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "failed");
    assert.equal(job.errorKind, "auth");
  });

  test("scenario 10 — cancel reaps grandchildren (no zombie engines)", async () => {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "conformance", timeoutMs: 8000 });
    createJob(stateDir, record, "p");
    const adapter = makeAdapter({ mode: "grandchild" });
    let grandchildPid = null;
    let childPid = null;
    const workerDone = runWorker({
      stateDir,
      jobId: record.id,
      adapter,
      deps: {
        graceMs: 100,
        onChild(child) {
          childPid = child.pid;
          child.stdout.on("data", (chunk) => {
            const m = String(chunk).match(/"pid":(\d+)/);
            if (m && !grandchildPid) {
              grandchildPid = Number(m[1]);
              finalizeJob(stateDir, record.id, { status: "cancelled" });
              killProcessGroup(child.pid, "SIGTERM");
            }
          });
        },
      },
    });
    await workerDone;
    assert.ok(grandchildPid, "fixture must report its grandchild");
    assert.ok(await waitGone(childPid), "child reaped");
    assert.ok(await waitGone(grandchildPid), "grandchild reaped — zombies burn API money");
    assert.equal(readJob(stateDir, record.id).status, "cancelled");
  });
}
