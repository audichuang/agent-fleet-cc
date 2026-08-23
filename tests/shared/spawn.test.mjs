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
  // timeoutMs 要留給 fixture 的 readiness 握手足夠餘裕(它的預算是 1500ms):TERM 若在
  // leader 印出 pid 之前就到,測試會因為缺 PID 而紅,那是假紅不是真紅。
  const record = createJobRecord({ engine: "fake", timeoutMs: 3000 });
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
  // 判定一:worker 在 resolve 之前對**引擎自己那個 group** 發出了 SIGKILL。
  // 綁定到 leader 的 pgid,不是任意負數 —— review 把 reap 改成 signal child.pid+1,
  // 而寬鬆的 /SIGNAL -\d+ SIGKILL/ 照樣綠(記到錯的 group,真正殺掉它的是那個沒被記錄的
  // 排程升級)。所以這裡必須指名。
  const lm = stderr.match(/LEADER (\d+)/);
  assert.ok(lm, `entry must report the leader pid; stderr was: ${stderr}`);
  const leaderPid = Number(lm[1]);
  const kill = stderr.match(new RegExp(`SIGNAL -${leaderPid} SIGKILL (\\d+)`));
  assert.ok(kill, `worker must SIGKILL the engine's own group (-${leaderPid}); signals were: ${stderr}`);
  // 判定一之二:它**等完了 grace**,不是立刻開槍。round 9 的立即版會砍斷正在處理 TERM
  // 的後代;把它改回立即,44 條 shared 測試全綠 —— 這個斷言就是補上那個缺口。
  const term = stderr.match(new RegExp(`SIGNAL -${leaderPid} SIGTERM (\\d+)`));
  assert.ok(term, `expected a group SIGTERM first; signals were: ${stderr}`);
  const waited = Number(kill[1]) - Number(term[1]);
  assert.ok(
    waited >= 150,
    `SIGKILL must wait out the grace (graceMs=200), waited ${waited}ms; signals were: ${stderr}`,
  );
  // 判定二:效果。入口已經 process.exit() 了,排程的升級隨它一起消失,所以孫子若還活著就是
  // 永遠活著。
  assert.ok(
    await waitGone(grandchildPid, 1500),
    "the descendant outlived the worker entry — invariant 3 is only satisfiable by killing before resolve",
  );
});
