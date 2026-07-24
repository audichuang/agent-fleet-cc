// tests/grok/companion.test.mjs — in-process runCompanion() with injected seams.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, makeDataRoot } from "./helpers.mjs";
import { runCompanion } from "../../plugins/grok/scripts/grok-companion.mjs";
import { resolveDataRoot, workspaceStateDir } from "../../plugins/grok/scripts/lib/adapter.mjs";
import { createJob, listJobs, markJobRunning, finalizeJob, jobDir } from "../../plugins/grok/scripts/lib/shared/core/state-store.mjs";
import { createJobRecord } from "../../plugins/grok/scripts/lib/shared/core/job.mjs";
import { appendEvent } from "../../plugins/grok/scripts/lib/shared/core/events.mjs";

// Seed a job in the exact state dir the companion will resolve for (dataRoot, cwd).
function seedJob(dataRoot, cwd, { status, resultText, pid, text = "editing src/foo.ts", sessionId } = {}) {
  const stateDir = workspaceStateDir(resolveDataRoot({ GROK_PLUGIN_DATA: dataRoot }), cwd);
  const record = createJobRecord({ engine: "grok", title: "watch me", cwd });
  createJob(stateDir, record, "prompt");
  if (status === "running") {
    markJobRunning(stateDir, record.id, { pid });
    appendEvent(jobDir(stateDir, record.id), "spawned", { pid });
    if (text) appendEvent(jobDir(stateDir, record.id), "engine-event", { kind: "text", text });
  } else if (status) {
    // any terminal status: completed / failed / cancelled / timed-out
    finalizeJob(stateDir, record.id, sessionId !== undefined ? { status, resultText, sessionId } : { status, resultText });
  }
  return record.id;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_GROK = path.join(HERE, "fake-grok.mjs");

function collect() {
  const lines = [];
  return { out: (l) => lines.push(l), lines };
}

test("setup reports the grok CLI version when the probe succeeds", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["setup"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA },
    out,
    spawnSyncImpl: () => ({ status: 0, stdout: "grok 9.9.9\n" }),
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /✓ grok CLI: grok 9\.9\.9/.test(l)), lines.join("\n"));
});

test("setup fails when the grok CLI is not runnable", async () => {
  const { out } = collect();
  const code = await runCompanion(["setup"], {
    env: {}, out,
    spawnSyncImpl: () => ({ error: new Error("ENOENT") }),
  });
  assert.equal(code, 1);
});

test("task (foreground) runs a job to completion via the fake engine and emits --json", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "hello there", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      // Inject the fake grok as the spawned binary via request.binaryArgv seam.
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.engine, "grok");
  assert.equal(json.status, "completed");
  assert.match(json.resultText, /^echo:hello there/);
});

test("task --live streams the raw engine log (incl. the terminal event) to stderr, with a clean one-line stdout result", async () => {
  const outc = collect();
  const errc = collect();
  const code = await runCompanion(
    ["task", "hello live", "--live", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out: outc.out,
      err: errc.out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  assert.equal(code, 0);
  // stdout is EXACTLY the one-line JSON projection — no raw event JSON leaks in
  assert.equal(outc.lines.length, 1, `stdout must be one line, got:\n${outc.lines.join("\n")}`);
  const json = JSON.parse(outc.lines[0]);
  assert.equal(json.status, "completed");
  assert.match(json.resultText, /^echo:hello live/);
  // the live stream (raw grok events) lands on stderr via runWorker's onLine hook —
  // each line the instant the worker reads it, so the terminal event is guaranteed,
  // not raced against a file flush. The authoritative result is the stdout
  // projection asserted above.
  const errText = errc.lines.join("\n");
  assert.match(errText, /"type":\s*"text"/);
  assert.match(errText, /echo:hello live/);
  assert.match(errText, /"type":\s*"end"/, "onLine must stream the terminal event to stderr");
});

test("task --live exits non-zero when the job fails (death-visibility)", async () => {
  const outc = collect();
  const errc = collect();
  const code = await runCompanion(
    ["task", "will fail", "--live", "--json"],
    {
      env: {
        GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA,
        GROK_BIN: `${process.execPath}`,
        FAKE_GROK_MODE: "fail", // survives buildEngineEnv (only ANTHROPIC_/CLAUDE_ are stripped)
      },
      cwd: process.env.GROK_PLUGIN_DATA,
      out: outc.out,
      err: errc.out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  assert.equal(code, 1, "a failed --live job must exit non-zero so the run_in_background shell turns red");
  const json = JSON.parse(outc.lines.at(-1));
  assert.notEqual(json.status, "completed");
});

test("task WITHOUT --live never streams to the err seam (onLine wired only for --live)", async () => {
  const outc = collect();
  const errc = collect();
  const code = await runCompanion(
    ["task", "quiet please", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out: outc.out,
      err: errc.out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(outc.lines.at(-1)).status, "completed");
  assert.equal(errc.lines.length, 0, "a non-live task must not write to the live stream seam");
});

test("task rejects --live together with --background", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["task", "hi", "--live", "--background"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
    cwd: process.env.GROK_PLUGIN_DATA,
    out,
    binaryArgv: [process.execPath, FAKE_GROK],
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /--live and --background are mutually exclusive/);
});

test("task rejects --live together with --wait (--live is already foreground)", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["task", "hi", "--live", "--wait"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
    cwd: process.env.GROK_PLUGIN_DATA,
    out,
    binaryArgv: [process.execPath, FAKE_GROK],
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /--live and --wait are mutually exclusive/);
});

test("task refuses to launch unauthenticated (guards the 1h OAuth hang)", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["task", "hello", "--json"], {
    // Real-binary path: no binaryArgv, no GROK_BIN → auth preflight is active.
    // Hermetic HOME (helpers.mjs) has no ~/.grok/auth.json and no XAI_API_KEY.
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, HOME: process.env.HOME },
    cwd: process.env.GROK_PLUGIN_DATA,
    out,
  });
  assert.equal(code, 1);
  const json = JSON.parse(lines.at(-1));
  assert.equal(json.errorKind, "auth");
  assert.match(json.error, /not authenticated/);
});

test("task accepts --no-subagents (does not reject it as an unknown flag)", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "hi", "--no-subagents", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.status, "completed");
});

test("task accepts --read-only (does not reject it as an unknown flag)", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "audit the code", "--read-only", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.status, "completed");
});

test("task accepts --research, --max-turns, --no-memory (not rejected as unknown flags) and maps them into the spawned argv", async () => {
  const { out, lines } = collect();
  let capturedArgs = null;
  const code = await runCompanion(
    ["task", "research xyz", "--research", "--max-turns", "7", "--no-memory", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
      grokSpawnImpl: (bin, args, opts) => {
        capturedArgs = args;
        return spawn(bin, args, opts);
      },
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.status, "completed");
  assert.equal(capturedArgs[capturedArgs.indexOf("--tools") + 1], "x_search,web_search,web_fetch");
  assert.equal(capturedArgs[capturedArgs.indexOf("--deny") + 1], "MCPTool");
  assert.equal(capturedArgs[capturedArgs.indexOf("--max-turns") + 1], "7");
  assert.ok(capturedArgs.includes("--no-memory"));
});

test("task without --research/--max-turns/--no-memory sends none of their flags (opt-in only)", async () => {
  const { out, lines } = collect();
  let capturedArgs = null;
  const code = await runCompanion(
    ["task", "plain run", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
      grokSpawnImpl: (bin, args, opts) => {
        capturedArgs = args;
        return spawn(bin, args, opts);
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(lines.at(-1)).status, "completed");
  assert.ok(!capturedArgs.includes("--tools"));
  assert.ok(!capturedArgs.includes("--deny"));
  assert.ok(!capturedArgs.includes("--max-turns"));
  assert.ok(!capturedArgs.includes("--no-memory"));
});

test("task rejects --max-turns 0 / negative / non-numeric with a UsageError, creates no job", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  for (const bad of ["0", "-1", "abc", "1.5"]) {
    const { out, lines } = collect();
    const code = await runCompanion(["task", "hi", "--max-turns", bad, "--wait", "--json"], {
      env: { GROK_PLUGIN_DATA: dataRoot, GROK_BIN: `${process.execPath}` },
      cwd,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
    });
    assert.equal(code, 1, `--max-turns ${bad} should be rejected`);
    assert.match(lines.at(-1), /--max-turns must be a positive integer/);
  }
  assert.equal(listJobs(workspaceStateDir(resolveDataRoot({ GROK_PLUGIN_DATA: dataRoot }), cwd)).length, 0, "a rejected --max-turns must create no job record");
});

test("task --schema returns grok's structured JSON as resultText", async () => {
  const schemaPath = path.join(makeTempDir(), "schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }));
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "return ok true", "--schema", schemaPath, "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.status, "completed");
  assert.match(json.resultText, /"ok":\s*true/);
});

test("task --schema rejects an unreadable or non-JSON schema file", async () => {
  const bad = collect();
  const c1 = await runCompanion(["task", "hi", "--schema", "/no/such/schema.json", "--wait", "--json"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
    cwd: process.env.GROK_PLUGIN_DATA, out: bad.out, binaryArgv: [process.execPath, FAKE_GROK],
  });
  assert.equal(c1, 1);
  assert.match(bad.lines.at(-1), /schema file not readable/);

  const notJson = path.join(makeTempDir(), "bad.json");
  fs.writeFileSync(notJson, "this is not json");
  const bad2 = collect();
  const c2 = await runCompanion(["task", "hi", "--schema", notJson, "--wait", "--json"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
    cwd: process.env.GROK_PLUGIN_DATA, out: bad2.out, binaryArgv: [process.execPath, FAKE_GROK],
  });
  assert.equal(c2, 1);
  assert.match(bad2.lines.at(-1), /not valid JSON/);
});

test("recursion guard: refuses to run inside a grok job", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["status"], { env: { GROK_FLEET_ACTIVE: "1" }, out });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /recursion guard/.test(l)));
});

test("status shows a liveness line for a running job", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  seedJob(dataRoot, cwd, { status: "running", pid: process.pid });
  const { out, lines } = collect();
  const code = await runCompanion(["status"], {
    env: { GROK_PLUGIN_DATA: dataRoot },
    cwd,
    out,
    isAlive: () => true,
    gitChanges: () => 3,
    nowMs: Date.now(),
  });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /↳/);
  assert.match(text, /alive✓/);
  assert.match(text, /editing src\/foo\.ts/);
  assert.match(text, /Δwt: 3/);
});

test("wait on a completed job exits 0 and relays the full result once", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const id = seedJob(dataRoot, cwd, { status: "completed", resultText: "the final answer" });
  const { out, lines } = collect();
  const code = await runCompanion(["wait", id, "--timeout-s", "5"], {
    env: { GROK_PLUGIN_DATA: dataRoot },
    cwd,
    out,
  });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /the final answer/);
  assert.equal((text.match(/the final answer/g) || []).length, 1, "full result relayed exactly once");
});

test("wait on a failed job exits 1", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const id = seedJob(dataRoot, cwd, { status: "failed" });
  const { out } = collect();
  const code = await runCompanion(["wait", id, "--timeout-s", "5"], { env: { GROK_PLUGIN_DATA: dataRoot }, cwd, out });
  assert.equal(code, 1);
});

test("wait on a cancelled job exits 2", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const id = seedJob(dataRoot, cwd, { status: "cancelled" });
  const { out } = collect();
  const code = await runCompanion(["wait", id, "--timeout-s", "5"], { env: { GROK_PLUGIN_DATA: dataRoot }, cwd, out });
  assert.equal(code, 2);
});

test("wait timeout liveness line stays ONE physical line even with multiline engine text", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const id = seedJob(dataRoot, cwd, { status: "running", pid: process.pid, text: "step 1\nstep 2\nstep 3" });
  const { out, lines } = collect();
  const code = await runCompanion(["wait", id, "--timeout-s", "0.5"], {
    env: { GROK_PLUGIN_DATA: dataRoot },
    cwd,
    out,
    isAlive: () => true,
    gitChanges: () => 0,
    nowMs: Date.now(),
  });
  assert.equal(code, 10);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\n/, "multiline engine text must collapse to one physical line");
  assert.match(lines[0], /step 1 step 2 step 3/);
});

test("wait timeout on a running job exits 10 with exactly ONE compact liveness line", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  seedJob(dataRoot, cwd, { status: "running", pid: process.pid });
  const runningId = seedJob(dataRoot, cwd, { status: "running", pid: process.pid, text: "running tests" });
  const { out, lines } = collect();
  const code = await runCompanion(["wait", runningId, "--timeout-s", "0.5"], {
    env: { GROK_PLUGIN_DATA: dataRoot },
    cwd,
    out,
    isAlive: () => true,
    gitChanges: () => 2,
    nowMs: Date.now(),
  });
  assert.equal(code, 10);
  assert.equal(lines.length, 1, `expected one line, got: ${lines.join("\n")}`);
  assert.match(lines[0], /alive✓/);
  assert.match(lines[0], /running tests/);
  assert.doesNotMatch(lines[0], /the final answer/);
});

// --- pre-spawn --session-id (crash-safe resume) -----------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("new task: mints a valid session id and PERSISTS it to request.sessionId before the engine ever spawns", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const stateDir = workspaceStateDir(resolveDataRoot({ GROK_PLUGIN_DATA: dataRoot }), cwd);
  let sessionIdOnDiskAtSpawn = null;
  let capturedArgs = null;
  let spawnCount = 0;
  const code = await runCompanion(
    ["task", "hello", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: dataRoot, GROK_BIN: `${process.execPath}` },
      cwd,
      out: () => {},
      binaryArgv: [process.execPath, FAKE_GROK],
      // Injected in place of node:child_process's spawn (spawnEngine calls
      // spawnImpl(bin, args, opts)) — read the job record off disk BEFORE
      // calling through, proving persistence happened strictly before spawn.
      grokSpawnImpl: (bin, args, opts) => {
        spawnCount += 1;
        sessionIdOnDiskAtSpawn = listJobs(stateDir)[0]?.request?.sessionId ?? null;
        capturedArgs = args;
        return spawn(bin, args, opts);
      },
    },
  );
  assert.equal(code, 0);
  assert.ok(UUID_RE.test(sessionIdOnDiskAtSpawn), `expected a valid UUID on disk pre-spawn, got ${sessionIdOnDiskAtSpawn}`);
  assert.deepEqual(capturedArgs.slice(-2), ["-s", sessionIdOnDiskAtSpawn], "the persisted id must be the exact one sent to grok");
  assert.equal(spawnCount, 1, "no retry-with-same-request path — one task invocation spawns the engine exactly once");
});

test("resume: sends -r <sessionId> and never -s (grok rejects --session-id together with --resume)", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const priorId = seedJob(dataRoot, cwd, { status: "completed", resultText: "prior answer", sessionId: "prior-session-abc" });
  let capturedArgs = null;
  const code = await runCompanion(
    ["task", "follow up", "--resume-job", priorId, "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: dataRoot, GROK_BIN: `${process.execPath}` },
      cwd,
      out: () => {},
      binaryArgv: [process.execPath, FAKE_GROK],
      grokSpawnImpl: (bin, args, opts) => {
        capturedArgs = args;
        return spawn(bin, args, opts);
      },
    },
  );
  assert.equal(code, 0);
  assert.ok(capturedArgs.includes("-r"));
  assert.equal(capturedArgs[capturedArgs.indexOf("-r") + 1], "prior-session-abc");
  assert.ok(!capturedArgs.includes("-s"), "resume must never send --session-id (grok rejects both together)");
});

test("crash-safe resume: a job that died before an `end` event (no top-level sessionId) is still resumable via request.sessionId", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const stateDir = workspaceStateDir(resolveDataRoot({ GROK_PLUGIN_DATA: dataRoot }), cwd);
  // Simulate the exact scenario this feature exists for: the id was minted and
  // persisted into request.sessionId before spawn, but the worker process died
  // before extractResult ever ran, so finalize (here, standing in for
  // reconcileDeadPids) never learned a sessionId from the `end` event.
  const crashedRecord = createJobRecord({
    engine: "grok",
    title: "crashed run",
    cwd,
    request: { model: "grok-4.5", sessionId: "pre-spawn-uuid-1234" },
  });
  createJob(stateDir, crashedRecord, "prompt");
  finalizeJob(stateDir, crashedRecord.id, { status: "failed", error: "worker process died (reconciled dead pid)" });

  let capturedArgs = null;
  const code = await runCompanion(
    ["task", "continue after crash", "--resume-job", crashedRecord.id, "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: dataRoot, GROK_BIN: `${process.execPath}` },
      cwd,
      out: () => {},
      binaryArgv: [process.execPath, FAKE_GROK],
      grokSpawnImpl: (bin, args, opts) => {
        capturedArgs = args;
        return spawn(bin, args, opts);
      },
    },
  );
  assert.equal(code, 0, "resume must succeed even though the crashed job never got a post-hoc top-level sessionId");
  assert.ok(capturedArgs.includes("-r"));
  assert.equal(capturedArgs[capturedArgs.indexOf("-r") + 1], "pre-spawn-uuid-1234");
  assert.ok(!capturedArgs.includes("-s"));
});

test("resume-job on a job with NO session id anywhere (never spawned) still refuses with the usage error", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("grok-ws-");
  const id = seedJob(dataRoot, cwd, { status: "failed" }); // no sessionId, no request.sessionId
  const { out, lines } = collect();
  const code = await runCompanion(["task", "hi", "--resume-job", id, "--wait", "--json"], {
    env: { GROK_PLUGIN_DATA: dataRoot, GROK_BIN: `${process.execPath}` },
    cwd,
    out,
    binaryArgv: [process.execPath, FAKE_GROK],
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /has no session id to resume/);
});
