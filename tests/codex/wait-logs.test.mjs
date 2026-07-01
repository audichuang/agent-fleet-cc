import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { resolveJobLogFile, saveState, writeJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { appendLogLine } from "../../plugins/codex/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function writeCompletedJob(workspace, jobId) {
  const logFile = resolveJobLogFile(workspace, jobId);
  appendLogLine(logFile, "first log line");
  appendLogLine(logFile, "final log line");
  const job = {
    id: jobId,
    workspaceRoot: workspace,
    sessionId: "S1",
    status: "completed",
    phase: "done",
    jobClass: "task",
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z"
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return { job, logFile };
}

function writeTerminalJob(workspace, jobId, status) {
  const logFile = resolveJobLogFile(workspace, jobId);
  appendLogLine(logFile, `log for ${jobId}`);
  const job = {
    id: jobId, workspaceRoot: workspace, sessionId: "S1", status, phase: status,
    jobClass: "task", logFile,
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: status === "running" || status === "queued" ? null : "2026-01-01T00:01:00.000Z",
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return job;
}
function writeRunningJob(workspace, jobId) { return writeTerminalJob(workspace, jobId, "running"); }

test("wait requires a job id and guides the user to list jobs first", () => {
  const workspace = makeTempDir();
  const result = run("node", [SCRIPT, "wait", `--cwd ${workspace} --json`], { cwd: workspace });

  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "error");
  assert.match(envelope.error, /wait.*requires a job id/i);
  // The other query commands (attach/logs/cancel) work with no id; wait can't, so the
  // error must at least point at how to find one instead of dead-ending.
  assert.match(envelope.error, /status/i);
});

// #4: printUsage advertised only `wait <job-id> [--json]`, but handleWait parses
// --timeout-ms / --poll-interval-ms and wait.md's argument-hint lists them — three
// sources disagreed. Usage must match what the command actually accepts.
test("usage lists wait's --timeout-ms / --poll-interval-ms flags (matches wait.md + handleWait)", () => {
  const result = run("node", [SCRIPT, "help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wait <job-id>[^\n]*--timeout-ms/);
  assert.match(result.stdout, /wait <job-id>[^\n]*--poll-interval-ms/);
});

test("wait accepts slash-command raw arguments and returns a single waited job snapshot", () => {
  const workspace = makeTempDir();
  const jobId = "task-wait-alias";
  writeCompletedJob(workspace, jobId);

  const result = run("node", [SCRIPT, "wait", `${jobId} --cwd ${workspace} --json`], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, jobId);
  assert.equal(payload.job.status, "completed");
  assert.equal(payload.waitTimedOut, false);
});

test("wait rejects extra job tokens and no-op --wait flag", () => {
  const workspace = makeTempDir();
  const jobId = "task-wait-strict";
  writeCompletedJob(workspace, jobId);

  for (const rawArgs of [
    `${jobId} extra --cwd ${workspace} --json`,
    `${jobId} --wait --cwd ${workspace} --json`,
    `${jobId} --bogus --cwd ${workspace} --json`,
  ]) {
    const result = run("node", [SCRIPT, "wait", rawArgs], { cwd: workspace });
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.status, "error");
    assert.match(envelope.error, /wait.*exactly one job id/i);
  }
});

test("logs accepts slash-command raw arguments and streams the same log as attach", () => {
  const workspace = makeTempDir();
  const jobId = "task-logs-alias";
  const { logFile } = writeCompletedJob(workspace, jobId);
  assert.equal(fs.existsSync(logFile), true);

  const result = run("node", [SCRIPT, "logs", `${jobId} --cwd ${workspace} --poll-interval-ms 0`], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /first log line/);
  assert.match(result.stdout, /final log line/);
});

// T1: wait exit codes
test("wait exits 0 for a completed job", () => {
  const workspace = makeTempDir();
  const job = writeTerminalJob(workspace, "codex-done-1", "completed");
  const result = run("node", [SCRIPT, "wait", `${job.id} --cwd ${workspace} --json`], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
});

test("wait exits 10 when it times out on a still-running job", () => {
  const workspace = makeTempDir();
  const job = writeRunningJob(workspace, "codex-run-1");
  const result = run("node", [SCRIPT, "wait", `${job.id} --cwd ${workspace} --timeout-ms 0 --json`], { cwd: workspace });
  assert.equal(result.status, 10, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.status, "running");
});

test("wait exits 1 for a failed job and 2 for a cancelled job", () => {
  const workspace = makeTempDir();
  const failed = writeTerminalJob(workspace, "codex-fail-1", "failed");
  const cancelled = writeTerminalJob(workspace, "codex-cancel-1", "cancelled");
  const r1 = run("node", [SCRIPT, "wait", `${failed.id} --cwd ${workspace} --json`], { cwd: workspace });
  const r2 = run("node", [SCRIPT, "wait", `${cancelled.id} --cwd ${workspace} --json`], { cwd: workspace });
  assert.equal(r1.status, 1, r1.stderr);
  assert.equal(r2.status, 2, r2.stderr);
});

// T2: --timeout-ms 0 returns immediately
test("wait --timeout-ms 0 returns immediately (does not fall back to default)", () => {
  const workspace = makeTempDir();
  const job = writeRunningJob(workspace, "codex-run-0");
  const started = Date.now();
  const result = run("node", [SCRIPT, "wait", `${job.id} --cwd ${workspace} --timeout-ms 0 --json`], { cwd: workspace });
  assert.equal(result.status, 10, result.stderr);
  assert.ok(Date.now() - started < 4000, "must not block for the 240s default");
});

// T7: logs with no id prints latest persisted log when none is live
test("logs with no job id prints the latest job's persisted log even when finished", () => {
  const workspace = makeTempDir();
  writeCompletedJob(workspace, "codex-done-logs");
  const result = run("node", [SCRIPT, "logs", `--cwd ${workspace}`], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /final log line/);
});
