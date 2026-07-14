// tests/grok/companion.test.mjs — in-process runCompanion() with injected seams.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, makeDataRoot } from "./helpers.mjs";
import { runCompanion } from "../../plugins/grok/scripts/grok-companion.mjs";
import { resolveDataRoot, workspaceStateDir } from "../../plugins/grok/scripts/lib/adapter.mjs";
import { createJob, markJobRunning, finalizeJob, jobDir } from "../../plugins/grok/scripts/lib/shared/core/state-store.mjs";
import { createJobRecord } from "../../plugins/grok/scripts/lib/shared/core/job.mjs";
import { appendEvent } from "../../plugins/grok/scripts/lib/shared/core/events.mjs";

// Seed a job in the exact state dir the companion will resolve for (dataRoot, cwd).
function seedJob(dataRoot, cwd, { status, resultText, pid, text = "editing src/foo.ts" } = {}) {
  const stateDir = workspaceStateDir(resolveDataRoot({ GROK_PLUGIN_DATA: dataRoot }), cwd);
  const record = createJobRecord({ engine: "grok", title: "watch me", cwd });
  createJob(stateDir, record, "prompt");
  if (status === "running") {
    markJobRunning(stateDir, record.id, { pid });
    appendEvent(jobDir(stateDir, record.id), "spawned", { pid });
    if (text) appendEvent(jobDir(stateDir, record.id), "engine-event", { kind: "text", text });
  } else if (status) {
    // any terminal status: completed / failed / cancelled / timed-out
    finalizeJob(stateDir, record.id, { status, resultText });
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
