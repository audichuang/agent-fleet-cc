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
// **升級 timer 刻意 ref(不 unref)** —— 這是不變量 3(「cancel 必殺乾淨:整個 process group,
// 孫子不留」)唯一的靠山。它曾經 unref,而那讓保證變成空的:worker-entry 在 runWorker
// resolve 的瞬間就 `process.exit()`,unref 的 timer 不撐 event loop,所以 leader 比 grace
// 先關的時候(同 pgid 的孫子改掉 stdio、無視 TERM 活著),那一槍**永遠不會開**,孫子活過
// job 的終態。ref 之後語意才對:「殺完才准離開」。
//
// 代價是 kill 路徑上 process 多活 graceMs —— 那正是我們要的。happy path 完全不呼叫這裡,
// 所以沒有成本。installCancelForwarder 的 forceExitMs(7000)大於預設 graceMs(5000),
// 所以硬退出仍在升級之後。
// 回傳 handle 給呼叫端;**別拿 child 的 'close' 當「group 空了」的證據去取消它**(試過,
// 那正是上面那個洩漏)。只有能證明 group 已空的呼叫端才有資格取消。
export function killGroupWithGrace(pid, { graceMs = 5000, scheduleImpl = setTimeout, killImpl = process.kill } = {}) {
  killProcessGroup(pid, "SIGTERM", killImpl);
  return scheduleImpl(() => killProcessGroup(pid, "SIGKILL", killImpl), graceMs);
}
