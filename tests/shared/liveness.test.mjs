// tests/shared/liveness.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  projectLiveness,
  collectLiveness,
  countWorkingTreeChanges,
  formatLiveness,
  SNIPPET_MAX,
} from "../../shared/lib/core/liveness.mjs";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { createJob, jobDir } from "../../shared/lib/core/state-store.mjs";
import { appendEvent } from "../../shared/lib/core/events.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-liveness-"));

const T0 = Date.parse("2026-07-14T00:00:00.000Z"); // createdAt
const T_SPAWN = Date.parse("2026-07-14T00:00:10.000Z"); // spawned (+10s)
const NOW = Date.parse("2026-07-14T00:05:00.000Z"); // +5m from createdAt

const iso = (ms) => new Date(ms).toISOString();
const runningJob = (over = {}) => ({
  status: "running",
  createdAt: iso(T0),
  pid: 4321,
  cwd: "/repo",
  ...over,
});
const ev = (type, ts, over = {}) => ({ type, ts: iso(ts), ...over });

test("active run: alive, elapsed from spawned, last activity from newest text", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [
      ev("job-created", T0),
      ev("spawned", T_SPAWN),
      ev("engine-event", T_SPAWN + 1000, { kind: "text", text: "planning" }),
      ev("engine-event", NOW - 12000, { kind: "text", text: "editing src/foo.ts" }),
    ],
    terminalLockStatus: null,
    workerAlive: true,
    workingTreeChanges: 3,
    nowMs: NOW,
  });
  assert.equal(p.status, "running");
  assert.equal(p.alive, true);
  assert.equal(p.elapsedOrigin, "spawned");
  assert.equal(p.elapsedMs, NOW - T_SPAWN); // 4m50s
  assert.equal(p.lastActivity.text, "editing src/foo.ts");
  assert.equal(p.quietMs, 12000);
  assert.equal(p.workingTreeChanges, 3);
});

test("terminal lock wins over a stale active job.json", () => {
  const p = projectLiveness({
    job: runningJob(), // says running
    events: [ev("spawned", T_SPAWN)],
    terminalLockStatus: "completed", // finalizer already claimed terminal
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.status, "completed");
  assert.equal(p.alive, null, "alive is not meaningful once terminal");
});

test("non-terminal lock status is ignored (readTerminalLock returns null status)", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [ev("spawned", T_SPAWN)],
    terminalLockStatus: null,
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.status, "running");
});

test("alive is null for a queued job with no worker pid yet (not 'dead')", () => {
  const p = projectLiveness({
    job: runningJob({ status: "queued", pid: null }),
    events: [ev("job-created", T0)],
    workerAlive: null, // collector passes null when there's no valid pid
    nowMs: NOW,
  });
  assert.equal(p.status, "queued");
  assert.equal(p.alive, null);
});

test("alive false while active reads as worker gone", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [ev("spawned", T_SPAWN)],
    workerAlive: false,
    nowMs: NOW,
  });
  assert.equal(p.alive, false);
});

test("alive but quiet: large quietMs is not a failure", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [ev("spawned", T_SPAWN), ev("engine-event", T_SPAWN, { kind: "text", text: "thinking" })],
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.status, "running");
  assert.equal(p.alive, true);
  assert.ok(p.quietMs > 4 * 60 * 1000, "quiet for minutes");
});

test("no spawned event → elapsed falls back to createdAt and is flagged", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [ev("job-created", T0)],
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.elapsedOrigin, "createdAt");
  assert.equal(p.elapsedMs, NOW - T0); // 5m — includes queued time
});

test("empty event log → lastActivity null, quietMs null, elapsed from createdAt", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [],
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.lastActivity, null);
  assert.equal(p.quietMs, null);
  assert.equal(p.elapsedOrigin, "createdAt");
});

test("backward scan skips blank paragraph-break lines (antigravity)", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [
      ev("spawned", T_SPAWN),
      ev("engine-event", T_SPAWN + 1000, { kind: "line", text: "wrote the handler" }),
      ev("engine-event", T_SPAWN + 2000, { kind: "line", text: "" }),
      ev("engine-event", T_SPAWN + 3000, { kind: "line", text: "   " }),
    ],
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.lastActivity.text, "wrote the handler");
});

test("grok end/error events without .text do not throw and are skipped", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [
      ev("spawned", T_SPAWN),
      ev("engine-event", T_SPAWN + 1000, { kind: "text", text: "the answer" }),
      ev("engine-event", T_SPAWN + 2000, { kind: "end", sessionId: "s1" }), // no text
      ev("engine-event", T_SPAWN + 3000, { kind: "error", message: "boom" }), // no text
    ],
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.lastActivity.text, "the answer");
});

test("structured mode (no text event yet) → lastActivity null", () => {
  const p = projectLiveness({
    job: runningJob(),
    events: [ev("spawned", T_SPAWN)],
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.lastActivity, null);
});

test("invalid timestamps → elapsedMs null, elapsedOrigin null, quietMs null", () => {
  const p = projectLiveness({
    job: runningJob({ createdAt: "not-a-date" }),
    events: [ev("engine-event", T_SPAWN, { kind: "text", text: "x" })].map((e) => ({ ...e, ts: "garbage" })),
    workerAlive: true,
    nowMs: NOW,
  });
  assert.equal(p.elapsedMs, null);
  assert.equal(p.elapsedOrigin, null);
  assert.equal(p.quietMs, null);
});

test("last activity is trimmed and truncated to SNIPPET_MAX", () => {
  const long = "x".repeat(200);
  const p = projectLiveness({
    job: runningJob(),
    events: [ev("engine-event", T_SPAWN, { kind: "text", text: `   ${long}   ` })],
    workerAlive: true,
    nowMs: NOW,
  });
  assert.ok(p.lastActivity.text.length <= SNIPPET_MAX);
  assert.ok(p.lastActivity.text.endsWith("…"));
});

test("workingTreeChanges passes through, non-number → null", () => {
  const base = { job: runningJob(), events: [ev("spawned", T_SPAWN)], workerAlive: true, nowMs: NOW };
  assert.equal(projectLiveness({ ...base, workingTreeChanges: 0 }).workingTreeChanges, 0);
  assert.equal(projectLiveness({ ...base, workingTreeChanges: 7 }).workingTreeChanges, 7);
  assert.equal(projectLiveness({ ...base, workingTreeChanges: null }).workingTreeChanges, null);
  assert.equal(projectLiveness({ ...base, workingTreeChanges: undefined }).workingTreeChanges, null);
});

test("projectLiveness throws without a job record", () => {
  assert.throws(() => projectLiveness({ job: null, nowMs: NOW }), /requires a job record/);
});

test("countWorkingTreeChanges: porcelain lines counted, empty → 0, failure → null", () => {
  const fake = (stdout, status = 0, error = null) => () => ({ stdout, status, error });
  assert.equal(
    countWorkingTreeChanges("/repo", { spawnImpl: fake(" M a.js\n?? b.js\n M c.js\n") }),
    3,
  );
  assert.equal(countWorkingTreeChanges("/repo", { spawnImpl: fake("") }), 0);
  assert.equal(countWorkingTreeChanges("/repo", { spawnImpl: fake("", 128) }), null); // not a repo
  assert.equal(
    countWorkingTreeChanges("/repo", { spawnImpl: () => ({ error: new Error("ENOENT") }) }),
    null,
  );
  assert.equal(countWorkingTreeChanges(null, { spawnImpl: fake("x") }), null);
});

test("collectLiveness reads a real job dir and folds with injected deps", () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "grok", title: "t", cwd: "/repo", now: new Date(T0) });
  record.pid = 4321;
  createJob(stateDir, record, "prompt");
  appendEvent(jobDir(stateDir, record.id), "spawned", { pid: 4321 });
  appendEvent(jobDir(stateDir, record.id), "engine-event", { kind: "text", text: "working" });

  const p = collectLiveness(stateDir, record.id, {
    isAlive: () => true,
    gitChanges: () => 5,
    nowMs: NOW,
  });
  assert.equal(p.alive, true);
  assert.equal(p.workingTreeChanges, 5);
  assert.equal(p.lastActivity.text, "working");
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("collectLiveness returns null for an unknown job", () => {
  assert.equal(collectLiveness(tmp(), "nope-123", { nowMs: NOW }), null);
});

test("formatLiveness renders a compact line with the key signals", () => {
  const line = formatLiveness({
    status: "running",
    alive: true,
    elapsedMs: 290000,
    elapsedOrigin: "spawned",
    quietMs: 12000,
    lastActivity: { text: "editing src/foo.ts", ts: iso(NOW) },
    workingTreeChanges: 3,
  });
  assert.match(line, /alive✓/);
  assert.match(line, /⏱4m50s/);
  assert.match(line, /editing src\/foo\.ts/);
  assert.match(line, /Δwt: 3/);
});

test("formatLiveness: null activity while active shows a generic fallback, createdAt flagged approximate", () => {
  const line = formatLiveness({
    status: "running",
    alive: null,
    elapsedMs: 300000,
    elapsedOrigin: "createdAt",
    quietMs: null,
    lastActivity: null,
    workingTreeChanges: null,
  });
  assert.match(line, /starting/);
  assert.match(line, /⏱~5m0s/); // ~ flags queued-time-included
  assert.match(line, /no output yet/);
  assert.doesNotMatch(line, /Δwt/);
});
