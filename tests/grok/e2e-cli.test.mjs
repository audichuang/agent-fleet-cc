// Black-box e2e: drives the REAL grok-companion.mjs CLI as a subprocess, with a
// real detached worker, a real store, and a real cancel asserted to REAP the
// engine process — using per-mode `grok` shims (no API key, runs in CI).
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
const COMPANION = path.join(HERE, "../../plugins/grok/scripts/grok-companion.mjs");
const FAKE_GROK = path.join(HERE, "fake-grok.mjs");

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, ms = 8000) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(50);
  return !alive(pid);
};

// Write a `grok` shim that bakes FAKE_GROK_MODE (+ pidfile) and answers --version.
function writeShim(dir, name, mode, pidfile) {
  const shim = path.join(dir, name);
  const pf = pidfile ? `FAKE_GROK_PIDFILE="${pidfile}" ` : "";
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 0.0.0-fake"; exit 0; fi\n` +
      `exec env FAKE_GROK_MODE=${mode} ${pf}"${process.execPath}" "${FAKE_GROK}" "$@"\n`,
    { mode: 0o755 },
  );
  return shim;
}

function makeWorkspace() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-data-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-ws-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-bin-"));
  const pidfile = path.join(data, "engine.pid");
  const shims = {
    ok: writeShim(bin, "grok-ok", "success"),
    hang: writeShim(bin, "grok-hang", "hang", pidfile),
    fail: writeShim(bin, "grok-fail", "fail"),
  };
  return {
    ws, data, pidfile, shims,
    cleanup() { for (const d of [data, ws, bin]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

function cli(w, args, { mode = "ok", timeout = 20000 } = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: w.ws,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GROK_PLUGIN_DATA: w.data, GROK_BIN: w.shims[mode] },
    encoding: "utf8",
    timeout,
  });
}

function jsonOne(res) {
  const lines = (res.stdout ?? "").split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, `--json must emit exactly one clean line; stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  return JSON.parse(lines[0]);
}

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
  while (Date.now() < end) {
    const j = readJobJson(w, jobId);
    if (j.status === want) return j;
    if (["completed", "failed", "cancelled", "timed-out"].includes(j.status) && j.status !== want) return j;
    await sleep(100);
  }
  return readJobJson(w, jobId);
}

test("setup reports the grok CLI version", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["setup"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /✓ grok CLI: grok 0\.0\.0-fake/);
  } finally { w.cleanup(); }
});

test("foreground task completes and --json emits one clean projection", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["task", "hello world", "--wait", "--json"]);
    const j = jsonOne(res);
    assert.equal(res.status, 0);
    assert.equal(j.engine, "grok");
    assert.equal(j.status, "completed");
    assert.match(j.resultText, /^echo:hello world/);
  } finally { w.cleanup(); }
});

test("background task reaches completed and result --last returns it", async () => {
  const w = makeWorkspace();
  try {
    const start = jsonOne(cli(w, ["task", "bg job", "--background", "--json"]));
    assert.equal(start.status, "queued");
    const job = await pollStatus(w, start.jobId, "completed");
    assert.equal(job.status, "completed");
    const res = cli(w, ["result", "--last", "--json"]);
    assert.equal(jsonOne(res).status, "completed");
  } finally { w.cleanup(); }
});

test("logs exposes the raw grok stream including thinking (issue #2 story 10)", () => {
  const w = makeWorkspace();
  try {
    const jobId = jsonOne(cli(w, ["task", "log me", "--wait", "--json"])).jobId;
    const logs = cli(w, ["logs", jobId]);
    assert.equal(logs.status, 0);
    assert.match(logs.stdout, /"type":"thought"/, "raw log must expose Grok's thinking");
    assert.match(logs.stdout, /"type":"text"/);
  } finally { w.cleanup(); }
});

test("logs --follow streams the raw grok thinking until terminal", async () => {
  const w = makeWorkspace();
  try {
    const start = jsonOne(cli(w, ["task", "follow me", "--background", "--json"]));
    await pollStatus(w, start.jobId, "completed");
    const logs = cli(w, ["logs", start.jobId, "--follow"]);
    assert.equal(logs.status, 0);
    assert.match(logs.stdout, /"type":"thought"/, "--follow must stream Grok's thinking");
    assert.match(logs.stdout, /"type":"end"/);
  } finally { w.cleanup(); }
});

test("cancel reaps the engine process and marks the job cancelled", async () => {
  const w = makeWorkspace();
  try {
    const start = jsonOne(cli(w, ["task", "long job", "--background", "--json"], { mode: "hang" }));
    const end = Date.now() + 10000;
    while (!fs.existsSync(w.pidfile) && Date.now() < end) await sleep(50);
    const enginePid = Number(fs.readFileSync(w.pidfile, "utf8"));
    assert.ok(alive(enginePid), "engine should be running before cancel");
    const res = cli(w, ["cancel", start.jobId, "--json"]);
    assert.equal(res.status, 0);
    assert.ok(await waitGone(enginePid), "engine pid must be reaped by cancel");
    assert.equal((await pollStatus(w, start.jobId, "cancelled")).status, "cancelled");
  } finally { w.cleanup(); }
});

test("engine failure is classified (401 → auth) and surfaced", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["task", "will fail", "--wait", "--json"], { mode: "fail" });
    const j = jsonOne(res);
    assert.equal(res.status, 1);
    assert.equal(j.status, "failed");
    assert.equal(j.errorKind, "auth");
  } finally { w.cleanup(); }
});

test("wait --timeout-s on a still-running job exits 10 with a compact liveness line", async () => {
  const w = makeWorkspace();
  try {
    const start = jsonOne(cli(w, ["task", "watch job", "--background", "--json"], { mode: "hang" }));
    assert.equal(start.status, "queued");
    await pollStatus(w, start.jobId, "running");
    // The watch-loop's timeout branch: wait returns after the interval with the
    // job still running → exit 10 and one liveness line (worker pid alive).
    const res = cli(w, ["wait", start.jobId, "--timeout-s", "1"], { mode: "hang" });
    assert.equal(res.status, 10, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, /alive✓/);
    assert.doesNotMatch(res.stdout, /no result text/); // not the terminal result render
    cli(w, ["cancel", start.jobId], { mode: "hang" }); // reap the hung engine
    await pollStatus(w, start.jobId, "cancelled");
  } finally { w.cleanup(); }
});
