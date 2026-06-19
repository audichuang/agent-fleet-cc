// Black-box e2e: drives the REAL antigravity standalone CLI as a subprocess.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  resolveJobLogFile,
  ensureStateDir,
  upsertJob,
  writeJobFile,
} from "../../plugins/antigravity/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "plugins/antigravity/bin/antigravity.mjs");

function ws() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-"));
}

async function withDataDir(dataDir, fn) {
  const origData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return await fn();
  } finally {
    if (origData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = origData;
  }
}

async function seedJob(cwd, dataDir, id, status = "running") {
  return withDataDir(dataDir, async () => {
    const logFile = resolveJobLogFile(cwd, id);
    ensureStateDir(cwd);
    const terminal = !["running", "queued"].includes(status);
    const job = {
      id,
      kind: "task",
      status,
      phase: status,
      sessionId: "test-sess",
      pid: null,
      createdAt: new Date(2024, 0, 1).toISOString(),
      updatedAt: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
      logFile,
      ...(terminal ? { completedAt: new Date(2024, 0, 1, 0, 1).toISOString() } : {}),
    };
    await upsertJob(cwd, job);
    await writeJobFile(cwd, id, { ...job, request: null, result: null });
    return job;
  });
}

async function flip(cwd, dataDir, id, status) {
  return withDataDir(dataDir, async () => {
    const logFile = resolveJobLogFile(cwd, id);
    const job = {
      id,
      kind: "task",
      status,
      phase: status,
      sessionId: "test-sess",
      pid: null,
      createdAt: new Date(2024, 0, 1).toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      logFile,
    };
    await upsertJob(cwd, job);
    await writeJobFile(cwd, id, { ...job, request: null, result: null });
  });
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
  const job = await seedJob(cwd, dataDir, id, "running");
  fs.writeFileSync(job.logFile, "");

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

  const e = Buffer.from("é", "utf8");
  await delay(300);
  fs.appendFileSync(job.logFile, e.subarray(0, 1));
  await delay(1300);
  fs.appendFileSync(job.logFile, e.subarray(1));
  fs.appendFileSync(job.logFile, "X\n");
  await delay(1300);
  await flip(cwd, dataDir, id, "completed");

  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, "process exited non-zero: " + err + out);
  assert.match(out, /éX/, "expected éX in output");
  assert.ok(!out.includes("�"), "no UTF-8 replacement char in: " + JSON.stringify(out));
});

test("e2e: cancel with multiple active jobs resolves a unique substring", async () => {
  const cwd = ws();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-data-"));
  await seedJob(cwd, dataDir, "agy-c1-111", "running");
  await seedJob(cwd, dataDir, "agy-d2-222", "running");
  const res = runCli(cwd, dataDir, ["cancel", "c1", "--cwd", cwd, "--json"]);
  assert.equal(res.status, 0, "cancel by substring should exit 0: " + res.stderr);
  if (res.stderr) assert.doesNotMatch(res.stderr, /full id required/);
});

test("e2e: cancel with multiple active jobs resolves a 1-based index", async () => {
  const cwd = ws();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-data-"));
  await seedJob(cwd, dataDir, "agy-c1-111", "running");
  await seedJob(cwd, dataDir, "agy-d2-222", "running");
  const res = runCli(cwd, dataDir, ["cancel", "1", "--cwd", cwd, "--json"]);
  assert.equal(res.status, 0, "cancel by index should exit 0: " + res.stderr);
  if (res.stderr) assert.doesNotMatch(res.stderr, /full id required/);
});

test("e2e: cancel with multiple active jobs and no reference refuses to guess", async () => {
  const cwd = ws();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-data-"));
  await seedJob(cwd, dataDir, "agy-c1-111", "running");
  await seedJob(cwd, dataDir, "agy-d2-222", "running");
  const res = runCli(cwd, dataDir, ["cancel", "--cwd", cwd]);
  assert.notEqual(res.status, 0, "should exit non-zero when no ref given");
  assert.match(res.stderr ?? "", /Multiple active antigravity jobs/);
});
