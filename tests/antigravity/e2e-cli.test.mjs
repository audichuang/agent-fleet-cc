// Black-box e2e: drives the REAL antigravity standalone CLI as a subprocess
// against the SHARED directory-per-job store (jobs/<id>/{job.json,log,...}).
//
// Post-migration the CLI runs on the vendored shared runtime, so seeding the
// old flat `state.json` + `jobs/<id>.json` layout would be invisible to the
// commands (readJob expects a directory). These helpers seed the shared layout
// directly via createJobRecord + createJob, and flip via finalizeJob, keying the
// stateDir exactly like the adapter (workspaceStateDir over CLAUDE_PLUGIN_DATA).
//
// The four regressions preserved verbatim:
//   1. logs --follow keeps a multibyte UTF-8 codepoint intact when split across
//      two poll boundaries (no U+FFFD replacement char).
//   2. cancel resolves a unique job-id SUBSTRING among multiple active jobs (exit 0).
//   3. cancel resolves a 1-based INDEX among multiple active jobs (exit 0).
//   4. cancel with >1 active jobs and no reference refuses to guess.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  resolveDataRoot,
  workspaceStateDir,
} from "../../plugins/antigravity/scripts/lib/adapter.mjs";
import { createJobRecord } from "../../plugins/antigravity/scripts/lib/shared/core/job.mjs";
import {
  createJob,
  writeJob,
  finalizeJob,
  logFilePath,
} from "../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "plugins/antigravity/bin/antigravity.mjs");

function ws() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-"));
}

// The stateDir the CLI will compute for (cwd, dataDir) — keyed EXACTLY like the
// adapter: CLAUDE_PLUGIN_DATA/state → workspaceStateDir (slug + 12-hex of the
// git root, falling back to cwd for a non-repo tmpdir). Must match so a
// directly-seeded job is the one the subprocess reads.
function stateDirFor(cwd, dataDir) {
  return workspaceStateDir(resolveDataRoot({ CLAUDE_PLUGIN_DATA: dataDir }), cwd);
}

// Seed an ACTIVE (running) job in the shared layout. GOTCHA: no pid — a running
// job carrying a bogus pid would be judged dead by reconcileDeadPids and flipped
// to failed before the command under test runs. With pid=null the reconciler
// leaves it running (isPidAlive(null) is treated as "our worker is elsewhere,
// leave it") so the job stays active until the test flips it itself.
function seedJob(cwd, dataDir, id, status = "running") {
  const stateDir = stateDirFor(cwd, dataDir);
  const record = createJobRecord({
    engine: "antigravity",
    title: "e2e seed",
    cwd,
    request: { kind: "task", mode: "print" },
    now: new Date(2024, 0, 1),
  });
  record.id = id;
  record.status = status;
  record.pid = null;
  record.sessionId = "test-sess";
  createJob(stateDir, record, "seed prompt");
  return { id, stateDir, logFile: logFilePath(stateDir, id) };
}

// Flip a seeded active job to a terminal status via the shared CAS finalizer.
function flip(cwd, dataDir, id, status) {
  const stateDir = stateDirFor(cwd, dataDir);
  const ok = finalizeJob(stateDir, id, { status });
  if (!ok) {
    // Already terminal (e.g. a concurrent reconcile) — force the status so the
    // follow loop still observes a terminal record and exits.
    const existing = { id, engine: "antigravity", status, pid: null };
    writeJob(stateDir, existing);
  }
}

function runCli(cwd, dataDir, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
}

test("e2e: logs --follow keeps multibyte UTF-8 intact when a codepoint is split across two polls", async () => {
  const cwd = ws();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-data-"));
  const id = "agy-utf8-1";
  const { logFile } = seedJob(cwd, dataDir, id, "running");
  fs.writeFileSync(logFile, "");

  const child = spawn(process.execPath, [BIN, "logs", id, "--follow", "--timeout-ms", "8000", "--cwd", cwd], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    err += d;
  });

  // Split the two-byte "é" (0xC3 0xA9) ACROSS a poll boundary: append byte 1,
  // wait longer than POLL_MS so the follow loop reads a lone continuation-less
  // lead byte, then append the rest. A byte-naive reader emits U+FFFD here; the
  // StringDecoder loop must reassemble it into "é".
  const e = Buffer.from("é", "utf8");
  await delay(300);
  fs.appendFileSync(logFile, e.subarray(0, 1));
  await delay(1300);
  fs.appendFileSync(logFile, e.subarray(1));
  fs.appendFileSync(logFile, "X\n");
  await delay(1300);
  flip(cwd, dataDir, id, "completed");

  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, "process exited non-zero: " + err + out);
  assert.match(out, /éX/, "expected éX in output");
  assert.ok(!out.includes("�"), "no UTF-8 replacement char in: " + JSON.stringify(out));
});

test("e2e: cancel with multiple active jobs resolves a unique substring", () => {
  const cwd = ws();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-data-"));
  seedJob(cwd, dataDir, "agy-c1-111", "running");
  seedJob(cwd, dataDir, "agy-d2-222", "running");
  const res = runCli(cwd, dataDir, ["cancel", "c1", "--cwd", cwd, "--json"]);
  assert.equal(res.status, 0, "cancel by substring should exit 0: " + res.stderr);
  if (res.stderr) assert.doesNotMatch(res.stderr, /full id required/);
});

test("e2e: cancel with multiple active jobs resolves a 1-based index", () => {
  const cwd = ws();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-data-"));
  seedJob(cwd, dataDir, "agy-c1-111", "running");
  seedJob(cwd, dataDir, "agy-d2-222", "running");
  const res = runCli(cwd, dataDir, ["cancel", "1", "--cwd", cwd, "--json"]);
  assert.equal(res.status, 0, "cancel by index should exit 0: " + res.stderr);
  if (res.stderr) assert.doesNotMatch(res.stderr, /full id required/);
});

test("e2e: cancel with multiple active jobs and no reference refuses to guess", () => {
  const cwd = ws();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-data-"));
  seedJob(cwd, dataDir, "agy-c1-111", "running");
  seedJob(cwd, dataDir, "agy-d2-222", "running");
  const res = runCli(cwd, dataDir, ["cancel", "--cwd", cwd]);
  assert.notEqual(res.status, 0, "should exit non-zero when no ref given");
  assert.match(res.stderr ?? "", /Multiple active antigravity jobs/);
});
