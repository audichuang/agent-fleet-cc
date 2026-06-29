// Phase 1A / Gap-2 Option A: live progress (phase/threadId/turnId) lives in
// events.ndjson, not the job record. The display surfaces (status/result) must
// overlay it, or a live job shows its stale initial phase:"starting" and no
// resume-hint threadId. Regression guard for the Codex CR blocker on 1c-ii-a.

import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir, writeJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { appendProgressEvent } from "../../plugins/codex/scripts/lib/codex-progress.mjs";
import { buildStatusSnapshot, resolveResultJob } from "../../plugins/codex/scripts/lib/job-control.mjs";

function seedRecord(workspace, id, overrides) {
  writeJobFile(workspace, id, {
    id,
    status: "running",
    phase: "starting",
    pid: process.pid,
    jobClass: "task",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  });
}

test("status overlays the live phase + turn identity from events for an active job", () => {
  const workspace = makeTempDir();
  // Record keeps its initial phase:"starting" with no threadId (Option A).
  seedRecord(workspace, "job-live");
  appendProgressEvent(resolveStateDir(workspace), "job-live", { phase: "investigating", threadId: "th-9" });
  appendProgressEvent(resolveStateDir(workspace), "job-live", { turnId: "tn-9" });

  const snapshot = buildStatusSnapshot(workspace);
  const live = snapshot.running.find((job) => job.id === "job-live");
  assert.ok(live, "the active job is listed");
  assert.equal(live.phase, "investigating", "live phase comes from events, not the stale record");
  assert.equal(live.threadId, "th-9", "threadId is overlaid from events");
  assert.equal(live.turnId, "tn-9", "turnId is overlaid from events");
});

test("result overlays the resume-hint thread id from events for a finished job", () => {
  const workspace = makeTempDir();
  seedRecord(workspace, "job-done", { status: "completed", phase: "done", pid: null, completedAt: "2026-01-01T00:01:00.000Z" });
  appendProgressEvent(resolveStateDir(workspace), "job-done", { threadId: "th-done", turnId: "tn-done" });

  const { job } = resolveResultJob(workspace, "job-done");
  assert.equal(job.status, "completed");
  assert.equal(job.threadId, "th-done", "resume-hint threadId is overlaid from events onto the terminal job");
  assert.equal(job.turnId, "tn-done");
});
