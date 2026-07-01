/**
 * /antigravity:wait exit-code contract, locked against the shared runtime.
 *
 * `waitForJob` returns `{done, job}`:
 *   - done:true  + terminal job  → the job reached a terminal state
 *   - done:false + active  job   → the wait DEADLINE elapsed (job still active)
 *   - done:true  + job:null      → the job is missing/pruned
 *
 * The four exit codes are load-bearing and the distinctions are subtle, so this
 * suite drives wait.run() end-to-end against a real shared state dir:
 *   0  completed
 *   2  cancelled
 *   1  failed / timed-out (terminal) / missing
 *   10 wait deadline exceeded before terminal state
 *
 * The critical distinction: a job finalized `timed-out` is TERMINAL → exit 1
 * (NOT 10); only the wait deadline (done:false) yields 10.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { createJobRecord } from "../../plugins/antigravity/scripts/lib/shared/core/job.mjs";
import {
  createJob,
  finalizeJob,
  writeJob,
} from "../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs";
import { stateDirFor } from "../../plugins/antigravity/scripts/lib/job-runtime.mjs";

const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
const ORIGINAL_SESSION = process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-wait-"));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
  if (ORIGINAL_SESSION === undefined) delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  else process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = ORIGINAL_SESSION;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function capture() {
  const out = [];
  const err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => (out.push(String(c)), true);
  process.stderr.write = (c) => (err.push(String(c)), true);
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = o;
      process.stderr.write = e;
    },
  };
}

// Seed a shared-layout job in the terminal status given (or leave it active).
function seed({ id, status, resultText, pid } = {}) {
  const stateDir = stateDirFor(tempDir);
  const record = createJobRecord({ engine: "antigravity", cwd: tempDir, request: { kind: "task" } });
  if (id) record.id = id;
  createJob(stateDir, record, "hello");
  if (status === "running" || status === "queued") {
    // A running job with NO pid is skipped by reconcile (never auto-failed),
    // so it stays active and the wait deadline can fire → exit 10.
    writeJob(stateDir, { ...record, status, pid: pid ?? null });
  } else if (status) {
    const patch = { status };
    if (resultText != null) patch.resultText = resultText;
    finalizeJob(stateDir, record.id, patch);
  }
  return { stateDir, id: record.id };
}

async function runWait(args) {
  const { run } = await import("../../plugins/antigravity/scripts/commands/wait.mjs");
  const cap = capture();
  let exit;
  try {
    exit = await run(args, { cwd: tempDir });
  } finally {
    cap.restore();
  }
  return { exit, out: cap.out.join(""), err: cap.err.join("") };
}

describe("/antigravity:wait exit-code contract (0/2/1/10)", () => {
  it("completed → exit 0", async () => {
    const { id } = seed({ status: "completed", resultText: "done" });
    const { exit, out } = await runWait([id, "--json"]);
    assert.equal(exit, 0);
    const payload = JSON.parse(out);
    assert.equal(payload.status, "completed");
    assert.equal(payload.timedOut, false);
  });

  it("cancelled → exit 2", async () => {
    const { id } = seed({ status: "cancelled" });
    const { exit, out } = await runWait([id, "--json"]);
    assert.equal(exit, 2);
    assert.equal(JSON.parse(out).status, "cancelled");
  });

  it("failed (terminal) → exit 1", async () => {
    const { id } = seed({ status: "failed" });
    const { exit } = await runWait([id, "--json"]);
    assert.equal(exit, 1);
  });

  it("timed-out (terminal) → exit 1, NOT 10 (done:true, not a deadline)", async () => {
    const { id } = seed({ status: "timed-out" });
    const { exit, out } = await runWait([id, "--json"]);
    assert.equal(exit, 1);
    const payload = JSON.parse(out);
    assert.equal(payload.status, "timed-out");
    // done:true → not a wait-deadline; timedOut reflects the deadline, not status.
    assert.equal(payload.timedOut, false);
  });

  it("wait DEADLINE on an active job → exit 10 (done:false)", async () => {
    const { id } = seed({ status: "running" });
    // timeout-ms 0 → the deadline is already reached on the first poll, so the
    // wait returns {done:false} WITHOUT parking on a timer (a timer tick under
    // the global stdout capture would let the test-runner IPC leak into cap.out).
    const { exit, out } = await runWait([id, "--timeout-ms", "0", "--json"]);
    assert.equal(exit, 10);
    const payload = JSON.parse(out);
    assert.equal(payload.status, "running");
    assert.equal(payload.timedOut, true);
  });

  it("missing/pruned job → exit 1 (no null deref)", async () => {
    // No seed for this id: waitForJob would return {done:true, job:null}, but
    // the readJob pre-check short-circuits to exit 1 first.
    const { exit, err } = await runWait(["does-not-exist", "--json"]);
    assert.equal(exit, 1);
    assert.match(err, /antigravity:wait/);
    assert.match(err, /no job found/i);
  });

  it("no reference → exit 1 with a hint", async () => {
    const { exit, err } = await runWait([]);
    assert.equal(exit, 1);
    assert.match(err, /job id required/);
  });

  it("rejects invalid / missing --timeout-ms values", async () => {
    const { id } = seed({ status: "completed" });
    for (const args of [
      [id, "--timeout-ms", "abc"],
      [id, "--timeout-ms"],
      [id, "--timeout-ms", "-1"],
      [id, "--timeout-ms=-1"],
    ]) {
      const { exit, err } = await runWait(args);
      assert.equal(exit, 1, `args=${JSON.stringify(args)}`);
      assert.match(err, /--timeout-ms/);
    }
  });
});
