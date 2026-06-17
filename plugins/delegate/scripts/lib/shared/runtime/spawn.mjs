// shared/lib/runtime/spawn.mjs
import { spawn } from "node:child_process";

// process seam(spec §5):detached:true 讓引擎 child 自成 process group
// (pgid = child.pid)。引擎會帶起孫子(claude -p 的 MCP server 等),
// cancel/timeout 殺 -pgid 才不會留殭屍引擎燒 API 錢。
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
export function killGroupWithGrace(pid, { graceMs = 5000, scheduleImpl = setTimeout, killImpl = process.kill } = {}) {
  killProcessGroup(pid, "SIGTERM", killImpl);
  scheduleImpl(() => killProcessGroup(pid, "SIGKILL", killImpl), graceMs)?.unref?.();
}
