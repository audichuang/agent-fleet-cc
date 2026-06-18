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

test("wait requires a job id", () => {
  const workspace = makeTempDir();
  const result = run("node", [SCRIPT, "wait", `--cwd ${workspace} --json`], { cwd: workspace });

  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "error");
  assert.match(envelope.error, /wait.*requires a job id/i);
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
