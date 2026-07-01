/**
 * Worker timeout wiring (shared runtime). A hung `agy --print` must be bounded:
 *  - agy's own `--print-timeout` is forwarded explicitly (no reliance on its
 *    hidden 5m default) — asserted on the adapter's buildInvocation argv, and
 *  - the shared worker's Node-side hard backstop (job.timeoutMs) kills a wedged
 *    agy that ignores its own timeout, finalizing the job `timed-out`.
 *
 * resolveAgyTimeouts moved to lib/adapter.mjs and is unit-tested there
 * (adapter.test.mjs). This suite drives the real shared worker + fake-agy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeAntigravityAdapter } from "../../plugins/antigravity/scripts/lib/adapter.mjs";
import { createJobRecord } from "../../plugins/antigravity/scripts/lib/shared/core/job.mjs";
import { createJob, readJob } from "../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs";
import { runWorker } from "../../plugins/antigravity/scripts/lib/shared/runtime/worker.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agy.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agy-timeout-"));

test("buildInvocation forwards --print-timeout as a Go duration", () => {
  const a = makeAntigravityAdapter({ env: {} });
  const { argv } = a.buildInvocation({
    job: { request: { mode: "print", printTimeoutMs: 30000 } },
    prompt: "hi",
  });
  const ti = argv.indexOf("--print-timeout");
  assert.ok(ti >= 0, "--print-timeout present");
  assert.equal(argv[ti + 1], "30s");
});

test("hard backstop: a hung agy is killed and finalized timed-out", async () => {
  const sd = tmp();
  // job.timeoutMs is the worker's hard backstop timer (worker.mjs:177). Use a
  // short one so the fake `hang` mode (never exits) is force-terminated.
  const rec = createJobRecord({ engine: "antigravity", timeoutMs: 400, request: { mode: "print" } });
  createJob(sd, rec, "hang please");
  const base = makeAntigravityAdapter();
  const adapter = {
    ...base,
    buildInvocation: ({ prompt }) => ({
      argv: [process.execPath, FAKE, "--print", prompt],
      env: { FAKE_AGY_MODE: "hang" },
      stdinPayload: "",
    }),
  };
  await runWorker({ stateDir: sd, jobId: rec.id, adapter, deps: { graceMs: 150 } });
  const job = readJob(sd, rec.id);
  assert.equal(job.status, "timed-out");
});
