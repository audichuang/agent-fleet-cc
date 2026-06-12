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
  finalizeJob,
  jobDir,
} from "../../shared/lib/core/state-store.mjs";
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
