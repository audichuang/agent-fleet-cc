// agy-specific ProcessAdapter conformance (spec D-13): drives the REAL shared
// runWorker + fake-agy shim, asserting the 5 form-agnostic invariants
// (adapter-api.md §5) with plain-text agy semantics. Does NOT import the shared
// runConformanceSuite / tests/shared/conformance (those hardcode JSON-stream +
// sessionId==="fake-session-1" expectations that plain-text agy cannot satisfy).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAntigravityAdapter } from "../../plugins/antigravity/scripts/lib/adapter.mjs";
import { validateProcessAdapter } from "../../shared/lib/adapter-api.mjs";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { createJob, readJob, jobDir } from "../../shared/lib/core/state-store.mjs";
import { readEvents } from "../../shared/lib/core/events.mjs";
import { runWorker } from "../../shared/lib/runtime/worker.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agy.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agy-conf-"));

function adapterFor(mode) {
  const base = makeAntigravityAdapter();
  return {
    ...base,
    buildInvocation: ({ prompt }) => ({
      argv: [process.execPath, FAKE, "--print", prompt],
      env: { FAKE_AGY_MODE: mode },
      stdinPayload: "",
    }),
  };
}

async function drive(mode, { timeoutMs = 8000, deps = {} } = {}) {
  const sd = tmp();
  const rec = createJobRecord({ engine: "antigravity", timeoutMs, request: { mode: "print" } });
  createJob(sd, rec, "hello");
  await runWorker({ stateDir: sd, jobId: rec.id, adapter: adapterFor(mode), deps: { graceMs: 200, ...deps } });
  return { sd, id: rec.id, job: readJob(sd, rec.id), events: readEvents(jobDir(sd, rec.id)) };
}

test("contract: validateProcessAdapter === []", () =>
  assert.deepEqual(validateProcessAdapter(makeAntigravityAdapter()), []));

test("inv1+2 ok: terminal completed + job-created/spawned/result/finalized events", async () => {
  const { job, events } = await drive("ok");
  assert.equal(job.status, "completed");
  assert.equal(job.sessionId, null);
  for (const t of ["job-created", "spawned", "result", "finalized"]) {
    assert.ok(events.some((e) => e.type === t), `missing event type ${t}`);
  }
});

test("inv5 empty-exit-0 -> completed with null resultText (D-10)", async () => {
  const { job } = await drive("empty");
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, null);
});

test("noise -> completed, leading/trailing blanks trimmed (D-1)", async () => {
  const { job } = await drive("noise");
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "actual content");
});

test("ok -> inner blank lines PRESERVED (D-1 lossless)", async () => {
  const { job } = await drive("ok");
  assert.equal(job.resultText, "OK\n\nbody paragraph one.\n\nbody paragraph two.");
});

test("authStderr -> failed errorKind auth (D-3)", async () => {
  const { job } = await drive("authStderr");
  assert.equal(job.status, "failed");
  assert.equal(job.errorKind, "auth");
});

test("authStdout(exit0) -> failed (not silent success) (D-3)", async () => {
  const { job } = await drive("authStdout");
  assert.equal(job.status, "failed");
});

test("inv3 grandchild: timeout kill force-resolves to terminal", async () => {
  // short timeoutMs so the worker's kill+forceResolve fires (worker.mjs:177-189)
  const { job } = await drive("grandchild", { timeoutMs: 800 });
  assert.ok(["timed-out", "failed", "cancelled"].includes(job.status), `got ${job.status}`);
});

test("inv4 idempotent: two reads identical", async () => {
  const { sd, id } = await drive("ok");
  assert.deepEqual(readJob(sd, id), readJob(sd, id));
});
