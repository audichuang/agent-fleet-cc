import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  applyJobPatchIfActive,
  ensureTerminalSignal,
  resolveJobDoneFile,
  resolveJobFile,
  resolveStateFile,
  saveState,
  writeCompletionSignalFile,
  writeJobFile
} from "../../plugins/codex/scripts/lib/state.mjs";

// C5: a job's terminal side-effects (per-job record + state.json index + the <jobId>.done
// signal a Claude-side `until [ -f signalFile ]` loop blocks on) are written separately,
// so a finalizer that crashed — or an fs write that threw — after the per-job record but
// before its .done leaves a terminal job with NO signal: the waiter hangs forever and the
// watchdog, seeing the job already terminal, exits without writing it. ensureTerminalSignal
// writes the missing .done from the authoritative per-job record so the waiter is never
// stranded. It is SIGNAL-ONLY: it must not touch the state.json index (an upsert there routes
// through saveState→pruneJobs, which could evict + delete this terminal job's record + .done).

function readIndexJob(workspace, jobId) {
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  return state.jobs.find((job) => job.id === jobId) ?? null;
}

test("ensureTerminalSignal writes the missing .done from a terminal per-job record", () => {
  const workspace = makeTempDir();
  const jobId = "job-strand";
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage: "boom"
  });
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, jobId)), false, "precondition: no signal yet");

  const healed = ensureTerminalSignal(workspace, jobId);

  assert.equal(healed, true);
  const done = JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8"));
  assert.equal(done.status, "failed");
  assert.equal(done.reason, "boom", "the failure reason is carried from the record");
});

test("ensureTerminalSignal heals the signal WITHOUT deleting the job when the index is full of active jobs", () => {
  const workspace = makeTempDir();
  const jobId = "job-no-prune-delete";
  // A full index of active jobs zeroes the terminal-eviction budget. Repairing the signal
  // must NOT route through the index (upsertJob → saveState → pruneJobs), or saveState's
  // delete loop would evict this terminal job and DELETE its per-job record + .done — the
  // very source of truth the heal reads from.
  const activeJobs = Array.from({ length: 50 }, (_, i) => ({
    id: `active-${i}`,
    status: "running",
    phase: "running",
    pid: null
  }));
  saveState(workspace, { jobs: activeJobs });
  writeJobFile(workspace, jobId, { id: jobId, status: "completed", phase: "done", pid: null });

  const healed = ensureTerminalSignal(workspace, jobId);

  assert.equal(healed, true);
  assert.equal(
    fs.existsSync(resolveJobFile(workspace, jobId)),
    true,
    "the per-job record (source of truth) must survive the heal"
  );
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, jobId)), true, "the signal is written");
});

test("ensureTerminalSignal repairs only the signal — it does not touch the state.json index", () => {
  const workspace = makeTempDir();
  const jobId = "job-signal-only";
  saveState(workspace, { jobs: [{ id: "other", status: "running", phase: "running", pid: null }] });
  writeJobFile(workspace, jobId, { id: jobId, status: "completed", phase: "done", pid: null });
  const indexBefore = fs.readFileSync(resolveStateFile(workspace), "utf8");

  ensureTerminalSignal(workspace, jobId);

  assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8"), indexBefore, "the index is left untouched");
  assert.equal(readIndexJob(workspace, jobId), null, "the heal does not insert a (prune-prone) index row");
});

test("ensureTerminalSignal does not overwrite an existing .done (a caller's richer reason stands)", () => {
  const workspace = makeTempDir();
  const jobId = "job-has-signal";
  writeJobFile(workspace, jobId, { id: jobId, status: "failed", phase: "failed", pid: null, errorMessage: "minimal" });
  writeCompletionSignalFile(workspace, jobId, { status: "failed", reason: "detailed root cause" });

  const healed = ensureTerminalSignal(workspace, jobId);

  assert.equal(healed, false, "a present signal means the finalize landed — nothing to heal");
  assert.equal(JSON.parse(fs.readFileSync(resolveJobDoneFile(workspace, jobId), "utf8")).reason, "detailed root cause");
});

test("ensureTerminalSignal no-ops for a still-active (non-terminal) record", () => {
  const workspace = makeTempDir();
  const jobId = "job-active";
  writeJobFile(workspace, jobId, { id: jobId, status: "running", phase: "running", pid: null });

  assert.equal(ensureTerminalSignal(workspace, jobId), false);
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, jobId)), false, "an active job must not get a terminal signal");
});

test("applyJobPatchIfActive self-heals a stranded .done when it observes an already-terminal record", () => {
  const workspace = makeTempDir();
  const jobId = "job-late-finalizer";
  // A prior finalize wrote the terminal record but its .done tore. A later finalizer
  // (watchdog/cancel/reconcile) re-enters applyJobPatchIfActive and loses on the
  // active-state gate — it must still re-assert the missing signal before returning.
  writeJobFile(workspace, jobId, { id: jobId, status: "failed", phase: "failed", pid: null, errorMessage: "earlier failure" });
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, jobId)), false, "precondition: signal stranded");

  const result = applyJobPatchIfActive(workspace, jobId, () => ({ status: "failed", phase: "failed" }));

  assert.equal(result.applied, false, "the job is already terminal — no second terminal write");
  assert.equal(fs.existsSync(resolveJobDoneFile(workspace, jobId)), true, "the stranded signal is healed");
});
