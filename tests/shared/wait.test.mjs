// tests/shared/wait.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { appendEvent } from "../../shared/lib/core/events.mjs";
import {
  createJob,
  readJob,
  writeJob,
  finalizeJob,
  jobDir,
} from "../../shared/lib/core/state-store.mjs";
import { reconcileDeadPids } from "../../shared/lib/core/reconcile.mjs";
import { waitForJob } from "../../shared/lib/core/wait.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wait-"));

test("resolves done=true when job reaches terminal state, streaming new events", async () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  const seen = [];
  setTimeout(() => {
    appendEvent(jobDir(s, j.id), "engine-event", { raw: "tick" });
    finalizeJob(s, j.id, { status: "completed", resultText: "done" });
  }, 30);
  const out = await waitForJob({
    stateDir: s,
    jobId: j.id,
    timeoutMs: 5000,
    pollMs: 10,
    onEvent: (e) => seen.push(e.type),
  });
  assert.equal(out.done, true);
  assert.equal(out.job.status, "completed");
  assert.ok(seen.includes("engine-event")); // 心跳:新事件有透傳
});

test("resolves done=false on timeout with current job snapshot", async () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  const out = await waitForJob({ stateDir: s, jobId: j.id, timeoutMs: 50, pollMs: 10 });
  assert.equal(out.done, false);
  assert.equal(out.job.status, "queued");
});

test("missing job resolves done=true with job=null (nothing to wait for)", async () => {
  const out = await waitForJob({ stateDir: tmp(), jobId: "ghost", timeoutMs: 50, pollMs: 10 });
  assert.equal(out.done, true);
  assert.equal(out.job, null);
});

// ─── F1: reconcile-each-poll — a dead worker must not make wait hang to timeout ──
// A "running" job whose pid is dead would, without reconcile, stay "running" until
// the wait timeout fires (done=false). With a reconcile hook called at the TOP of
// each poll, the dead pid is finalized → next readJob sees "failed" → resolves
// done=true with the failed job, well before the timeout.
//
// mutation criterion: drop the `reconcile(stateDir)` call at the top of the poll
// loop → the running job is never terminalized → waitForJob returns done=false on
// timeout → assert.equal(out.done, true) turns red.
test("F1: reconcile hook terminalizes a dead-pid running job → resolves done=true, not timeout", async () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  // Stamp a dead pid and force the job to "running" — the worker died mid-run.
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  // Use the real reconcileDeadPids with an injected dead isAlive (no live pid here,
  // but we keep it deterministic). reconcileDeadPids(stateDir) is the production wiring.
  const reconcile = (stateDir) => reconcileDeadPids(stateDir, { isAlive: () => false });
  // Long timeout so a hang would be obvious; small poll so reconcile fires fast.
  const out = await waitForJob({
    stateDir: s,
    jobId: j.id,
    timeoutMs: 5000,
    pollMs: 10,
    reconcile,
  });
  assert.equal(out.done, true, "must resolve done=true via reconcile, not time out");
  assert.equal(out.job.status, "failed");
  assert.match(out.job.error, /reconciled dead pid/);
});

// Backward-compat: WITHOUT a reconcile hook, the same dead-pid running job is NOT
// terminalized — wait blocks until timeout and returns done=false with the stale
// "running" snapshot. This proves the default no-op reconcile preserves old behaviour.
test("F1: no reconcile hook → dead-pid running job is left running until timeout (unchanged)", async () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  const out = await waitForJob({ stateDir: s, jobId: j.id, timeoutMs: 60, pollMs: 10 });
  assert.equal(out.done, false, "without reconcile, must time out (legacy behaviour)");
  assert.equal(out.job.status, "running");
});
