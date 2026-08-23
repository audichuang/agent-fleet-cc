// tests/shared/spawn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnEngine,
  killProcessGroup,
  killGroupWithGrace,
} from "../../shared/lib/runtime/spawn.mjs";

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
test("killGroupWithGrace's SIGKILL escalation is ref'd — the process must not exit before it fires", () => {
  const signals = [];
  const timer = killGroupWithGrace(999_999, {
    graceMs: 50,
    killImpl: (pid, sig) => signals.push([pid, sig]),
  });
  try {
    assert.deepEqual(signals, [[-999_999, "SIGTERM"]], "TERM goes to the whole group first");
    assert.equal(typeof timer?.hasRef, "function", "must return a real timer handle");
    assert.equal(
      timer.hasRef(), true,
      "an unref'd escalation makes invariant 3 vacuous: the worker exits and SIGKILL never lands",
    );
  } finally {
    clearTimeout(timer); // 別讓測試自己被這個 ref'd timer 撐住 50ms
  }
});
