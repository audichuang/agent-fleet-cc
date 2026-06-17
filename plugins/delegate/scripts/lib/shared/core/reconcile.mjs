// shared/lib/core/reconcile.mjs
import { TERMINAL_STATUSES } from "./job.mjs";
import {
  listJobs,
  readJob,
  writeJob,
  finalizeJob,
  readTerminalLock,
} from "./state-store.mjs";

// 只 signal 真實單一程序 pid。process.kill() 樂於接受 0/負數/數字字串並
// signal 整個 process group(kill(-1) = 所有程序)— 被污染的 job JSON
// 永遠不可有這個能力。
export function safePid(pid) {
  const n = typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : pid;
  return Number.isInteger(n) && n > 1 ? n : null;
}

export function isPidAlive(pid) {
  const n = safePid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function reconcileDeadPids(stateDir, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  // _hooks.beforeFreshRead(jobId) — 測試縫,在 lock-repair 分支 re-read JSON 之前
  // 注入競態(winner 完成寫入 / prune 刪 json),驗守衛能攔下這兩種情況。
  const beforeFreshRead = deps._hooks?.beforeFreshRead ?? (() => {});
  const reconciled = [];
  for (const job of listJobs(stateDir)) {
    if (TERMINAL_STATUSES.has(job.status)) continue;
    const pid = safePid(job.pid);
    const lock = readTerminalLock(stateDir, job.id);
    if (lock) {
      // 終態被 claim 但 JSON 沒跟上(finalizer 死了,或 worker 的 running 寫
      // 覆蓋了)。替 winner 補完,但必須先 re-read 確認:
      // (1) 若 readJob 回 null → job 已被 prune(json 先刪、lock 尚存的中間窗口)
      //     → 跳過,避免 writeJsonAtomic 重建目錄使死 job 復生。
      // (2) 若 readJob 回終態 → winner 的 finalizeJob 已補完 JSON → 跳過,
      //     避免以 stale 快照覆蓋 winner 已寫的 resultText/sessionId 等欄位。
      if (pid && isAlive(pid)) continue; // 活著的 worker 會自己收斂
      beforeFreshRead(job.id); // 測試縫:注入競態後才 re-read
      const fresh = readJob(stateDir, job.id);
      if (!fresh) continue; // half-prune race:json 已刪,勿復活
      if (TERMINAL_STATUSES.has(fresh.status)) continue; // winner 已補完,勿覆寫
      writeJob(stateDir, {
        ...fresh,
        status: lock.status ?? "failed",
        error: fresh.error ?? "finalizer died mid-transition (repaired from lock)",
      });
      reconciled.push(job.id);
      continue;
    }
    if (job.status !== "running" || !pid) continue;
    if (isAlive(pid)) continue;
    if (
      finalizeJob(stateDir, job.id, {
        status: "failed",
        error: "worker process died (reconciled dead pid)",
      })
    ) {
      reconciled.push(job.id);
    }
  }
  return reconciled;
}
