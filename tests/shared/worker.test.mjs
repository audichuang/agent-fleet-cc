// tests/shared/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { readEvents } from "../../shared/lib/core/events.mjs";
import {
  createJob,
  readJob,
  finalizeJob,
  jobDir,
  logFilePath,
  lockFilePath,
} from "../../shared/lib/core/state-store.mjs";
import { runWorker, installCancelForwarder } from "../../shared/lib/runtime/worker.mjs";
import { killGroupWithGrace } from "../../shared/lib/runtime/spawn.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-worker-"));

// 假 child:stdout/stderr 必須是真 stream(readline 吃 Readable),
// EventEmitter 模擬 data 事件不可靠。
function fakeChild({ lines = [], exitCode = 0, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write() {}, end() {}, on() {} };
  child.kill = () => {};
  child.emitAll = () => {
    for (const line of lines) child.stdout.write(line + "\n");
    if (stderr) child.stderr.write(stderr);
    child.stderr.end();
    // 'close' 必須等 stdout 被 readline 消費完(模擬真實 child_process 的
    // close-after-stdio 語意),否則尾行事件會漏。
    child.stdout.on("end", () => setImmediate(() => child.emit("close", exitCode, null)));
    child.stdout.end();
  };
  return child;
}

function makeAdapter(overrides = {}) {
  return {
    name: "fake",
    engine: "fake",
    recursionMarker: "FAKE_ACTIVE",
    wantsWatchdog: false,
    buildInvocation: ({ prompt }) => ({
      argv: ["fake-bin"],
      env: { FAKE_PROFILE: "x" },
      stdinPayload: prompt,
    }),
    parseEvent: (line) => {
      try {
        const e = JSON.parse(line);
        return e && e.type ? e : null;
      } catch {
        return null;
      }
    },
    extractResult: (events) => {
      const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
      return r
        ? { ok: true, resultText: r.text, sessionId: r.session ?? null }
        : { ok: false, resultText: null, sessionId: null };
    },
    classifyError: () => "unknown",
    resumeArgs: () => [],
    ...overrides,
  };
}

function setup({ lines, exitCode, stderr, adapter } = {}) {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  const child = fakeChild({ lines, exitCode, stderr });
  const spawnImpl = (bin, args, opts) => {
    setImmediate(() => child.emitAll());
    return child;
  };
  return { stateDir, record, child, spawnImpl, adapter: adapter ?? makeAdapter() };
}

test("happy path: completed with resultText, sessionId, events, log", async () => {
  const { stateDir, record, spawnImpl, adapter } = setup({
    lines: ['{"type":"noise"}', "junk", '{"type":"result","kind":"result","text":"hi","session":"s-1"}'],
  });
  // adapter 把帶 kind:result 的行映成 engine-event
  adapter.parseEvent = (line) => {
    try {
      const e = JSON.parse(line);
      if (e.kind === "result") return { kind: "result", text: e.text, session: e.session };
      return e && e.type ? { kind: "noise" } : null;
    } catch {
      return null;
    }
  };
  adapter.extractResult = (events) => {
    const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
    return r ? { ok: true, resultText: r.text, sessionId: r.session } : { ok: false };
  };
  const code = await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });
  assert.equal(code, 0);
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "hi");
  assert.equal(job.sessionId, "s-1");
  assert.equal(job.exitCode, 0);
  assert.ok(job.durationMs >= 0);
  const types = readEvents(jobDir(stateDir, record.id)).map((e) => e.type);
  assert.ok(types.includes("spawned"));
  assert.ok(types.includes("result"));
  assert.equal(types[types.length - 1], "finalized");
  assert.match(fs.readFileSync(logFilePath(stateDir, record.id), "utf8"), /junk/);
});

test("nonzero exit → failed with classifyError kind and stderr tail", async () => {
  const adapter = makeAdapter({ classifyError: () => "auth" });
  const { stateDir, record, spawnImpl } = setup({ lines: [], exitCode: 1, stderr: "401 unauthorized", adapter });
  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "failed");
  assert.equal(job.errorKind, "auth");
  assert.match(job.error, /401/);
});

test("worker loses CAS to a canceller — exits 0, spawns nothing", async () => {
  const { stateDir, record, adapter } = setup({});
  finalizeJob(stateDir, record.id, { status: "cancelled" });
  let spawned = false;
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl: () => ((spawned = true), fakeChild()) },
  });
  assert.equal(code, 0);
  assert.equal(spawned, false);
  assert.equal(readJob(stateDir, record.id).status, "cancelled");
});

test("env is force-sanitized: inherited ANTHROPIC_* stripped, marker set, adapter env kept", async () => {
  let seenEnv = null;
  const { stateDir, record, adapter, child } = setup({ lines: [] });
  const spawnImpl = (bin, args, opts) => {
    seenEnv = opts.env;
    setImmediate(() => child.emitAll());
    return child;
  };
  await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl, baseEnv: { ANTHROPIC_API_KEY: "leak", PATH: "/bin" } },
  });
  assert.equal("ANTHROPIC_API_KEY" in seenEnv, false);
  assert.equal(seenEnv.FAKE_ACTIVE, "1");
  assert.equal(seenEnv.FAKE_PROFILE, "x");
  assert.equal(seenEnv.PATH, "/bin");
});

test("missing prompt file → failed, never spawns", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake" });
  createJob(stateDir, record, "p");
  fs.unlinkSync(path.join(jobDir(stateDir, record.id), "prompt.txt"));
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter: makeAdapter(),
    deps: { spawnImpl: () => fakeChild() },
  });
  assert.equal(code, 1);
  assert.equal(readJob(stateDir, record.id).status, "failed");
});

// --- Round-2 regression tests ---

// Issue 1: parseEvent が type フィールドを含むオブジェクトを返した場合、
// in-memory events と events.ndjson の両方で .type が engine-event のままであることを検証。
// mutation criterion: events.push の最後の type: "engine-event" を削除すると
// e.type が "result" になり下の assert が赤くなる。
test("engine-event type is never overridden when parseEvent returns object with type field", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  // Raw engine output has {type:"result",...} — like a real claude --json line
  const rawLine = '{"type":"result","kind":"result","text":"hello","session":"s-x"}';
  const child = fakeChild({ lines: [rawLine], exitCode: 0 });
  // adapter.parseEvent returns the parsed object including the engine's own type field
  const adapter = makeAdapter({
    parseEvent: (line) => {
      try { return JSON.parse(line); } catch { return null; }
    },
    extractResult: (events) => {
      // Must still find the event via type === "engine-event" (not "result")
      const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
      return r ? { ok: true, resultText: r.text, sessionId: r.session ?? null } : { ok: false };
    },
  });
  const spawnImpl = (bin, args, opts) => {
    setImmediate(() => child.emitAll());
    return child;
  };
  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });

  // In-memory path: extractResult found the engine-event → job completed
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "hello");

  // events.ndjson path: the written event must have type === "engine-event"
  const events = readEvents(jobDir(stateDir, record.id));
  const engineEvents = events.filter((e) => e.type === "engine-event");
  assert.equal(engineEvents.length, 1, "exactly one engine-event should be written");
  assert.equal(engineEvents[0].type, "engine-event",
    "type must be engine-event, not the raw engine type (e.g. 'result')");
  // Parsed fields must still be accessible at top level for extractResult
  assert.equal(engineEvents[0].kind, "result");
  assert.equal(engineEvents[0].text, "hello");
  // raw field must hold original line
  assert.equal(engineEvents[0].raw, rawLine);
});

// Issue 2: canceller が terminal.lock を claim した後まだ writeJob を実行していない
// 競態窗口でも、finalized event が lock から真の終態(cancelled)を記録することを検証。
// mutation criterion: lost-cas 分岐で readTerminalLock を読まずに readJob のみ使うと
// stale "running" が返り assert.equal(finalized.status, "cancelled") が赤くなる。
test("lost-cas finalized event records lock status, not stale running from job.json", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  const child = fakeChild({ lines: [], exitCode: 0 });
  const adapter = makeAdapter();

  // Simulate the race: after child spawns (worker has already passed markJobRunning),
  // claim the terminal.lock with status="cancelled" but do NOT write job.json.
  // This models the window where a canceller has claimed the lock but hasn't yet
  // called writeJob. When worker's finalizeJob runs, it sees:
  //   - job.json: status="running" (non-terminal → tries claim → EEXIST → won=false)
  //   - terminal.lock: {status: "cancelled"}
  // The fix must read the lock to get the true status for the finalized event.
  const spawnImpl = (bin, args, opts) => {
    setImmediate(() => {
      // Claim the lock BEFORE child emits close (so it's in place when finalizeJob runs)
      try {
        fs.writeFileSync(
          lockFilePath(stateDir, record.id),
          JSON.stringify({ pid: 99, status: "cancelled", at: new Date().toISOString() }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        // lock already claimed — ignore in this test path
      }
      child.emitAll();
    });
    return child;
  };

  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });

  const events = readEvents(jobDir(stateDir, record.id));
  const finalizedEvent = events.find((e) => e.type === "finalized");
  assert.ok(finalizedEvent, "finalized event must always be written");
  assert.equal(finalizedEvent.by, "lost-cas");
  // Key assertion: status must be "cancelled" (from lock), NOT "running" (stale job.json)
  assert.equal(finalizedEvent.status, "cancelled",
    "finalized event must record the true terminal status from terminal.lock, not stale job.json");
});

// Round-3 fix: lock content non-terminal/corrupt → finalized event must still be terminal.
// Regression for: when readTerminalLock returns {status:null} (corrupt/non-terminal lock),
// the old code fell through to readJob()?.status which returned stale "running" — a non-terminal
// status that violates spec §3. Fix: only use job.json status if it is a terminal status;
// otherwise fall back to "failed".
// mutation criterion: remove the TERMINAL_STATUSES guard and use readJob().status directly →
// finalized.status becomes "running" (non-terminal) → this test turns red.
test("lost-cas with corrupt/non-terminal lock → finalized event status is always terminal", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  const child = fakeChild({ lines: [], exitCode: 0 });
  const adapter = makeAdapter();

  // Write a lock with non-terminal status content (e.g. "running").
  // readTerminalLock returns {status: null} for this — simulates corrupt/legacy lock.
  // job.json will still have status="running" (stale, written by markJobRunning).
  // Without the fix, finalStatus falls through to readJob().status = "running" — non-terminal.
  // With the fix, we detect lock.status is null AND job.json status is not terminal,
  // so we fall back to "failed".
  const spawnImpl = (bin, args, opts) => {
    setImmediate(() => {
      // Write a lock whose status is NOT a known terminal status.
      // This is what readTerminalLock returns as {status: null} (non-object status value
      // that doesn't pass TERMINAL_STATUSES check).
      try {
        fs.writeFileSync(
          lockFilePath(stateDir, record.id),
          JSON.stringify({ pid: 99, status: "running", at: new Date().toISOString() }),
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        // lock already claimed by worker — fallback path tested separately
      }
      child.emitAll();
    });
    return child;
  };

  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });

  const events = readEvents(jobDir(stateDir, record.id));
  const finalizedEvent = events.find((e) => e.type === "finalized");
  assert.ok(finalizedEvent, "finalized event must always be written");
  // The finalized event status MUST be a terminal status — never an active status.
  const TERMINAL = new Set(["completed", "failed", "cancelled", "timed-out"]);
  assert.ok(
    TERMINAL.has(finalizedEvent.status),
    `finalized event status must be terminal, got: ${finalizedEvent.status}`,
  );
  // When lock is corrupt (non-terminal content) and job.json is stale running,
  // the safe fallback is "failed".
  assert.equal(
    finalizedEvent.status,
    "failed",
    "corrupt/non-terminal lock with stale running job.json must fall back to 'failed'",
  );
});

// Supplement for "missing prompt file → failed, never spawns" (Round-3 suggestion):
// The original test only checks code===1 and status==="failed". This supplement
// adds a spawned===false assertion to guard against regressions where a future
// refactor reads prompt after spawn. If implementation regresses to "spawn then read
// prompt", spawned becomes true and this test turns red.
// Also covers the adapter.buildInvocation() throw path.
test("missing prompt file → never spawns (spawned flag supplement)", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake" });
  createJob(stateDir, record, "p");
  fs.unlinkSync(path.join(jobDir(stateDir, record.id), "prompt.txt"));
  let spawned = false;
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter: makeAdapter(),
    deps: { spawnImpl: () => ((spawned = true), fakeChild()) },
  });
  assert.equal(code, 1);
  assert.equal(spawned, false, "worker must never spawn when prompt file is missing");
  assert.equal(readJob(stateDir, record.id).status, "failed");
});

// Covers the adapter.buildInvocation() throw path: when adapter throws during
// invocation building, worker must fail cleanly without spawning.
// mutation criterion: remove the buildInvocation try/catch → uncaught exception,
// test turns red (unhandled rejection instead of clean code=1).
test("adapter.buildInvocation() throw → failed, never spawns", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  let spawned = false;
  const adapter = makeAdapter({
    buildInvocation: () => { throw new Error("adapter config error"); },
  });
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl: () => ((spawned = true), fakeChild()) },
  });
  assert.equal(code, 1);
  assert.equal(spawned, false, "worker must never spawn when buildInvocation throws");
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "failed");
  assert.equal(job.errorKind, "adapter");
  assert.match(job.error, /adapter config error/);
});

// ─── Issue 1 fix: buildEngineEnv without recursionMarker → failed terminal ─────
// If adapter.recursionMarker is empty/undefined, buildEngineEnv throws.
// Before the fix: the throw was unguarded — job stays stuck at "running" (non-terminal).
// After the fix: try/catch wraps buildEngineEnv, finalizeJob({status:"failed"}) is called,
// and a finalized event is written.
// mutation criterion: remove try/catch around buildEngineEnv → job.status stays "running"
// (TERMINAL_STATUSES invariant violated).
test("adapter missing recursionMarker: buildEngineEnv throw → job reaches failed terminal", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  const child = fakeChild({ lines: [], exitCode: 0 });
  // Adapter with empty recursionMarker causes buildEngineEnv to throw
  const adapter = makeAdapter({ recursionMarker: "" });
  let spawned = false;
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl: () => ((spawned = true), child) },
  });
  assert.equal(spawned, false, "must never spawn when buildEngineEnv throws");
  const job = readJob(stateDir, record.id);
  assert.ok(
    ["failed", "cancelled", "completed", "timed-out"].includes(job.status),
    `job must reach terminal state, got: ${job.status}`,
  );
  assert.equal(job.status, "failed", "buildEngineEnv failure must yield failed status");
  assert.equal(job.errorKind, "adapter");
  const events = readEvents(jobDir(stateDir, record.id));
  const finalizedEvent = events.find((e) => e.type === "finalized");
  assert.ok(finalizedEvent, "finalized event must be written even when buildEngineEnv throws");
  assert.equal(finalizedEvent.status, "failed");
});

// ─── Issue 2 fix: early-finalize lost-CAS writes finalized event ─────────────
// When prompt-missing or buildInvocation-throw finalize path loses CAS to a
// concurrent canceller (won=false), the old code wrote NO finalized event.
// Fix: write finalized event with the real terminal status (same as main path).
// mutation criterion: remove the lost-cas finalized-event branch in early-finalize →
// finalizedEvent is undefined → assert.ok(finalizedEvent) turns red.
test("early-finalize lost-CAS (prompt missing): finalized event written with real terminal status", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake" });
  createJob(stateDir, record, "p");
  // Canceller wins CAS before worker attempts to finalize the missing-prompt path
  finalizeJob(stateDir, record.id, { status: "cancelled" });
  // Now delete the prompt file so the worker hits the early-finalize path
  fs.unlinkSync(path.join(jobDir(stateDir, record.id), "prompt.txt"));
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter: makeAdapter(),
    deps: { spawnImpl: () => fakeChild() },
  });
  // Job was already cancelled — worker cannot overwrite
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "cancelled");
  // Finalized event must exist (from canceller who won CAS or from lost-cas branch)
  const events = readEvents(jobDir(stateDir, record.id));
  const finalizedEvents = events.filter((e) => e.type === "finalized");
  // The early-finalize lost-cas branch must write finalized event
  // Either the canceller already wrote one (won=true path), or worker wrote one (lost-cas).
  // Either way, at least one finalized event must exist.
  assert.ok(finalizedEvents.length >= 1, "at least one finalized event must exist");
  // The last finalized event must record a terminal status, not an active one
  const lastFinalized = finalizedEvents[finalizedEvents.length - 1];
  const TERMINAL = new Set(["completed", "failed", "cancelled", "timed-out"]);
  assert.ok(
    TERMINAL.has(lastFinalized.status),
    `finalized event status must be terminal, got: ${lastFinalized.status}`,
  );
});

test("early-finalize lost-CAS (buildInvocation throw): finalized event written with real terminal status", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  // Race: canceller wins CAS inside buildInvocation (after markJobRunning, before earlyFinalize)
  // Simulate by having buildInvocation both finalize as canceller AND throw.
  const adapter = makeAdapter({
    buildInvocation: ({ job, prompt }) => {
      // Concurrent canceller wins the CAS while buildInvocation is running
      finalizeJob(stateDir, record.id, { status: "cancelled" });
      throw new Error("build fail during cancel race");
    },
  });
  await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl: () => fakeChild() },
  });
  // Job was already cancelled — worker earlyFinalize lost CAS
  assert.equal(readJob(stateDir, record.id).status, "cancelled");
  // At least one finalized event must exist and be terminal
  const events = readEvents(jobDir(stateDir, record.id));
  const finalizedEvents = events.filter((e) => e.type === "finalized");
  assert.ok(finalizedEvents.length >= 1, "finalized event must be present");
  const TERMINAL = new Set(["completed", "failed", "cancelled", "timed-out"]);
  for (const ev of finalizedEvents) {
    assert.ok(TERMINAL.has(ev.status), `finalized event status must be terminal, got: ${ev.status}`);
  }
  // The lost-cas branch must have written its event with correct terminal status
  const lostCasEvent = finalizedEvents.find((e) => e.by === "lost-cas");
  assert.ok(lostCasEvent, "lost-cas finalized event must be written by the worker");
  assert.equal(lostCasEvent.status, "cancelled", "lost-cas event must record the true canceller status");
});

// ─── Issue 3: installCancelForwarder tests ───────────────────────────────────
// Inject fake proc/killImpl/scheduleImpl to test all three behaviours:
// (a) SIGTERM triggers killGroupWithGrace on child.pid
// (b) terminated-before-spawn: when SIGTERM arrives before onChild, onChild still kills
// (c) forceExitMs triggers exitImpl(0)

test("installCancelForwarder (a): SIGTERM triggers killGroupWithGrace on child.pid", () => {
  const proc = new EventEmitter();
  const killed = [];
  const killImpl = (pid, sig) => killed.push({ pid, sig });
  const forwarder = installCancelForwarder({
    proc,
    graceMs: 100,
    killImpl,
    scheduleImpl: () => ({ unref: () => {} }),
  });
  forwarder.onChild({ pid: 1234 });
  proc.emit("SIGTERM");
  // killGroupWithGrace sends SIGTERM first (kill(-pid, SIGTERM))
  assert.ok(killed.length >= 1, "at least one kill call expected");
  assert.ok(killed.some((k) => k.pid === -1234), "must kill process GROUP (negative pgid)");
  assert.ok(killed.some((k) => k.sig === "SIGTERM"), "SIGTERM sent first");
  forwarder.dispose();
});

test("installCancelForwarder (b): terminated before spawn — onChild still kills", () => {
  const proc = new EventEmitter();
  const killed = [];
  const killImpl = (pid, sig) => killed.push({ pid, sig });
  const forwarder = installCancelForwarder({
    proc,
    graceMs: 100,
    killImpl,
    scheduleImpl: () => ({ unref: () => {} }),
  });
  // SIGTERM arrives BEFORE onChild (before child spawns)
  proc.emit("SIGTERM");
  assert.equal(killed.length, 0, "no kill before child is registered");
  // Now child arrives — must immediately kill because terminated=true
  forwarder.onChild({ pid: 5678 });
  assert.ok(killed.length >= 1, "kill must be called immediately when SIGTERM already arrived");
  assert.ok(killed.some((k) => k.pid === -5678), "must kill the new child's process group");
  forwarder.dispose();
});

test("installCancelForwarder (c): forceExitMs triggers exitImpl(0)", () => {
  const proc = new EventEmitter();
  const exited = [];
  const exitImpl = (code) => exited.push(code);
  let scheduledFn = null;
  const scheduleImpl = (fn, ms) => {
    scheduledFn = fn;
    return { unref: () => {} };
  };
  const killImpl = () => {};
  const forwarder = installCancelForwarder({
    proc,
    graceMs: 100,
    forceExitMs: 500,
    killImpl,
    exitImpl,
    scheduleImpl,
  });
  forwarder.onChild({ pid: 9999 });
  proc.emit("SIGTERM");
  // scheduleImpl should have been called for forceExitMs
  assert.ok(scheduledFn !== null, "scheduleImpl must be called for forceExitMs");
  // Trigger the scheduled function
  scheduledFn();
  assert.deepEqual(exited, [0], "exitImpl(0) must be called after forceExitMs");
  forwarder.dispose();
});

// ─── Round-3 fix Issue 2: killGroupWithGrace SIGKILL escalation ──────────────
// The installCancelForwarder tests (a) and (b) use `scheduleImpl: () => ({ unref: () => {} })`
// which never invokes the scheduled callback. As a result, the SIGKILL escalation leg of
// killGroupWithGrace (spec §5 invariant (3): "cancel must kill cleanly / process group") was
// never asserted. A mutation replacing killGroupWithGrace with a one-shot group SIGTERM would
// still pass all three forwarder tests.
//
// This dedicated unit test for killGroupWithGrace asserts both legs:
//   1. SIGTERM is sent to the negative pgid (process group) immediately.
//   2. After the scheduled grace timer fires, SIGKILL is sent to the same negative pgid.
//
// mutation criterion: replace `killGroupWithGrace` with a one-shot SIGTERM (removing the
// scheduleImpl(SIGKILL) call) → killed array never gets {sig:"SIGKILL"} → assert turns red.
test("killGroupWithGrace: SIGTERM sent immediately then SIGKILL after grace callback fires", () => {
  const killed = [];
  const killImpl = (pid, sig) => killed.push({ pid, sig });
  let scheduledCallback = null;
  const scheduleImpl = (fn, ms) => {
    scheduledCallback = fn;
    return { unref: () => {} };
  };

  killGroupWithGrace(1234, { graceMs: 100, scheduleImpl, killImpl });

  // Leg 1: SIGTERM must be sent immediately to the process GROUP (negative pgid)
  assert.ok(killed.some((k) => k.pid === -1234 && k.sig === "SIGTERM"),
    "SIGTERM must be sent immediately to the process group (negative pgid)");

  // Grace timer callback is captured — SIGKILL not yet sent
  assert.ok(scheduledCallback !== null, "scheduleImpl must be called for grace SIGKILL");
  const sigkillBeforeCallback = killed.some((k) => k.sig === "SIGKILL");
  assert.equal(sigkillBeforeCallback, false, "SIGKILL must NOT be sent before grace timer fires");

  // Leg 2: invoking the scheduled callback must send SIGKILL to the process group
  scheduledCallback();
  assert.ok(killed.some((k) => k.pid === -1234 && k.sig === "SIGKILL"),
    "SIGKILL must be sent to the process group (negative pgid) after grace timer fires");
});

// ─── Issue 1 (Round-2): timeout with stdout-held pipe → job must reach timed-out ──
// Reproduce the scenario: a grandchild holds the inherited stdout pipe, so child
// emits 'exit' but 'close' NEVER fires. Before the fix, runWorker would block
// forever waiting for 'close'. After the fix, the force-resolve timer fires after
// graceMs+buffer and resolves the Promise, letting finalize run.
//
// fakeChild used here: stdout PassThrough is created but NEVER ended — it stays
// open indefinitely, simulating a grandchild holding the write-end of the pipe.
// child.emit("close",...) is NEVER called either, to faithfully model the hang.
//
// mutation criterion: remove the forceTimer block in worker.mjs timeout handler →
// runWorker Promise never resolves → test times out (node:test kills it) → red.
// Round-3 fix: pass timeout via node:test options object — `.timeout?.(3000)` is a
// silent no-op on Node v26.3.0 (test() returns a Promise, not a Thenable with .timeout).
// Using { timeout: 3000 } in the options object correctly cancels the test if runWorker
// blocks forever (e.g. when the forceTimer block is removed from worker.mjs).
test("timeout with stdout-holding grandchild: job must reach timed-out terminal state", { timeout: 3000 }, async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 100 });
  createJob(stateDir, record, "the prompt");

  // fakeChild whose stdout never ends and 'close' never fires
  const child = new EventEmitter();
  child.pid = 7777;
  child.stdout = new PassThrough(); // never .end()'d
  child.stderr = new PassThrough();
  child.stderr.end();
  child.stdin = { write() {}, end() {}, on() {} };
  child.kill = () => {};
  // child.emit("close",...) is NEVER called

  const adapter = makeAdapter();
  const spawnImpl = () => child;

  // Use very short graceMs (50ms) and tiny forceResolveExtraMs (50ms) so the
  // test finishes quickly: timeout(100) + grace(50) + extra(50) = ~200ms total.
  const result = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl, graceMs: 50, forceResolveExtraMs: 50 },
  });

  assert.equal(result, 0);
  const job = readJob(stateDir, record.id);
  assert.ok(job, "job must exist");
  assert.equal(
    job.status,
    "timed-out",
    "job must reach timed-out terminal state even when close never fires (stdout held by grandchild)",
  );
  const events = readEvents(jobDir(stateDir, record.id));
  const finalizedEvent = events.find((e) => e.type === "finalized");
  assert.ok(finalizedEvent, "finalized event must be written");
  assert.equal(finalizedEvent.status, "timed-out");
});

// ─── Issue 2 (Round-2): early-finalize lost-CAS prompt-missing — assert lost-cas + status ──
// The existing test at lines 423-454 only checks finalizedEvents.length>=1 and terminal status.
// This supplement bites on the specific lost-cas winner status: it asserts that when the
// worker's earlyFinalize loses CAS to a canceller, a finalized event with by==='lost-cas'
// and status==='cancelled' is written.
//
// mutation criterion: change earlyFinalize's lost-cas branch to hard-code 'failed' (ignoring
// the real winner status) → lostCas.status becomes 'failed' → assert.equal turns red.
test("early-finalize lost-CAS (prompt missing): lost-cas event has by=lost-cas and status=cancelled", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake" });
  createJob(stateDir, record, "p");
  // Canceller wins CAS before worker attempts to finalize the missing-prompt path.
  // The canceller also writes its own finalized event (by=worker from canceller's perspective).
  finalizeJob(stateDir, record.id, { status: "cancelled" });
  // Delete prompt so worker hits earlyFinalize path (after CAS is already claimed)
  fs.unlinkSync(path.join(jobDir(stateDir, record.id), "prompt.txt"));
  await runWorker({
    stateDir,
    jobId: record.id,
    adapter: makeAdapter(),
    deps: { spawnImpl: () => fakeChild() },
  });
  // Job remains cancelled (winner's status)
  assert.equal(readJob(stateDir, record.id).status, "cancelled");
  const events = readEvents(jobDir(stateDir, record.id));
  const finalizedEvents = events.filter((e) => e.type === "finalized");
  // The worker's earlyFinalize lost CAS → must write a finalized event with by='lost-cas'
  const lostCas = finalizedEvents.find((e) => e.by === "lost-cas");
  assert.ok(lostCas, "a lost-cas finalized event must be written by the worker's earlyFinalize path");
  // The status must match the winner's status (cancelled), not the worker's own patch status (failed)
  assert.equal(
    lostCas.status,
    "cancelled",
    "lost-cas finalized event must record the winner's status, not the worker's own patch",
  );
});

// ─── stdinError behaviour (Task 12 worker.mjs deviation) ─────────────────────
// Covers the stdinFailed = Boolean(stdinError) && exitCode !== 0 logic introduced
// alongside the conformance suite commit.
//
// New behaviour:
//   stdinError + exitCode===0  → completed (EPIPE on a clean-exit engine is NOT a failure)
//   stdinError + exitCode!==0  → failed    (stdinError confirms what the nonzero exit suggests)
//
// mutation criterion for case 1: remove `&& outcome.exitCode !== 0` from stdinFailed
// expression → job.status becomes "failed" instead of "completed" → assert turns red.
//
// mutation criterion for case 2: replace `stdinFailed` with `false` in the failed
// expression → stdinError is ignored → job.error becomes stderrTail-based → assert
// checking error message containing "stdin:" turns red.

test("stdinError + exitCode===0 → completed (EPIPE on clean exit is not a failure)", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");

  // Build a fakeChild whose stdin.write throws an EPIPE-like error, but the
  // process itself exits with code 0 and produces a valid result line.
  const child = new EventEmitter();
  child.pid = 3333;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdinError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  child.stdin = {
    on() {},
    write() { throw stdinError; },
    end() {},
  };
  child.kill = () => {};

  // Engine emits a valid result and exits 0
  const resultLine = '{"type":"result","kind":"result","text":"clean-exit","session":"s-ok"}';
  setImmediate(() => {
    child.stdout.write(resultLine + "\n");
    child.stderr.end();
    child.stdout.on("end", () =>
      setImmediate(() => child.emit("close", 0, null)),
    );
    child.stdout.end();
  });

  const adapter = makeAdapter({
    parseEvent: (line) => {
      try { const e = JSON.parse(line); return e && e.kind ? e : null; } catch { return null; }
    },
    extractResult: (events) => {
      const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
      return r ? { ok: true, resultText: r.text, sessionId: r.session ?? null } : { ok: false };
    },
  });

  await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl: () => child },
  });

  const job = readJob(stateDir, record.id);
  assert.equal(
    job.status,
    "completed",
    "stdinError with exitCode=0 must NOT be treated as failure (EPIPE on clean-exit engine)",
  );
  assert.equal(job.resultText, "clean-exit");
});

test("stdinError + exitCode!==0 → failed with stdin: error message", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");

  // Build a fakeChild whose stdin.write throws an error AND the process exits nonzero
  const child = new EventEmitter();
  child.pid = 4444;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdinError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  child.stdin = {
    on() {},
    write() { throw stdinError; },
    end() {},
  };
  child.kill = () => {};

  // Engine emits nothing and exits with code 1
  setImmediate(() => {
    child.stderr.end();
    child.stdout.on("end", () =>
      setImmediate(() => child.emit("close", 1, null)),
    );
    child.stdout.end();
  });

  await runWorker({
    stateDir,
    jobId: record.id,
    adapter: makeAdapter(),
    deps: { spawnImpl: () => child },
  });

  const job = readJob(stateDir, record.id);
  assert.equal(
    job.status,
    "failed",
    "stdinError with exitCode!=0 must produce a failed job",
  );
  assert.match(
    job.error,
    /stdin:/,
    "error message must include 'stdin:' prefix when stdinError caused the failure",
  );
});

// ─── Fix A: spawn-failure ENOENT → errorKind must be "not-installed" ─────────
// Before Fix A, classifyError received only outcome.stderrTail, which is empty on
// a spawn failure (the process never started) — so classifyError returned "unknown".
// After Fix A, classifyError receives outcome.spawnError (which contains the ENOENT
// message) when spawnError is truthy, so ClaudeAdapter.classifyError can match /ENOENT/
// and return "not-installed".
//
// This test drives runWorker with a deps.spawnImpl that throws an Error whose message
// contains "spawn /no/such/bin ENOENT" — exactly what Node's child_process emits when
// the binary is missing. The adapter's classifyError is wired to return "not-installed"
// when the input matches /ENOENT/ (mimicking ClaudeAdapter.classifyError behaviour).
//
// mutation criterion: revert Fix A (change back to `outcome.stderrTail`) →
// classifyError receives "" → returns "unknown" → assert.equal(job.errorKind, "not-installed") turns red.
test("spawn failure (ENOENT) → errorKind is not-installed, not unknown", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");

  // Adapter whose classifyError mirrors ClaudeAdapter: /ENOENT/ → "not-installed"
  const adapter = makeAdapter({
    classifyError: (text) => {
      if (text && /ENOENT/.test(text)) return "not-installed";
      return "unknown";
    },
  });

  // spawnImpl that throws synchronously with an ENOENT-like error message,
  // modelling what Node emits when the binary does not exist.
  const spawnImpl = () => {
    const err = new Error("spawn /no/such/bin ENOENT");
    err.code = "ENOENT";
    throw err;
  };

  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });

  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "failed", "spawn failure must produce a failed job");
  assert.equal(
    job.errorKind,
    "not-installed",
    "errorKind must be 'not-installed' when spawnError contains ENOENT (Fix A)",
  );
  assert.match(job.error, /ENOENT/, "error field must contain the spawn error message");
});
