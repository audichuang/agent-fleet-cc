import { makeTempDir, makeDataRoot, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runWorker,
  installCancelForwarder,
} from "../../plugins/delegate/scripts/lib/worker.mjs";
import { cancelJob } from "../../plugins/delegate/scripts/lib/job-control.mjs";
import {
  writeJob,
  readJob,
  promptFilePath,
  logFilePath,
} from "../../plugins/delegate/scripts/lib/state.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

function fakeSpawn(mode) {
  return (_binary, _args, options) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });
}

function seedJob(stateDir, settingsPath, overrides = {}) {
  const job = {
    id: "dlg-w1",
    status: "queued",
    profile: "kimi",
    settingsPath,
    permissionMode: "bypassPermissions",
    cwd: process.cwd(),
    timeoutMs: 5000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  writeJob(stateDir, job);
  fs.mkdirSync(path.dirname(promptFilePath(stateDir, job.id)), { recursive: true });
  fs.writeFileSync(promptFilePath(stateDir, job.id), "do the thing");
  return job;
}

test("runWorker: success path finalizes completed with result + session id + log", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", {
    env: { ANTHROPIC_BASE_URL: "https://cheap" },
  });
  seedJob(stateDir, settingsPath);
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: { spawnImpl: fakeSpawn("success") },
  });
  const job = readJob(stateDir, "dlg-w1");
  assert.equal(job.status, "completed");
  assert.equal(job.sessionId, "sess-fake-1");
  assert.match(job.resultText, /^echo:do the thing/);
  assert.ok(fs.existsSync(logFilePath(stateDir, "dlg-w1")), "raw stream logged");
});

test("runWorker: spawned claude gets REBUILT env (no pollution, profile injected, marker set)", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", {
    env: { ANTHROPIC_BASE_URL: "https://cheap" },
  });
  seedJob(stateDir, settingsPath);
  let seenEnv = null;
  const spy = (_b, _a, options) => {
    seenEnv = options.env;
    return spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: "success" },
    });
  };
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: {
      spawnImpl: spy,
      baseEnv: {
        PATH: process.env.PATH,
        ANTHROPIC_BASE_URL: "https://expensive",
        ANTHROPIC_MODEL: "opus",
        CLAUDECODE: "1",
      },
    },
  });
  assert.equal(seenEnv.ANTHROPIC_BASE_URL, "https://cheap");
  assert.ok(!("ANTHROPIC_MODEL" in seenEnv));
  assert.ok(!("CLAUDECODE" in seenEnv));
  assert.equal(seenEnv.CLAUDE_DELEGATE_ACTIVE, "1");
});

test("runWorker: failure path finalizes failed with stderr tail", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", { env: {} });
  seedJob(stateDir, settingsPath);
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: { spawnImpl: fakeSpawn("fail") },
  });
  const job = readJob(stateDir, "dlg-w1");
  assert.equal(job.status, "failed");
  assert.match(job.error, /invalid auth token/);
});

test("runWorker: timeout finalizes timed-out", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", { env: {} });
  seedJob(stateDir, settingsPath, { timeoutMs: 300 });
  await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: { spawnImpl: fakeSpawn("hang"), graceMs: 200 },
  });
  assert.equal(readJob(stateDir, "dlg-w1").status, "timed-out");
});

test("runWorker: missing job file exits 1 without throwing", async () => {
  const stateDir = makeTempDir();
  assert.equal(await runWorker({ stateDir, jobId: "ghost" }), 1);
});

// Bug B 頭條回歸：cancel 先贏 → worker 絕不 spawn、JSON 維持 cancelled。
test("runWorker: job cancelled before start is never spawned", async () => {
  const stateDir = makeTempDir();
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "kimi", { env: {} });
  seedJob(stateDir, settingsPath);
  const r = cancelJob(stateDir, "dlg-w1", { isAlive: () => false, killImpl: () => {} });
  assert.equal(r.ok, true);
  let spawned = false;
  const code = await runWorker({
    stateDir,
    jobId: "dlg-w1",
    deps: {
      spawnImpl: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    },
  });
  assert.equal(code, 0, "losing to a canceller is not an error");
  assert.equal(spawned, false);
  assert.equal(readJob(stateDir, "dlg-w1").status, "cancelled");
});

function makeForwarderHarness(opts = {}) {
  const proc = new EventEmitter();
  const kills = [];
  const scheduled = [];
  const exits = [];
  const fwd = installCancelForwarder({
    proc,
    graceMs: 1000,
    killImpl: (child, sig) => kills.push([child.name, sig]),
    exitImpl: (code) => exits.push(code),
    scheduleImpl: (fn, ms) => {
      const t = { fn, ms, unref() {} };
      scheduled.push(t);
      return t;
    },
    ...opts,
  });
  return { proc, kills, scheduled, exits, fwd };
}

test("forwarder: SIGTERM after spawn → SIGTERM then scheduled SIGKILL", () => {
  const { proc, kills, scheduled, fwd } = makeForwarderHarness();
  fwd.onChild({ name: "claude" });
  proc.emit("SIGTERM");
  assert.deepEqual(kills, [["claude", "SIGTERM"]]);
  const grace = scheduled.find((t) => t.ms === 1000);
  assert.ok(grace, "SIGKILL escalation scheduled");
  grace.fn();
  assert.deepEqual(kills, [
    ["claude", "SIGTERM"],
    ["claude", "SIGKILL"],
  ]);
});

test("forwarder: SIGTERM before spawn kills the late child immediately", () => {
  const { proc, kills, fwd } = makeForwarderHarness();
  proc.emit("SIGTERM");
  assert.deepEqual(kills, [], "nothing to kill yet");
  fwd.onChild({ name: "late" });
  assert.deepEqual(kills[0], ["late", "SIGTERM"], "late child is killed on arrival");
});

test("forwarder: forceExitMs schedules a worker self-exit (zombie guard)", () => {
  const { proc, scheduled, exits, fwd } = makeForwarderHarness({ forceExitMs: 7000 });
  fwd.onChild({ name: "c" });
  proc.emit("SIGTERM");
  const exitTimer = scheduled.find((t) => t.ms === 7000);
  assert.ok(exitTimer, "force-exit scheduled");
  exitTimer.fn();
  assert.deepEqual(exits, [0]);
});

test("forwarder: dispose removes the handler", () => {
  const { proc, kills, fwd } = makeForwarderHarness();
  fwd.onChild({ name: "c" });
  fwd.dispose();
  proc.emit("SIGTERM");
  assert.deepEqual(kills, []);
  assert.equal(proc.listenerCount("SIGTERM"), 0);
});
