// Black-box e2e: drives the REAL codex-companion.mjs CLI as a subprocess.
// Covers the review-found wait/logs contract bugs (T1/T2/T7).

import "./helpers.mjs"; // hermetic CLAUDE_PLUGIN_DATA/HOME isolation
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveJobLogFile, saveState, writeJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { appendLogLine } from "../../plugins/codex/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function ws() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-e2e-"));
}

function cli(cwd, args, timeout = 15000) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout,
  });
}

function seedJob(cwd, id, status, line) {
  const logFile = resolveJobLogFile(cwd, id);
  appendLogLine(logFile, line ?? `log ${id}`);
  const terminal = !(status === "running" || status === "queued");
  const job = {
    id,
    workspaceRoot: cwd,
    sessionId: "S1",
    status,
    phase: status,
    jobClass: "task",
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: terminal ? "2026-01-01T00:01:00.000Z" : null,
  };
  writeJobFile(cwd, id, job);
  saveState(cwd, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return job;
}

test("e2e: codex wait exits 0 for completed job", () => {
  const cwd = ws();
  seedJob(cwd, "codex-c", "completed");
  const res = cli(cwd, ["wait", "codex-c", "--cwd", cwd, "--json"]);
  assert.equal(res.status, 0, res.stderr);
});

test("e2e: codex wait exits 1 for failed job", () => {
  const cwd = ws();
  seedJob(cwd, "codex-f", "failed");
  const res = cli(cwd, ["wait", "codex-f", "--cwd", cwd, "--json"]);
  assert.equal(res.status, 1, res.stderr);
});

test("e2e: codex wait exits 2 for cancelled job", () => {
  const cwd = ws();
  seedJob(cwd, "codex-x", "cancelled");
  const res = cli(cwd, ["wait", "codex-x", "--cwd", cwd, "--json"]);
  assert.equal(res.status, 2, res.stderr);
});

test("e2e: codex wait exits 10 promptly with --timeout-ms 0 on a running job", () => {
  const cwd = ws();
  seedJob(cwd, "codex-r", "running");
  const t0 = Date.now();
  const res = cli(cwd, ["wait", "codex-r", "--cwd", cwd, "--timeout-ms", "0", "--json"]);
  assert.equal(res.status, 10, res.stderr);
  assert.ok(Date.now() - t0 < 5000, "timeout-ms 0 must not block for the default");
});

test("e2e: codex logs with no id prints the latest finished job's persisted log", () => {
  const cwd = ws();
  seedJob(cwd, "codex-done", "completed", "FINAL_LINE_MARKER");
  const res = cli(cwd, ["logs", "--cwd", cwd]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /FINAL_LINE_MARKER/);
});
