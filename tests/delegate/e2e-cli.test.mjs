// Black-box end-to-end regression: drives the REAL delegate-companion.mjs CLI
// as a subprocess (the genuine isCliEntry / process.argv path), with a real
// detached worker-entry, a real directory-layout store, and a real two-stage
// cancel that is asserted to actually REAP the engine process — using a
// fake-claude shim so it needs NO API key and runs anywhere (CI included).
//
// This catches integration regressions the in-process runCompanion(deps) unit
// tests structurally cannot (CLI wiring, real spawn, cross-process cancel +
// engine death, the --json projections a user/orchestrator actually sees).
// Hardened per a Codex review: cancel proves the engine PID dies; --json
// asserts exactly one clean line; logs are parsed as JSON; flag-contract,
// failure, and resume paths are exercised. The real-claude-API smoke remains a
// separate manual gate (real model output is non-deterministic + costs money).
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(HERE, "../../plugins/delegate/scripts/delegate-companion.mjs");
const FAKE_CLAUDE = path.join(HERE, "fake-claude.mjs");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitGone = async (pid, ms = 8000) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(50);
  return !alive(pid);
};

// A fresh, isolated workspace per test (own data root + cwd + claude shim).
function makeWorkspace() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-data-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ws-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bin-"));
  const shim = path.join(bin, "claude");
  const pidfile = path.join(data, "engine.pid"); // fake-claude writes its real pid here
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-claude 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(data, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(data, "profiles", "p-ok.json"), JSON.stringify({ env: { FAKE_CLAUDE_MODE: "success" } }));
  // hang mode + a pidfile so cancel/timeout tests can assert the engine is reaped.
  fs.writeFileSync(path.join(data, "profiles", "p-hang.json"), JSON.stringify({ env: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_PIDFILE: pidfile } }));
  fs.writeFileSync(path.join(data, "profiles", "p-fail.json"), JSON.stringify({ env: { FAKE_CLAUDE_MODE: "fail" } }));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DELEGATE_PLUGIN_DATA: data, DELEGATE_CLAUDE_BIN: shim };
  return {
    env, ws, data, pidfile,
    cleanup() { for (const d of [data, ws, bin]) fs.rmSync(d, { recursive: true, force: true }); },
  };
}

function cli(w, args, opts = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: w.ws, env: w.env, encoding: "utf8", timeout: opts.timeout ?? 20000,
  });
}

// Parse a --json command's stdout. Asserts EXACTLY one non-empty line of clean
// JSON (a banner/warning before the JSON would break machine consumers — and
// this assertion). On success paths stderr must be empty.
function jsonOne(res, { successStderrEmpty = true } = {}) {
  const lines = (res.stdout ?? "").split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, `--json must emit exactly one clean JSON line; got stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  if (successStderrEmpty && res.status === 0) assert.equal((res.stderr ?? "").trim(), "", `success --json must keep stderr clean; got: ${res.stderr}`);
  return JSON.parse(lines[0]);
}

// Locate the real job.json the store wrote (black-box: glob under state/*).
function readJobJson(w, jobId) {
  const stateRoot = path.join(w.data, "state");
  for (const slug of fs.readdirSync(stateRoot)) {
    const f = path.join(stateRoot, slug, "jobs", jobId, "job.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  throw new Error(`job.json not found for ${jobId}`);
}

async function pollStatus(w, jobId, want, deadlineMs = 15000) {
  const end = Date.now() + deadlineMs;
  let status = "?";
  while (Date.now() < end) {
    const arr = jsonOne(cli(w, ["status", "--json"]));
    const job = Array.isArray(arr) ? arr.find((j) => j.jobId === jobId) : null;
    status = job ? job.status : "MISSING";
    if (status === want) return status;
    await sleep(150);
  }
  return status;
}

async function readPidWhenAlive(pidfile, deadlineMs = 12000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (fs.existsSync(pidfile)) {
      const pid = Number(fs.readFileSync(pidfile, "utf8").trim());
      if (pid > 1 && alive(pid)) return pid;
    }
    await sleep(100);
  }
  return null;
}

test("e2e: setup reports the claude shim + profiles", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["setup"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /fake-claude 0\.0\.0/);
    assert.match(res.stdout, /profile p-ok/);
  } finally { w.cleanup(); }
});

test("e2e: foreground task completes with a clean single-line --json projection", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["task", "hello foreground", "--profile", "p-ok", "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const payload = jsonOne(res);
    assert.equal(payload.engine, "delegate");
    assert.equal(payload.status, "completed");
    assert.equal(payload.resultText, "echo:hello foreground");
    assert.match(payload.jobId, /^delegate-/);
    assert.equal(payload.errorKind, null);
  } finally { w.cleanup(); }
});

test("e2e: background lifecycle task -> status -> wait -> logs(JSON) -> result", async () => {
  const w = makeWorkspace();
  try {
    const launch = jsonOne(cli(w, ["task", "hello background", "--profile", "p-ok", "--background", "--json"]));
    assert.equal(launch.status, "queued");
    const jobId = launch.jobId;

    assert.ok(jsonOne(cli(w, ["status", "--json"])).some((j) => j.jobId === jobId), "status must list the job");

    const waitRes = cli(w, ["wait", jobId, "--timeout-s", "30", "--json"], { timeout: 35000 });
    assert.equal(waitRes.status, 0, waitRes.stderr);
    assert.equal(jsonOne(waitRes).status, "completed");

    // logs: parse EVERY line as JSON and assert the real event types (not a
    // regex over human text that any string could satisfy).
    const logLines = cli(w, ["logs", jobId]).stdout.split("\n").filter((l) => l.trim());
    const types = logLines.map((l) => JSON.parse(l).type);
    for (const ev of ["job-created", "spawned", "finalized"]) assert.ok(types.includes(ev), `logs must include a ${ev} event; got ${types}`);

    const result = jsonOne(cli(w, ["result", jobId, "--json"]));
    assert.equal(result.status, "completed");
    assert.equal(result.resultText, "echo:hello background");
    assert.equal(result.sessionId, "sess-fake-1");
  } finally { w.cleanup(); }
});

test("e2e: two-stage cancel actually REAPS the running engine process", async () => {
  const w = makeWorkspace();
  let enginePid;
  try {
    const jobId = jsonOne(cli(w, ["task", "hang me", "--profile", "p-hang", "--background", "--json"])).jobId;
    // The engine (fake-claude) writes its real pid; wait until it is alive.
    enginePid = await readPidWhenAlive(w.pidfile);
    assert.ok(enginePid, "engine process must come up and report its pid");
    assert.equal(alive(enginePid), true, "engine alive before cancel");
    assert.equal(await pollStatus(w, jobId, "running"), "running");

    const cancel = jsonOne(cli(w, ["cancel", jobId, "--json"]));
    assert.equal(cancel.ok, true);

    // The whole point of two-stage cancel: the real engine must DIE, not just
    // the job.json flip to cancelled.
    assert.equal(await waitGone(enginePid), true, "engine process must be reaped after cancel (no zombie engine)");
    assert.equal(await pollStatus(w, jobId, "cancelled"), "cancelled");

    // cross-engine parity: wait on a cancelled job must exit 2
    const waitCancelled = cli(w, ["wait", jobId, "--timeout-s", "5", "--json"], { timeout: 10000 });
    assert.equal(waitCancelled.status, 2, "wait on a cancelled job must exit 2");
    assert.equal(jsonOne(waitCancelled, { successStderrEmpty: false }).status, "cancelled");
  } finally {
    if (enginePid && alive(enginePid)) { try { process.kill(-enginePid, "SIGKILL"); } catch {} try { process.kill(enginePid, "SIGKILL"); } catch {} }
    w.cleanup();
  }
});

test("e2e: wait on a still-running job times out with the dedicated exit code 10", async () => {
  const w = makeWorkspace();
  let enginePid;
  try {
    const jobId = jsonOne(cli(w, ["task", "hang again", "--profile", "p-hang", "--background", "--json"])).jobId;
    enginePid = await readPidWhenAlive(w.pidfile);
    assert.ok(enginePid, "engine up");
    const waitRes = cli(w, ["wait", jobId, "--timeout-s", "1", "--json"], { timeout: 10000 });
    assert.equal(waitRes.status, 10, "timeout is exit 10 (not an error) for clean orchestrator re-entry");
    assert.equal(jsonOne(waitRes).status, "running");
    cli(w, ["cancel", jobId]);
    assert.equal(await waitGone(enginePid), true, "engine reaped on cleanup cancel");
  } finally {
    if (enginePid && alive(enginePid)) { try { process.kill(-enginePid, "SIGKILL"); } catch {} try { process.kill(enginePid, "SIGKILL"); } catch {} }
    w.cleanup();
  }
});

test("e2e: a failing engine surfaces a failed projection (status/exitCode/errorKind)", async () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["task", "boom", "--profile", "p-fail", "--json"]);
    assert.notEqual(res.status, 0, "a failed job exits non-zero");
    const payload = jsonOne(res, { successStderrEmpty: false });
    assert.equal(payload.status, "failed");
    assert.equal(payload.exitCode, 1);
    assert.equal(typeof payload.errorKind, "string");
    assert.ok(payload.errorKind.length > 0, "failed job carries an errorKind for orchestrator diagnosis");
  } finally { w.cleanup(); }
});

test("e2e: machine-contract flags reach the persisted job request (--read-only/--model/--prompt-file)", () => {
  const w = makeWorkspace();
  try {
    // --read-only maps to permissionMode "default"; --model threads through.
    const ro = jsonOne(cli(w, ["task", "ro task", "--profile", "p-ok", "--read-only", "--model", "kimi-x", "--json"]));
    let job = readJobJson(w, ro.jobId);
    assert.equal(job.request.permissionMode, "default", "--read-only -> permissionMode default");
    assert.equal(job.request.model, "kimi-x", "--model -> request.model");

    // default (no --read-only) is the legacy bypass; --write is its no-op synonym.
    const def = jsonOne(cli(w, ["task", "rw task", "--profile", "p-ok", "--json"]));
    assert.equal(readJobJson(w, def.jobId).request.permissionMode, "bypassPermissions");

    // --prompt-file: the prompt comes from the file, not argv.
    const pf = path.join(w.ws, "prompt.md");
    fs.writeFileSync(pf, "prompt from a file");
    const fileJob = jsonOne(cli(w, ["task", "--prompt-file", pf, "--profile", "p-ok", "--json"]));
    assert.equal(fileJob.status, "completed");
    assert.equal(fileJob.resultText, "echo:prompt from a file");
  } finally { w.cleanup(); }
});

test("e2e: --resume-job links a follow-up to the source job's settings + session", () => {
  const w = makeWorkspace();
  try {
    const first = jsonOne(cli(w, ["task", "first", "--profile", "p-ok", "--json"]));
    assert.equal(first.status, "completed");
    assert.equal(first.sessionId, "sess-fake-1");

    const resumed = jsonOne(cli(w, ["task", "follow up", "--resume-job", first.jobId, "--json"]));
    assert.equal(resumed.status, "completed");
    const job = readJobJson(w, resumed.jobId);
    assert.equal(job.request.resumedFrom, first.jobId, "resumed job links resumedFrom");
    assert.equal(job.request.resumeSessionId, "sess-fake-1", "resumed job reuses the source session id");
  } finally { w.cleanup(); }
});

test("e2e: machine-contract guards reject misuse (renamed/mutex/traversal/recursion)", () => {
  const w = makeWorkspace();
  try {
    assert.notEqual(cli(w, ["task", "x", "--profile", "p-ok", "--resume-id", "delegate-x"]).status, 0, "--resume-id is renamed -> error");
    assert.notEqual(cli(w, ["task", "x", "--profile", "p-ok", "--wait", "--background"]).status, 0, "--wait + --background mutually exclusive");
    assert.notEqual(cli(w, ["cancel", "../../etc/passwd"]).status, 0, "traversal job id rejected");
    assert.notEqual(cli(w, ["result", "../../x"]).status, 0, "traversal job id rejected");
    const rec = spawnSync(process.execPath, [COMPANION, "task", "x", "--profile", "p-ok"], {
      cwd: w.ws, env: { ...w.env, CLAUDE_DELEGATE_ACTIVE: "1" }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(rec.status, 0);
    assert.match(rec.stdout, /recursion guard/i);
  } finally { w.cleanup(); }
});
