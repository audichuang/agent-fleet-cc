// tests/shared/reconcile.test.mjs
import { test } from "node:test";
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
  lockFilePath,
  jobFilePath,
} from "../../shared/lib/core/state-store.mjs";
import {
  safePid,
  reconcileDeadPids,
} from "../../shared/lib/core/reconcile.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-rec-"));

test("safePid rejects group-kill footguns", () => {
  assert.equal(safePid(0), null);
  assert.equal(safePid(-1), null);
  assert.equal(safePid(1), null);
  assert.equal(safePid("12abc"), null);
  assert.equal(safePid("4242"), 4242);
  assert.equal(safePid(4242), 4242);
});

test("running job with dead pid is reconciled to failed via CAS", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  const reconciled = reconcileDeadPids(s, { isAlive: () => false });
  assert.deepEqual(reconciled, [j.id]);
  const final = readJob(s, j.id);
  assert.equal(final.status, "failed");
  assert.match(final.error, /reconciled dead pid/);
});

test("live worker is left alone", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: process.pid });
  assert.deepEqual(reconcileDeadPids(s, { isAlive: () => true }), []);
  assert.equal(readJob(s, j.id).status, "running");
});

test("claimed lock with dead finalizer converges JSON from lock content", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  // 模擬 finalizer 死於 claim 與寫 JSON 之間
  fs.writeFileSync(
    lockFilePath(s, j.id),
    JSON.stringify({ pid: 1, status: "cancelled" }),
    { mode: 0o600 },
  );
  const reconciled = reconcileDeadPids(s, { isAlive: () => false });
  assert.deepEqual(reconciled, [j.id]);
  assert.equal(readJob(s, j.id).status, "cancelled"); // 用 lock 的 intended status
});

test("terminal jobs are never touched", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  finalizeJob(s, j.id, { status: "completed" });
  assert.deepEqual(reconcileDeadPids(s, { isAlive: () => false }), []);
});

// Adversarial: lock-repair must not overwrite a winner's already-written terminal payload.
// Scenario: job is running+dead-pid, lock exists with status="cancelled" (json still
// non-terminal=running when listJobs runs). A concurrent finalizer wins CAS and writes
// completed JSON with resultText/sessionId between listJobs and the lock-repair re-read.
// The guard `if (TERMINAL_STATUSES.has(fresh.status)) continue` must fire.
// Mutation criterion: removing that guard causes reconcile to overwrite payload → test RED.
test("lock-repair does not overwrite winner's completed payload (stale snapshot race)", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });

  // Pre-write the lock with status="cancelled" — json is still non-terminal=running.
  // This puts reconcile into the lock-repair branch.
  fs.writeFileSync(
    lockFilePath(s, j.id),
    JSON.stringify({ pid: 1, status: "cancelled" }),
    { flag: "wx", mode: 0o600 },
  );

  // Confirm json is still non-terminal before reconcile.
  assert.equal(readJob(s, j.id).status, "running");

  // Use _hooks.beforeFreshRead to inject the race: winner finalizeJob writes completed
  // JSON with rich payload AFTER listJobs snapshot but BEFORE lock-repair re-reads JSON.
  const reconciled = reconcileDeadPids(s, {
    isAlive: () => false,
    _hooks: {
      beforeFreshRead(jobId) {
        if (jobId !== j.id) return;
        // Winner arrives and writes completed JSON with resultText/sessionId.
        // finalizeJob must succeed: lock already exists so we call writeJob directly
        // (the winner already claimed the lock — we simulate its writeJob step).
        writeJob(s, {
          ...readJob(s, j.id),
          status: "completed",
          resultText: "winner-result",
          sessionId: "sess-42",
        });
      },
    },
  });

  // reconcile must skip: fresh.status="completed" is terminal → guard fires.
  assert.deepEqual(reconciled, []);
  // Winner's payload must be intact — not overwritten by reconcile.
  const after = readJob(s, j.id);
  assert.equal(after.status, "completed");
  assert.equal(after.resultText, "winner-result");
  assert.equal(after.sessionId, "sess-42");
});

// Adversarial: lock-repair must not resurrect a half-pruned job.
// Scenario: job is running+dead-pid, lock exists (json still present when listJobs runs).
// Prune deletes job.json between listJobs and the lock-repair re-read.
// The guard `if (!fresh) continue` must fire — writeJsonAtomic must never be called.
// Mutation criterion: removing that guard causes writeJob to recreate job.json → test RED.
test("lock-repair does not resurrect half-pruned job (json deleted, lock still present)", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });

  // Pre-write lock so reconcile enters the lock-repair branch.
  fs.writeFileSync(
    lockFilePath(s, j.id),
    JSON.stringify({ pid: 1, status: "cancelled" }),
    { flag: "wx", mode: 0o600 },
  );

  // Confirm job.json still exists when lock is written (listJobs would return it).
  assert.notEqual(readJob(s, j.id), null);

  // Use _hooks.beforeFreshRead to inject prune's first step: delete job.json while
  // lock still present — exactly the mid-prune window.
  const reconciled = reconcileDeadPids(s, {
    isAlive: () => false,
    _hooks: {
      beforeFreshRead(jobId) {
        if (jobId !== j.id) return;
        // Prune step 1: unlink job.json (lock remains — this is the mid-prune window).
        fs.unlinkSync(jobFilePath(s, j.id));
      },
    },
  });

  // reconcile must skip: fresh=null → guard fires → writeJob never called.
  assert.deepEqual(reconciled, []); // nothing reconciled
  assert.equal(readJob(s, j.id), null); // job.json must not have been recreated
});

// Adversarial: garbage lock content (non-object JSON or unknown status) must yield
// { status: null } from readTerminalLock, and lock-repair must write status "failed"
// (the ?? "failed" fallback) without crashing.
test("garbage lock content: lock-repair writes status=failed via fallback", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  // Write garbage (a plain number is valid JSON but not an object with known status).
  fs.writeFileSync(lockFilePath(s, j.id), "12345", { mode: 0o600 });

  // reconcile: lock is truthy ({ status: null }), pid dead → should write status=failed.
  const reconciled = reconcileDeadPids(s, { isAlive: () => false });
  assert.deepEqual(reconciled, [j.id]);
  const after = readJob(s, j.id);
  assert.equal(after.status, "failed");
});
