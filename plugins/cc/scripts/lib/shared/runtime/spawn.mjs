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
// 回傳 SIGKILL 升級的 timer handle,讓呼叫端在 child 已經自己收乾淨之後取消它。
// 不取消的話,那個 callback 仍會在 graceMs 後對 pgid 開槍 —— pid 已死且 pgid 被系統回收時,
// 那一槍會打到不相干的 process group。handle 仍然 unref(不該讓它把 process 撐著),
// 但現在「可取消」是結構上成立的,而不是靠它剛好沒事。
export function killGroupWithGrace(pid, { graceMs = 5000, scheduleImpl = setTimeout, killImpl = process.kill } = {}) {
  killProcessGroup(pid, "SIGTERM", killImpl);
  const escalation = scheduleImpl(() => killProcessGroup(pid, "SIGKILL", killImpl), graceMs);
  escalation?.unref?.();
  return escalation;
}
