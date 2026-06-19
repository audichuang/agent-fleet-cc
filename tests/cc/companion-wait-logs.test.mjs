import { makeDataRoot, makeTempDir, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runCompanion } from "../../plugins/cc/scripts/cc-companion.mjs";
import {
  listJobs,
  readJob,
} from "../../plugins/cc/scripts/lib/shared/core/state-store.mjs";
import { TERMINAL_STATUSES } from "../../plugins/cc/scripts/lib/shared/core/job.mjs";
import { isPidAlive } from "../../plugins/cc/scripts/lib/shared/core/reconcile.mjs";
import { workspaceStateDir } from "../../plugins/cc/scripts/lib/adapter.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

const fakeSpawn =
  (mode) =>
  (_b, _a, options) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });

function setup() {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("cc-ws-");
  writeProfile(dataRoot, "kimi", { env: { ANTHROPIC_BASE_URL: "https://cheap" } });
  const out = [];
  const deps = {
    env: { CC_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
    cwd,
    out: (line) => out.push(line),
    claudeSpawnImpl: fakeSpawn("success"),
  };
  return { dataRoot, cwd, out, deps, stateDir: workspaceStateDir(dataRoot, cwd) };
}

// Helper: wait until job reaches a terminal state (polling with deadline)
async function waitForTerminal(stateDir, jobId, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const job = readJob(stateDir, jobId);
    if (job && TERMINAL_STATUSES.has(job.status)) return job;
    await sleep(50);
  }
  throw new Error(`job ${jobId} not terminal within ${deadlineMs}ms`);
}

// Helper: build a real e2e shim for tests that need a detached worker
function setupE2E(mode = "success") {
  const { dataRoot, cwd, out, deps, stateDir } = setup();
  const binDir = makeTempDir("cc-bin-");
  const shim = path.join(binDir, "fake-claude");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`,
    { mode: 0o755 },
  );
  deps.env = {
    ...deps.env,
    CC_CLAUDE_BIN: shim,
    FAKE_CLAUDE_MODE: mode,
  };
  delete deps.workerSpawnImpl; // use real spawn
  return { dataRoot, cwd, out, deps, stateDir };
}

test("wait blocks until terminal state and exits 0; --json emits result projection", async () => {
  const { deps, stateDir } = setupE2E("success");

  // Start a background job using real detached worker
  const launchCode = await runCompanion(
    ["task", "say hi", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(launchCode, 0);

  const jobId = listJobs(stateDir)[0].id;

  // Collect wait output
  const waitOut = [];
  const waitDeps = { ...deps, out: (line) => waitOut.push(line) };

  // wait with --json: should block until terminal, exit 0
  const waitCode = await runCompanion(
    ["wait", jobId, "--timeout-s", "30", "--json"],
    waitDeps,
  );
  assert.equal(waitCode, 0, "wait should exit 0 when job completes");

  // Output should be valid JSON with status=completed
  const payload = JSON.parse(waitOut.join("\n"));
  assert.equal(payload.status, "completed", "payload.status should be completed");
  assert.equal(payload.engine, "cc");
  assert.ok("jobId" in payload);
  assert.ok("resultText" in payload);
});

test("wait on a still-running job with tiny timeout exits 10 and reports running", async () => {
  const { deps, stateDir } = setupE2E("hang");

  const pidFile = path.join(makeTempDir("cc-pid-"), "claude.pid");
  deps.env = { ...deps.env, FAKE_CLAUDE_PIDFILE: pidFile };

  // Start background hanging job
  const launchCode = await runCompanion(
    ["task", "hang forever", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(launchCode, 0);

  const jobId = listJobs(stateDir)[0].id;

  // Wait for job to reach running state
  const upDeadline = Date.now() + 10_000;
  while (Date.now() < upDeadline) {
    const j = readJob(stateDir, jobId);
    if (j && j.status === "running") break;
    await sleep(50);
  }

  // wait with tiny timeout should exit 10 (WAIT_TIMEOUT_EXIT)
  const waitOut = [];
  const waitDeps = { ...deps, out: (line) => waitOut.push(line) };
  const waitCode = await runCompanion(
    ["wait", jobId, "--timeout-s", "1", "--json"],
    waitDeps,
  );
  assert.equal(waitCode, 10, "timed-out wait should exit 10");

  // The output should contain status info (running or timed-out)
  const payload = JSON.parse(waitOut.join("\n"));
  assert.ok(
    payload.status === "running" || payload.status === "queued",
    `expected running/queued, got: ${payload.status}`,
  );

  // Clean up: cancel the job
  await runCompanion(["cancel", jobId], deps);

  // Wait for the hanging claude to die
  if (fs.existsSync(pidFile)) {
    const claudePid = Number(fs.readFileSync(pidFile, "utf8"));
    if (claudePid > 1) {
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline && isPidAlive(claudePid)) {
        await sleep(50);
      }
    }
  }
});

test("wait streams event heartbeats to stdout while blocking (non-json)", async () => {
  const { deps, stateDir } = setupE2E("success");

  // Start background job
  const launchCode = await runCompanion(
    ["task", "stream test", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(launchCode, 0);

  const jobId = listJobs(stateDir)[0].id;

  // wait WITHOUT --json: should stream heartbeats to out
  const heartbeats = [];
  const waitDeps = { ...deps, out: (line) => heartbeats.push(line) };
  const waitCode = await runCompanion(
    ["wait", jobId, "--timeout-s", "30"],
    waitDeps,
  );
  assert.equal(waitCode, 0, "wait should exit 0 when job completes");

  // In non-json mode, we should have at least one heartbeat line from onEvent
  // AND the final renderResult output — heartbeats have format [ts] type
  const heartbeatLines = heartbeats.filter((l) => l.startsWith("["));
  assert.ok(
    heartbeatLines.length >= 1,
    `expected at least 1 heartbeat line, got: ${JSON.stringify(heartbeats)}`,
  );
});

test("logs prints events.ndjson tail; --follow follows to terminal then exits", async () => {
  const { deps, stateDir } = setupE2E("success");

  // Start a foreground job to completion (uses real worker inline)
  const launchCode = await runCompanion(
    ["task", "log test", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(launchCode, 0);

  const jobId = listJobs(stateDir)[0].id;

  // Wait for job to complete
  await waitForTerminal(stateDir, jobId, 15_000);

  // logs <jobId>: should print event lines as JSON
  const logsOut = [];
  const logsDeps = { ...deps, out: (line) => logsOut.push(line) };
  const logsCode = await runCompanion(["logs", jobId], logsDeps);
  assert.equal(logsCode, 0, "logs should exit 0");

  // Each output line should be valid JSON with a 'type' field
  assert.ok(logsOut.length >= 1, "expected at least one event line");
  for (const line of logsOut) {
    const evt = JSON.parse(line);
    assert.ok("type" in evt, `event line missing type: ${line}`);
  }

  // Should include the full canonical event sequence for a completed job
  const types = logsOut.map((l) => JSON.parse(l).type);
  assert.ok(types.includes("job-created"), `expected job-created in: ${types}`);
  assert.ok(types.includes("spawned"), `expected spawned in: ${types}`);
  assert.ok(types.includes("finalized"), `expected finalized in: ${types}`);

  // logs --follow on an already-completed job: should also exit cleanly (terminal reached)
  const followOut = [];
  const followDeps = { ...deps, out: (line) => followOut.push(line) };
  const followCode = await runCompanion(["logs", jobId, "--follow"], followDeps);
  assert.equal(followCode, 0, "logs --follow on completed job should exit 0");
  // Should also print events (--follow uses waitForJob onEvent path)
  assert.ok(followOut.length >= 1, "logs --follow should emit at least one event");
});

test("wait/logs on unknown job exit 1 with a clear message", async () => {
  const { deps, out } = setup();

  // wait on unknown job
  const waitCode = await runCompanion(["wait", "cc-nonexistent"], deps);
  assert.equal(waitCode, 1, "wait on unknown job should exit 1");
  assert.ok(
    out.some((l) => l.includes("cc-nonexistent") || l.toLowerCase().includes("no job")),
    `expected clear error message, got: ${out.join("\n")}`,
  );

  out.length = 0;

  // logs on unknown job
  const logsCode = await runCompanion(["logs", "cc-nonexistent"], deps);
  assert.equal(logsCode, 1, "logs on unknown job should exit 1");
  assert.ok(
    out.some((l) => l.includes("cc-nonexistent") || l.toLowerCase().includes("no job")),
    `expected clear error message, got: ${out.join("\n")}`,
  );
});

test("wait on a cancelled job exits 2 (parity with codex/antigravity)", async () => {
  const { deps, stateDir } = setupE2E("hang");

  const launchCode = await runCompanion(
    ["task", "cancel me", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(launchCode, 0);

  const jobId = listJobs(stateDir)[0].id;

  const runningDeadline = Date.now() + 10_000;
  while (Date.now() < runningDeadline) {
    const job = readJob(stateDir, jobId);
    if (job && job.status === "running") break;
    await sleep(50);
  }
  assert.equal(readJob(stateDir, jobId)?.status, "running");

  const cancelCode = await runCompanion(["cancel", jobId], deps);
  assert.equal(cancelCode, 0);
  assert.equal((await waitForTerminal(stateDir, jobId, 10_000)).status, "cancelled");

  const waitOut = [];
  const waitDeps = { ...deps, out: (line) => waitOut.push(line) };
  const waitCode = await runCompanion(
    ["wait", jobId, "--timeout-s", "5", "--json"],
    waitDeps,
  );
  assert.equal(waitCode, 2, "cancelled job must exit 2, not 1");
});
