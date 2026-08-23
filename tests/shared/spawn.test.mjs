// tests/shared/spawn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnEngine,
  killProcessGroup,
  killGroupWithGrace,
} from "../../shared/lib/runtime/spawn.mjs";
import { runWorker } from "../../shared/lib/runtime/worker.mjs";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { createJob } from "../../shared/lib/core/state-store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "grandchild-spawner.mjs");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
};

test("spawnEngine detaches into its own process group; pgid kill reaps grandchildren", async () => {
  const child = spawnEngine({
    argv: [process.execPath, FIXTURE],
    env: { ...process.env },
    cwd: process.cwd(),
  });
  const line = await new Promise((resolve) => {
    child.stdout.once("data", (chunk) => resolve(chunk.toString()));
  });
  const { childPid, grandchildPid } = JSON.parse(line);
  assert.equal(childPid, child.pid);
  assert.ok(alive(grandchildPid));
  killProcessGroup(child.pid, "SIGKILL");
  assert.ok(await waitGone(childPid), "child must die");
  assert.ok(await waitGone(grandchildPid), "grandchild must die (zombie engines burn API money)");
});

test("killProcessGroup never throws on dead/invalid pgid", () => {
  killProcessGroup(99999999, "SIGTERM");
  killProcessGroup(null, "SIGTERM");
});

// 不變量 3(「cancel 必殺乾淨:整個 process group,孫子不留」)的靠山**不是**這個排程的
// 升級 —— worker-entry 一 resolve 就 process.exit(),而 process.exit 無視 ref'd handle,
// 所以它在真入口上根本不保證開火(ref 過,實測無效)。真正的保證是 runWorker 在 resolve
// 之前同步送的那一發;下面那條跨行程測試才是它的證明。
test("invariant 3: a TERM-ignoring grandchild does not survive a real worker entry's process.exit", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-inv3-"));
  const record = createJobRecord({ engine: "fake", timeoutMs: 300 });
  createJob(stateDir, record, "the prompt");
  const entry = path.join(here, "fixtures", "worker-entry-shape.mjs");
  const engineFixture = path.join(here, "fixtures", "term-ignoring-grandchild.mjs");
  const proc = spawn(process.execPath, [entry, stateDir, record.id, engineFixture], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (c) => { stderr += c.toString(); });
  await new Promise((resolve) => proc.once("close", resolve));
  const m = stderr.match(/GRANDCHILD (\d+)/);
  assert.ok(m, `entry must report the grandchild pid; stderr was: ${stderr}`);
  assert.match(stderr, /READY true/, "the fixture must confirm the descendant installed its TERM handler");
  const grandchildPid = Number(m[1]);
  // 判定一:worker **在 resolve 之前**確實發出了整組 SIGKILL。負 pid = process group。
  // 這條不依賴時序,所以排程的升級不可能冒充它(兩者都落在 killedAt+grace)。
  assert.match(
    stderr, /SIGNAL -\d+ SIGKILL/,
    `the worker must issue a group SIGKILL before resolving; signals were: ${stderr}`,
  );
  // 判定二:效果。入口已經 process.exit() 了,排程的升級隨它一起消失,所以孫子若還活著就是
  // 永遠活著。
  assert.ok(
    await waitGone(grandchildPid, 1500),
    "the descendant outlived the worker entry — invariant 3 is only satisfiable by killing before resolve",
  );
});
