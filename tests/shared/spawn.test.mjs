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

// 不變量 3(「cancel 必殺乾淨:整個 process group,孫子不留」)唯一的靠山是這個 timer 會
// **真的開火**。它曾經 unref,而 worker-entry 在 runWorker resolve 的瞬間就 process.exit()
// —— unref 的 timer 不撐 event loop,所以 leader 比 grace 先關時那一槍永遠不會開,孫子就活
// 過了 job 的終態。所以這裡直接釘「它是 ref 的」:那是 process 不會提早離開的唯一保證。
// 不變量 3 的**可觀測**測試(取代先前那條斷言 hasRef() 的代理版本 —— review 正確指出
// hasRef 只釘得住字面上的 .unref() 改動,證不到 production 的退出邊界)。
// 這裡真的跑 runWorker,真的生一個無視 TERM 的同 pgid 孫子,然後斷言 runWorker resolve
// 之後孫子已經死了 —— 那個時間點就是 worker-entry 會 process.exit() 的時間點。
// 不變量 3 的**可觀測**測試。前兩個版本都不算:斷言 hasRef() 是代理指標;in-process 跑
// runWorker 也不算 —— 測試行程不會顯式 exit,所以排程的 unref 升級照樣開火,把「有沒有同步
// 殺」這件事完全掩蓋掉(mutation 不打紅)。只有跨過真正的退出邊界才證得到:
// 起一個複製 production worker-entry 形狀(`.then(code => process.exit(code))`)的子行程,
// 等它退出,然後看那個無視 TERM 的同 pgid 孫子還在不在。
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
  const grandchildPid = Number(m[1]);
  // 入口已經 process.exit() 了。排程的升級隨那個行程一起消失,所以孫子若還活著就是永遠活著。
  assert.ok(
    await waitGone(grandchildPid, 1500),
    "the descendant outlived the worker entry — invariant 3 is only satisfiable by killing before resolve",
  );
});
