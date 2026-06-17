import { makeDataRoot, makeTempDir, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCompanion } from "../../plugins/delegate/scripts/delegate-companion.mjs";
import {
  writeJob,
  readJob,
} from "../../plugins/delegate/scripts/lib/shared/core/state-store.mjs";
import { workspaceStateDir } from "../../plugins/delegate/scripts/lib/adapter.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

function setup() {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("delegate-ws-");
  writeProfile(dataRoot, "kimi", { env: {} });
  const out = [];
  const deps = {
    env: { DELEGATE_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
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
  writeJob(stateDir, { id: "dlg-z", status: "running", pid: 999999, createdAt: "a" });
  const code = await runCompanion(["status"], deps);
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, "dlg-z").status, "failed");
  assert.match(out.join("\n"), /dlg-z/);
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
  writeJob(stateDir, { id: "dlg-r", status: "running", pid: process.pid, createdAt: "a" });
  // process.pid 是活的 — 但 killImpl 不可注入到 companion 層，因此這裡只驗證
  // 狀態機：cancel 後 job 為 cancelled。對自己送 SIGTERM 是危險的，所以先把
  // pid 改成不存在的，讓 cancelJob 走「不發信號」分支。
  writeJob(stateDir, { ...readJob(stateDir, "dlg-r"), pid: 999998 });
  const code = await runCompanion(["cancel", "dlg-r"], deps);
  assert.equal(code, 0);
  assert.equal(readJob(stateDir, "dlg-r").status, "cancelled");
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
  const dataRoot2 = deps2.env.DELEGATE_PLUGIN_DATA;
  (await import("node:fs")).default.writeFileSync(
    path.join(dataRoot2, "profiles", "broken.json"),
    "{nope",
  );
  assert.equal(await runCompanion(["setup"], deps2), 1);
  assert.match(out2.join("\n"), /✗ profile broken/);
});

test("unknown command prints usage and exits 1", async () => {
  const { out, deps } = setup();
  const code = await runCompanion(["bogus"], deps);
  assert.equal(code, 1);
  assert.match(out.join("\n"), /usage:/);
});
