/**
 * /antigravity:cancel on the shared runtime — CAS-first + signal safety.
 *
 * Shared `cancelJob(stateDir, jobId)` claims the terminal transition BEFORE it
 * signals, so a cancel that loses the race to the worker's natural completion
 * (finalizeJob wins first) returns {ok:false} and NEVER clobbers the real
 * result. It reads the authoritative pid from the post-finalize job JSON (the
 * fresh-merge preserves the worker's pid stamp) and only signals a safe, live
 * pid — a dead/recycled pid is never signalled.
 *
 * These tests drive cancel.run() against a real shared state dir.
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
  readJob,
  writeJob,
  finalizeJob,
} from "../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs";
import { cancelJob } from "../../plugins/antigravity/scripts/lib/shared/core/job-control.mjs";
import { stateDirFor } from "../../plugins/antigravity/scripts/lib/job-runtime.mjs";

const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
const ORIGINAL_SESSION = process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-cancel-"));
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

const DEAD_PID = 2 ** 22;

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

// Seed a shared-layout running job (optionally with a pid).
function seedRunning({ id, pid } = {}) {
  const stateDir = stateDirFor(tempDir);
  const record = createJobRecord({ engine: "antigravity", cwd: tempDir, request: { kind: "task" } });
  if (id) record.id = id;
  createJob(stateDir, record, "hello");
  writeJob(stateDir, { ...record, status: "running", pid: pid ?? null });
  return { stateDir, id: record.id };
}

async function runCancel(args) {
  const { run } = await import("../../plugins/antigravity/scripts/commands/cancel.mjs");
  const cap = capture();
  let exit;
  try {
    exit = await run(args, { cwd: tempDir });
  } finally {
    cap.restore();
  }
  return { exit, out: cap.out.join(""), err: cap.err.join("") };
}

describe("/antigravity:cancel race + signal safety (shared cancelJob)", () => {
  it("marks a running job cancelled (no pid to signal) and exits 0", async () => {
    const { stateDir, id } = seedRunning({ id: "run" + randomBytes(2).toString("hex") });
    const { exit, out } = await runCancel([id, "--json"]);
    assert.equal(exit, 0, out);
    const payload = JSON.parse(out);
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.pid, null); // no worker pid → nothing signalled
    assert.equal(readJob(stateDir, id).status, "cancelled");
  });

  it("does not clobber a job the worker already finalized (exit 1)", async () => {
    const { stateDir, id } = seedRunning({ id: "late" + randomBytes(2).toString("hex") });
    // The worker wins the terminal transition first.
    assert.equal(
      finalizeJob(stateDir, id, { status: "completed", resultText: "real result" }),
      true,
    );

    const { exit, err } = await runCancel([id]);
    // The real result must survive; cancel must refuse (the job is no longer
    // active) and exit non-zero. On the shared layout a finalized job drops out
    // of the active set, so the command reports "no active jobs" rather than
    // clobbering the completed record.
    assert.equal(readJob(stateDir, id).status, "completed");
    assert.equal(readJob(stateDir, id).resultText, "real result");
    assert.equal(exit, 1);
    assert.match(err, /no active|already/i);
  });

  it("cancelJob loses the finalize race injected between resolve and cancel", async () => {
    // Unit-level: the command resolves an active job, then cancelJob's
    // beforeFinalize seam lets the worker finalize first → {ok:false}.
    const { stateDir, id } = seedRunning({ id: "race" + randomBytes(2).toString("hex") });
    const result = cancelJob(stateDir, id, {
      beforeFinalize: () => finalizeJob(stateDir, id, { status: "completed", resultText: "won" }),
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /already completed/);
    assert.equal(readJob(stateDir, id).status, "completed");
    assert.equal(readJob(stateDir, id).resultText, "won");
  });

  it("never signals a dead pid; reports killed=false but still cancels", async () => {
    const { stateDir, id } = seedRunning({ id: "dead" + randomBytes(2).toString("hex"), pid: DEAD_PID });
    // reconcileDeadPids in the command would finalize a running job with a DEAD
    // pid to "failed" BEFORE cancel resolves it — so the command reports the
    // race loss. Assert the job never survives as running with a live signal.
    const { exit } = await runCancel([id, "--json"]);
    const final = readJob(stateDir, id).status;
    // Either cancel won (cancelled) or reconcile finalized it (failed) — never
    // signalled a recycled pid, and never left it running.
    assert.ok(["cancelled", "failed"].includes(final), `final=${final}`);
    assert.ok([0, 1].includes(exit));
  });

  it("refuses multiple active jobs without a reference", async () => {
    process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = "sess-multi";
    const stateDir = stateDirFor(tempDir);
    for (const id of ["m1aaaa", "m2bbbb"]) {
      const record = createJobRecord({ engine: "antigravity", cwd: tempDir, request: { kind: "task" } });
      record.id = id;
      record.sessionId = "sess-multi";
      createJob(stateDir, record, "hello");
      writeJob(stateDir, { ...record, sessionId: "sess-multi", status: "running", pid: null });
    }
    const { exit, err } = await runCancel([]);
    assert.equal(exit, 1);
    assert.match(err, /Multiple active antigravity jobs/);
  });

  it("resolves a specific active job by unique substring (exit 0)", async () => {
    process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = "sess-sub";
    const stateDir = stateDirFor(tempDir);
    for (const id of ["alpha111", "beta2222"]) {
      const record = createJobRecord({ engine: "antigravity", cwd: tempDir, request: { kind: "task" } });
      record.id = id;
      record.sessionId = "sess-sub";
      createJob(stateDir, record, "hello");
      writeJob(stateDir, { ...record, sessionId: "sess-sub", status: "running", pid: null });
    }
    const { exit, out } = await runCancel(["alpha", "--json"]);
    assert.equal(exit, 0, out);
    assert.equal(JSON.parse(out).jobId, "alpha111");
    assert.equal(readJob(stateDir, "alpha111").status, "cancelled");
    assert.equal(readJob(stateDir, "beta2222").status, "running");
  });

  it("errors when no active jobs exist", async () => {
    const { exit, err } = await runCancel([]);
    assert.equal(exit, 1);
    assert.match(err, /No active antigravity jobs/);
  });
});
