// shared/lib/runtime/spawn.mjs
import { spawn } from "node:child_process";

// process seam(spec §5):detached:true 讓引擎 child 自成 process group
// (pgid = child.pid)。cancel/timeout 殺 -pgid 會帶走引擎及其「共用 pgid 的」
// 子孫(一般 child)。已知限制:孫子若自身以 detached/setsid 跳到獨立 pgid
// (部分 MCP server 可能如此),-pgid 殺不到它 — 需另以 process-tree 收尾
// (見 plan 的 follow-up)。
export function spawnEngine({ argv, env, cwd, spawnImpl = spawn }) {
  const [bin, ...args] = argv;
  return spawnImpl(bin, args, {
    cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function killProcessGroup(pid, signal = "SIGTERM", killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    killImpl(-pid, signal); // 負 pid = 整個 process group
  } catch {}
}

// TERM 先禮後兵,grace 後 KILL。timer unref — 不留住 event loop。
// TERM 先禮後兵,graceMs 後 KILL 整個 group。
//
// timer unref — 不留住 event loop。
//
// **這個升級 timer 不能被當成不變量 3 的靠山。** 試過 ref 它,沒用:worker-entry 在
// runWorker resolve 的瞬間就 `process.exit()`,而 `process.exit()` **無視 ref'd handle**
// (實測:ref'd timer 在顯式 exit 前不會開火)。所以「孫子必死」必須在**離開之前同步**做完 ——
// 那是 runWorker 的責任(見 worker.mjs finish() 裡的 killInitiated 收尾),不是這個 timer 的。
// 這裡的 grace 只是禮貌:讓引擎有機會自己乾淨退出。
// 回傳 handle 給呼叫端;**別拿 child 的 'close' 當「group 空了」的證據去取消它**(試過,
// 那會讓忽略 TERM 的孫子活下來)。只有能證明 group 已空的呼叫端才有資格取消。
export function killGroupWithGrace(pid, { graceMs = 5000, scheduleImpl = setTimeout, killImpl = process.kill } = {}) {
  killProcessGroup(pid, "SIGTERM", killImpl);
  const escalation = scheduleImpl(() => killProcessGroup(pid, "SIGKILL", killImpl), graceMs);
  escalation?.unref?.();
  return escalation;
}
