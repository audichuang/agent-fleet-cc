import { makeDataRoot, makeTempDir, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCompanion } from "../../plugins/cc/scripts/cc-companion.mjs";
import {
  writeJob,
  readJob,
  listJobs,
} from "../../plugins/cc/scripts/lib/shared/core/state-store.mjs";
import { workspaceStateDir } from "../../plugins/cc/scripts/lib/adapter.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

function setup() {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("cc-ws-");
  writeProfile(dataRoot, "kimi", { env: {} });
  const out = [];
  const deps = {
    env: { CC_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
    cwd,
    out: (line) => out.push(line),
    claudeSpawnImpl: (_b, _a, options) =>
      spawn(process.execPath, [FIXTURE], {
        ...options,
        env: { ...options.env, FAKE_CLAUDE_MODE: "success" },
      }),
  };
  return { out, deps, stateDir: workspaceStateDir(dataRoot, cwd) };
}

test("status reconciles dead pids before rendering", async () => {
  const { out, deps, stateDir } = setup();
  writeJob(stateDir, { id: "cc-z", status: "running", pid: 999999, createdAt: "a" });
  const code = await runCompanion(["status"], deps);
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, "cc-z").status, "failed");
  assert.match(out.join("\n"), /cc-z/);
});

test("result --last returns newest job; result with no jobs exits 1", async () => {
  const { out, deps } = setup();
  assert.equal(await runCompanion(["result", "--last"], deps), 1);
  await runCompanion(["task", "hi", "--profile", "kimi"], deps);
  out.length = 0;
  assert.equal(await runCompanion(["result", "--last"], deps), 0);
  assert.match(out.join("\n"), /echo:hi/);
});

test("cancel running job then result shows cancelled", async () => {
  const { out, deps, stateDir } = setup();
  writeJob(stateDir, { id: "cc-r", status: "running", pid: process.pid, createdAt: "a" });
  // process.pid 是活的 — 但 killImpl 不可注入到 companion 層，因此這裡只驗證
  // 狀態機：cancel 後 job 為 cancelled。對自己送 SIGTERM 是危險的，所以先把
  // pid 改成不存在的，讓 cancelJob 走「不發信號」分支。
  writeJob(stateDir, { ...readJob(stateDir, "cc-r"), pid: 999998 });
  const code = await runCompanion(["cancel", "cc-r"], deps);
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, "cc-r").status, "cancelled");
  assert.match(out.join("\n"), /Cancelled/);
});

test("setup reports claude binary and profile validity", async () => {
  const { out, deps } = setup();
  deps.spawnSyncImpl = () => ({ status: 0, stdout: "9.9.9 (fake)\n" });
  const code = await runCompanion(["setup"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /9\.9\.9/);
  assert.match(text, /✓ profile kimi/);
  assert.match(text, /default profile/);
});

test("setup exits 1 when claude CLI is missing or a profile is broken", async () => {
  const { deps } = setup();
  deps.spawnSyncImpl = () => ({ error: new Error("ENOENT"), status: null });
  assert.equal(await runCompanion(["setup"], deps), 1);

  const { deps: deps2, out: out2 } = setup();
  deps2.spawnSyncImpl = () => ({ status: 0, stdout: "9.9.9\n" });
  const dataRoot2 = deps2.env.CC_PLUGIN_DATA;
  (await import("node:fs")).default.writeFileSync(
    path.join(dataRoot2, "profiles", "broken.json"),
    "{nope",
  );
  assert.equal(await runCompanion(["setup"], deps2), 1);
  assert.match(out2.join("\n"), /✗ profile broken/);
});

test("setup auto-creates a native profile when none exist", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("cc-ws-");
  const out = [];
  const deps = {
    env: { CC_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
    cwd,
    out: (line) => out.push(line),
    spawnSyncImpl: () => ({ status: 0, stdout: "9.9.9 (fake)\n" }),
  };
  const code = await runCompanion(["setup"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /created native profile/);
  assert.match(text, /✓ profile native/);
  const fs = (await import("node:fs")).default;
  assert.equal(
    fs.readFileSync(path.join(dataRoot, "profiles", "native.json"), "utf8").trim(),
    "{}",
  );
});

test("setup auto-creates native, then task auto-selects it (no --profile)", async () => {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("cc-ws-");
  const out = [];
  const deps = {
    env: { CC_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
    cwd,
    out: (line) => out.push(line),
    spawnSyncImpl: () => ({ status: 0, stdout: "9.9.9 (fake)\n" }),
    claudeSpawnImpl: (_b, _a, options) =>
      spawn(process.execPath, [FIXTURE], {
        ...options,
        env: { ...options.env, FAKE_CLAUDE_MODE: "success" },
      }),
  };
  assert.equal(await runCompanion(["setup"], deps), 0); // 自動建 native
  assert.equal(await runCompanion(["task", "hi"], deps), 0); // 免 --profile
  const jobs = listJobs(workspaceStateDir(dataRoot, cwd));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].request.profile, "native");
});

test("unknown command prints usage and exits 1", async () => {
  const { out, deps } = setup();
  const code = await runCompanion(["bogus"], deps);
  assert.equal(code, 1);
  assert.match(out.join("\n"), /usage:/);
});

test("status --json emits an array of core-field projections", async () => {
  const { out, deps, stateDir } = setup();
  writeJob(stateDir, { id: "cc-z", status: "running", pid: 999999, createdAt: "a" });
  const code = await runCompanion(["status", "--json"], deps);
  assert.equal(code, 0);
  const arr = JSON.parse(out.join("\n"));
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length >= 1, "expected at least one job in the array");
  assert.ok("engine" in arr[0] && "jobId" in arr[0] && "status" in arr[0]);
});

test("cancel --json on unknown job emits {ok:false} and exits 1", async () => {
  const { out, deps } = setup();
  const code = await runCompanion(["cancel", "cc-nope", "--json"], deps);
  assert.equal(code, 1);
  const payload = JSON.parse(out.join("\n"));
  assert.equal(payload.ok, false);
  assert.ok(typeof payload.message === "string" && payload.message.length > 0);
});

test("result --json emits the unified result projection; cancel --json emits {ok,message}", async () => {
  // Part 1: result --json on a completed job returns resultProjection fields
  const { out: out1, deps: deps1 } = setup();
  await runCompanion(["task", "hello", "--profile", "kimi"], deps1);
  out1.length = 0;
  const code1 = await runCompanion(["result", "--last", "--json"], deps1);
  assert.equal(code1, 0);
  const proj = JSON.parse(out1.join("\n"));
  assert.ok("engine" in proj && "jobId" in proj && "status" in proj);
  assert.equal(proj.engine, "cc");
  assert.equal(proj.status, "completed");

  // Part 2: cancel --json on a running job emits {ok:true, message:/Cancelled/}
  const { out: out2, deps: deps2, stateDir: stateDir2 } = setup();
  writeJob(stateDir2, { id: "cc-r", status: "running", pid: process.pid, createdAt: "a" });
  writeJob(stateDir2, { ...readJob(stateDir2, "cc-r"), pid: 999998 });
  const code2 = await runCompanion(["cancel", "cc-r", "--json"], deps2);
  assert.equal(code2, 0);
  const cancelResult = JSON.parse(out2.join("\n"));
  assert.equal(cancelResult.ok, true);
  assert.match(cancelResult.message, /Cancelled/);
});
