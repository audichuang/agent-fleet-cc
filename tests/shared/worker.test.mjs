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

// ─── Live-streaming hook: deps.onLine ────────────────────────────────────────
// The foreground live-shell path (e.g. grok's `task --live`) needs each raw engine
// stdout line as it arrives, with no file-tail race. runWorker must hand every raw
// line to deps.onLine (when provided), in order, before parsing — and a throwing
// sink must never break the job (streaming is best-effort, job integrity is not).
test("deps.onLine receives every raw engine stdout line in order (live streaming hook)", async () => {
  const { stateDir, record, spawnImpl, adapter } = setup({
    lines: ['{"type":"text","data":"a"}', "plain noise", '{"type":"end"}'],
  });
  const seen = [];
  await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl, onLine: (line) => seen.push(line) },
  });
  // every raw line, in order, including the non-parseable "plain noise" (mirrors the log)
  assert.deepEqual(seen, ['{"type":"text","data":"a"}', "plain noise", '{"type":"end"}']);
});

test("deps.onLine fires BEFORE parseEvent for each line (hook precedes parse)", async () => {
  const seenByOnLine = [];
  const adapter = makeAdapter({
    parseEvent: (line) => {
      // contract: by the time a line is parsed, onLine has already been handed it
      assert.ok(seenByOnLine.includes(line), `onLine must run before parseEvent for: ${line}`);
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    },
  });
  const { stateDir, record, spawnImpl } = setup({ lines: ['{"type":"a"}', '{"type":"b"}'], adapter });
  await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl, onLine: (l) => seenByOnLine.push(l) },
  });
  assert.deepEqual(seenByOnLine, ['{"type":"a"}', '{"type":"b"}']);
});

test("a throwing deps.onLine never breaks the job (streaming is best-effort, not fatal)", async () => {
  const { stateDir, record, spawnImpl, adapter } = setup({
    lines: ['{"type":"result","kind":"result","text":"ok","session":"s"}'],
  });
  adapter.parseEvent = (line) => {
    try { const e = JSON.parse(line); return e.kind === "result" ? e : null; } catch { return null; }
  };
  adapter.extractResult = (events) => {
    const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
    return r ? { ok: true, resultText: r.text, sessionId: r.session } : { ok: false };
  };
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl, onLine: () => { throw new Error("bad sink"); } },
  });
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, record.id).status, "completed");
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

// ─── F4: SIGINT/SIGHUP forwarding ────────────────────────────────────────────
// The detached engine child has its own process group, so a terminal Ctrl-C
// (SIGINT) delivered to the foreground companion does NOT reach the engine —
// orphaning it. installCancelForwarder must register the same kill handler on
// SIGINT and SIGHUP, not just SIGTERM.
//
// mutation criterion: revert installCancelForwarder to register only "SIGTERM" →
// the SIGINT emit triggers no kill → assert killed.length>=1 turns red.
test("installCancelForwarder (F4): SIGINT triggers killGroupWithGrace on child.pid", () => {
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
  proc.emit("SIGINT"); // Ctrl-C, NOT SIGTERM
  assert.ok(killed.length >= 1, "SIGINT must trigger a kill (Ctrl-C forwarding)");
  assert.ok(killed.some((k) => k.pid === -1234), "must kill the process GROUP (negative pgid)");
  assert.ok(killed.some((k) => k.sig === "SIGTERM"), "killGroupWithGrace sends SIGTERM to the group first");
  forwarder.dispose();
});

// F4: SIGHUP (controlling terminal closed) must also forward the kill.
test("installCancelForwarder (F4): SIGHUP triggers killGroupWithGrace on child.pid", () => {
  const proc = new EventEmitter();
  const killed = [];
  const killImpl = (pid, sig) => killed.push({ pid, sig });
  const forwarder = installCancelForwarder({
    proc,
    graceMs: 100,
    killImpl,
    scheduleImpl: () => ({ unref: () => {} }),
  });
  forwarder.onChild({ pid: 5678 });
  proc.emit("SIGHUP");
  assert.ok(killed.some((k) => k.pid === -5678), "SIGHUP must kill the child's process group");
  forwarder.dispose();
});

// F4: dispose() must remove the handler from ALL THREE signals, not just SIGTERM —
// otherwise a post-dispose signal (or a leaked listener across reused proc) still kills.
// mutation criterion: have dispose remove only "SIGTERM" → after dispose, emitting
// SIGINT/SIGHUP still finds a registered listener → listenerCount > 0 → red.
test("installCancelForwarder (F4): dispose removes SIGTERM, SIGINT, and SIGHUP handlers", () => {
  const proc = new EventEmitter();
  const killed = [];
  const killImpl = (pid, sig) => killed.push({ pid, sig });
  const forwarder = installCancelForwarder({
    proc,
    graceMs: 100,
    killImpl,
    scheduleImpl: () => ({ unref: () => {} }),
  });
  forwarder.onChild({ pid: 4242 });
  // Before dispose: all three signals have exactly one listener.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    assert.equal(proc.listenerCount(sig), 1, `${sig} listener installed`);
  }
  forwarder.dispose();
  // After dispose: no listeners remain on any of the three.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    assert.equal(proc.listenerCount(sig), 0, `${sig} listener removed by dispose`);
  }
  // And a post-dispose signal triggers no kill.
  proc.emit("SIGINT");
  assert.equal(killed.length, 0, "no kill after dispose");
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
  // The held-open stdout must be RELEASED before runWorker returns. A foreground
  // caller now exits via process.exitCode (natural drain, not process.exit()), so a
  // still-open read handle would hang it forever. Destroying it lets the loop drain.
  // mutation criterion: remove the `child.stdout.destroy()` in worker.mjs → this
  // stays false → a real foreground caller would hang after this sequence.
  assert.equal(
    child.stdout.destroyed,
    true,
    "runWorker must release the held stdout so a process.exitCode caller can exit, not hang",
  );
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

// ─── 首事件看門狗(adapter 選填 firstEventTimeoutMs) ──────────────────────────
// 防的不是「跑太久」(那是 timeoutMs),而是「headless 的 run 卡在互動式提示」:
// 引擎沒死、沒報錯、也不吐事件,只是在等一個不會來的人類。真實案例見
// plugins/grok/scripts/lib/adapter.mjs 的 firstEventTimeoutMs 註解(grok 的 cached
// token 過期時會遞迴進瀏覽器 OAuth 並等 600s)。
//
// 全部用 pid=1:killProcessGroup 對 pid<=1 直接 return,所以測試永遠不會真的對
// 一個存在的 process group 發訊號(4242 有極小機率是真的 pgid)。殺法本身由
// spawn.test.mjs 驗,這裡只驗「看門狗做了什麼決定、job 落到什麼終態」。
function silentChild({ stderr = "" } = {}) {
  const child = new EventEmitter();
  child.pid = 1;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write() {}, end() {}, on() {} };
  child.kill = () => {};
  // stdout 刻意永不 end、永不寫任何一行 —— 這就是「卡住」的形狀。
  if (stderr) setImmediate(() => child.stderr.write(stderr));
  return child;
}

const stalledDeps = (child) => ({
  spawnImpl: () => child,
  graceMs: 5,
  forceResolveExtraMs: 5,
});

test("first-event watchdog: a silent engine is killed and reported as stalled, not timeout", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 60_000 });
  createJob(stateDir, record, "the prompt");
  const adapter = makeAdapter({ firstEventTimeoutMs: 40 });
  const child = silentChild();
  // runWorker 的回傳值不是 job 判決(它結尾一律 return 0);終態只看 job 記錄。
  await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "failed");
  // "stalled" 必須跟 "timeout" 分開:後者是超出預算,前者是一開口都沒開。混在一起
  // 就問不出「這是不是又一次互動式卡頓」。
  assert.equal(job.errorKind, "stalled");
  assert.notEqual(job.status, "timed-out", "the whole-job budget was 60s and was never reached");
  assert.match(job.error, /wrote nothing to stdout within 40ms/);
  assert.match(job.error, /interactive prompt/);
});

test("first-event watchdog: STDERR alone must NOT disarm it (the prompt may print there)", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 60_000 });
  createJob(stateDir, record, "the prompt");
  const adapter = makeAdapter({ firstEventTimeoutMs: 40 });
  // 這行就是真實世界那個「印在 stderr 的授權 URL」。拿它解除看門狗 = 自廢這道關。
  const child = silentChild({ stderr: "Visit https://accounts.grok.com/authorize?code=... to continue\n" });
  // runWorker 的回傳值不是 job 判決(它結尾一律 return 0);終態只看 job 記錄。
  await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
  const job = readJob(stateDir, record.id);
  assert.equal(job.errorKind, "stalled");
  // stderr 是最有用的線索(那個沒人會去點的 URL),所以殺掉時要把它一起交出去。
  assert.match(job.error, /accounts\.grok\.com/);
});

test("first-event watchdog: one parsed engine event disarms it for the rest of the job", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 60_000 });
  createJob(stateDir, record, "the prompt");
  const adapter = makeAdapter({ firstEventTimeoutMs: 40 });
  adapter.parseEvent = (line) => {
    try {
      const e = JSON.parse(line);
      return e.kind === "result" ? { kind: "result", text: e.text } : { kind: "noise" };
    } catch {
      return null;
    }
  };
  adapter.extractResult = (events) => {
    const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
    return r ? { ok: true, resultText: r.text, sessionId: null } : { ok: false };
  };
  const child = fakeChild({ lines: ['{"kind":"noise"}'] });
  child.pid = 1;
  const spawnImpl = () => {
    // 第一個事件在看門狗預算內到達,結果行遠遠在它之後 —— 撤掉就該永久撤掉,
    // 不是每個事件都重新武裝(那會變成 idle watchdog,不是這道關的語意)。
    setImmediate(() => {
      child.stdout.write('{"kind":"noise"}\n');
      setTimeout(() => {
        child.stdout.write('{"kind":"result","text":"done"}\n');
        child.stdout.on("end", () => setImmediate(() => child.emit("close", 0, null)));
        child.stdout.end();
      }, 120); // > firstEventTimeoutMs:證明撤除是永久的
    });
    return child;
  };
  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl, graceMs: 5 } });
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "done");
  assert.equal(job.errorKind, null);
});

test("first-event watchdog: an adapter that does not declare it is completely unaffected", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 150 });
  createJob(stateDir, record, "the prompt");
  const adapter = makeAdapter(); // 沒有 firstEventTimeoutMs
  const child = silentChild();
  // runWorker 的回傳值不是 job 判決(它結尾一律 return 0);終態只看 job 記錄。
  await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
  const job = readJob(stateDir, record.id);
  // 沉默的引擎仍然只被整體預算收掉 → timed-out/timeout,絕不是 stalled。
  assert.equal(job.status, "timed-out");
  assert.equal(job.errorKind, "timeout");
});

test("first-event watchdog: ANY non-empty stdout line disarms it, parseable or not", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 300 });
  createJob(stateDir, record, "the prompt");
  // parseEvent 對這行回傳 null —— 而這行仍然必須解除看門狗。門檻是「引擎在 stdout 上
  // 講話了嗎」,不是「adapter 想不想正規化這行」:adapter 對 progress / thought / tool
  // 行回 null 是正常的,拿 parsed 當門檻會殺掉健康的 run。
  const adapter = makeAdapter({ firstEventTimeoutMs: 40, parseEvent: () => null });
  const child = silentChild();
  setImmediate(() => child.stdout.write("grok: checking for updates...\n"));
  await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
  const job = readJob(stateDir, record.id);
  assert.notEqual(job.errorKind, "stalled", "the engine spoke on stdout — it is not stalled");
  // 它最後是被整體預算收掉的,不是被這道關殺的。
  assert.equal(job.status, "timed-out");
  assert.match(fs.readFileSync(logFilePath(stateDir, record.id), "utf8"), /checking for updates/);
});

// Codex 審查抓到的必死情境:非串流模式(grok 的 --json-schema)在終端物件之前沒有任何
// 「可解析事件」,所以用 parsed 當解除門檻會保證誤殺每一個超過預算的 schema run。
test("first-event watchdog: a non-streaming engine that emits nothing parseable until the end is NOT killed", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 60_000 });
  createJob(stateDir, record, "the prompt");
  // 整份結果是一個跨行的 JSON 物件:每一行單獨都解析不出來,只有最後合起來才成立。
  const adapter = makeAdapter({
    firstEventTimeoutMs: 40,
    parseEvent: (line) => (line.trim() === "}" ? { kind: "result", text: "done" } : null),
    extractResult: (events) => {
      const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
      return r ? { ok: true, resultText: r.text, sessionId: null } : { ok: false };
    },
  });
  const child = silentChild();
  const spawnImpl = () => {
    setImmediate(() => child.stdout.write("{\n"));           // 預算內,但解析不出來
    setTimeout(() => {                                        // 遠遠超過 firstEventTimeoutMs
      child.stdout.write('  "text": "done"\n');
      child.stdout.write("}\n");
      child.stdout.on("end", () => setImmediate(() => child.emit("close", 0, null)));
      child.stdout.end();
    }, 130);
    return child;
  };
  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl, graceMs: 5 } });
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "completed", "a healthy non-streaming run must survive the watchdog");
  assert.equal(job.errorKind, null);
  assert.equal(job.resultText, "done");
});

// 看門狗開火後,一個會處理 SIGTERM 的引擎還是可以吐個合法終端事件再 exit 0。
// 沒有把 stalled 併進 failed 判準,那樣會落成 completed —— 我們才剛因為它卡住殺了它。
test("first-event watchdog: a fired watchdog cannot finalize as completed, even on a clean exit 0", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 60_000 });
  createJob(stateDir, record, "the prompt");
  const adapter = makeAdapter({
    firstEventTimeoutMs: 40,
    parseEvent: () => ({ kind: "result", text: "graceful" }),
    extractResult: () => ({ ok: true, resultText: "graceful", sessionId: null }),
  });
  const child = silentChild();
  const spawnImpl = () => {
    // 沉默到看門狗開火,然後「優雅地」收尾 —— 正是會騙過 exitCode 判準的形狀。
    setTimeout(() => {
      child.stdout.write('{"kind":"result"}\n');
      child.stdout.on("end", () => setImmediate(() => child.emit("close", 0, null)));
      child.stdout.end();
    }, 60);
    return child;
  };
  // forceResolveExtraMs 給很大:否則 force-resolve 會先贏,exitCode 停在 null,
  // 於是 `exitCode !== 0` 自己就讓 failed 成立 —— 測試就測不到它名字說的那件事
  // (child 真的乾淨 exit 0)。這個陷阱是 mutation 驗證抓出來的。
  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl, graceMs: 5, forceResolveExtraMs: 5000 } });
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "failed", "we killed it for stalling; a tidy exit 0 must not launder that");
  assert.equal(job.errorKind, "stalled");
});

// 兩個期限重疊:整體預算先到、child 在 grace 期間沒關,看門狗若還武裝著會再開火一次,
// 結果 status 是 timed-out 而 error/errorKind 是 stalled —— 持久化的終態自相矛盾。
test("overlapping deadlines: whole-job timeout first must not leave contradictory stalled metadata", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 40 });
  createJob(stateDir, record, "the prompt");
  // 看門狗預算比整體預算晚一點 —— 整體先到,看門狗會在 child 還沒收尾時想開火。
  const adapter = makeAdapter({ firstEventTimeoutMs: 70 });
  const child = silentChild();
  await runWorker({
    stateDir, jobId: record.id, adapter,
    deps: { spawnImpl: () => child, graceMs: 5, forceResolveExtraMs: 120 },
  });
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "timed-out", "the whole-job budget won the race");
  assert.equal(job.errorKind, "timeout", "errorKind must agree with status, not say stalled");
  assert.doesNotMatch(job.error ?? "", /wrote nothing to stdout/);
});

// 截斷只能吃 stderr,不能吃掉「我們為什麼殺掉它」。長 stderr 是這條的重點:
// 早期版本把前綴和 stderr 串起來一起 .slice(-500),於是說明連同授權 URL 一起被吃光。
test("stalled message: a long stderr tail must not swallow the explanation", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 60_000 });
  createJob(stateDir, record, "the prompt");
  const adapter = makeAdapter({ firstEventTimeoutMs: 40 });
  const child = silentChild({ stderr: "NOISE ".repeat(400) + "\n" }); // ~2400 bytes
  await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
  const job = readJob(stateDir, record.id);
  assert.equal(job.errorKind, "stalled");
  assert.match(job.error, /^engine wrote nothing to stdout within 40ms/, "the reason must survive intact");
  assert.match(job.error, /NOISE/, "and the stderr tail still rides along");
});

// getter 語意:worker 必須在 buildInvocation **之後**才讀 firstEventTimeoutMs,否則
// 按 invocation 關閉(grok 的 --json-schema 豁免)會失效。把讀取移早會讓 adapter 自己的
// 單元測試照樣綠,所以這條要在 worker 層釘住。
test("firstEventTimeoutMs is read AFTER buildInvocation, and the ARMED value is what gets reported", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 400 });
  createJob(stateDir, record, "the prompt");
  // 這條要釘兩件事,而先前的版本兩件都沒釘住(getter 前後都回同一個值,而且斷言被
  // 後來的錯誤格式化重讀覆蓋掉 —— 空心測試):
  //   (1) worker 必須在 buildInvocation 之後才讀 → 才能支援 per-invocation 關閉;
  //   (2) 報出來的數字必須是**武裝當時**看到的,不是事後重讀的。
  // 所以 getter 回可區分的值,而且在武裝後就翻臉變 null(模擬下一次 buildInvocation)。
  const adapter = makeAdapter();
  let built = false;
  let reads = 0;
  adapter.buildInvocation = ({ prompt }) => {
    built = true;
    return { argv: ["fake-bin"], env: {}, stdinPayload: prompt };
  };
  Object.defineProperty(adapter, "firstEventTimeoutMs", {
    get() {
      reads += 1;
      if (!built) return 999_999;   // 讀太早 → 大到不會開火,測試就會看到 timed-out
      if (reads > 1) return null;   // 事後重讀 → null,會讓訊息變成 "within nullms"
      return 40;
    },
  });
  const child = silentChild();
  await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
  const job = readJob(stateDir, record.id);
  assert.equal(job.errorKind, "stalled", "read too early → 999999ms budget → would have timed out instead");
  assert.match(job.error, /within 40ms/, "must report the value seen at arming time, not a re-read");
  assert.doesNotMatch(job.error, /nullms/);
});

// 宣告了一個用不了的預算(0 / NaN / Infinity / 字串)絕不能安靜等於「沒宣告」——
// 使用者會以為自己開了防護,而 OAuth 那 600 秒照樣在等。至少要留下可查的痕跡。
test("a declared-but-unusable firstEventTimeoutMs does not arm, and says so in the event log", async () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "40"]) {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "fake", timeoutMs: 120 });
    createJob(stateDir, record, "the prompt");
    const adapter = makeAdapter({ firstEventTimeoutMs: bad });
    const child = silentChild();
    await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
    const job = readJob(stateDir, record.id);
    assert.notEqual(job.errorKind, "stalled", `${String(bad)} must not arm the guard`);
    const log = fs.readFileSync(logFilePath(stateDir, record.id), "utf8");
    assert.match(log, /firstEventTimeoutMs was declared as/, `${String(bad)} must be reported, not vanish silently`);
    assert.match(log, /NOT armed/);
  }
});

// 相對照:真的沒宣告(null / 缺欄位)是合約允許的「不啟用」,不該警告。
test("an absent or null firstEventTimeoutMs is the documented opt-out — no warning", async () => {
  for (const value of [undefined, null]) {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "fake", timeoutMs: 120 });
    createJob(stateDir, record, "the prompt");
    const adapter = makeAdapter(value === undefined ? {} : { firstEventTimeoutMs: null });
    const child = silentChild();
    await runWorker({ stateDir, jobId: record.id, adapter, deps: stalledDeps(child) });
    const log = fs.readFileSync(logFilePath(stateDir, record.id), "utf8");
    assert.doesNotMatch(log, /firstEventTimeoutMs was declared/, "not declaring it is legitimate, not a misconfiguration");
  }
});

// SIGKILL 升級必須可取消。child 已經自己收乾淨之後,那個 callback 仍會在 graceMs 後對 pgid
// 開槍 —— pid 已死、pgid 被系統回收時,那一槍會打到不相干的 process group。
// 反向不變量:child 的 'close' **不代表** process group 空了 —— 同 pgid 的孫子可以改掉
// stdio、無視 TERM 活下來。所以 SIGKILL 升級必須照樣開火,不能因為 job 落終態就取消
// (adapter-api.md 不變量 3:孫子不留)。曾經為了 pgid 回收的顧慮把它取消掉,那讓引擎後代
// 活過 job 終態 —— 用一個未重現的假設換掉一個承重的保證,方向反了。
test("kill escalation still fires after the child closes — close does not prove the group is empty", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 30 });
  createJob(stateDir, record, "the prompt");
  const GRACE = 120;
  let escalationsFired = 0;
  const scheduleImpl = (fn, ms) => setTimeout(() => {
    if (ms === GRACE) escalationsFired += 1;
    fn();
  }, ms);
  const adapter = makeAdapter();
  const child = silentChild();
  // leader 在 timeout 開火後、grace 到期前關閉 —— 孫子留著的形狀就是這樣。
  setTimeout(() => {
    child.stdout.on("end", () => setImmediate(() => child.emit("close", 143, "SIGTERM")));
    child.stdout.end();
  }, 45);
  await runWorker({
    stateDir, jobId: record.id, adapter,
    deps: { spawnImpl: () => child, graceMs: GRACE, forceResolveExtraMs: 400, scheduleImpl },
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(escalationsFired, 1, "the group-wide SIGKILL must survive the job finalizing");
  assert.equal(readJob(stateDir, record.id).status, "timed-out");
});
