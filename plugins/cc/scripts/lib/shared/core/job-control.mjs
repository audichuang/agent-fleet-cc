// shared/lib/core/job-control.mjs
// cancel 兩段式殺的第一段(spec §5):CAS 先行、安全 pid、對 worker 發單一
// SIGTERM。第二段(引擎 child 的 process-group kill)由 worker 的
// installCancelForwarder 完成 — worker 與 child 各自 detached 成獨立 pgid,
// 從外面殺 -workerPid 殺不到 child 群。
import { TERMINAL_STATUSES } from "./job.mjs";
import { readJob, finalizeJob } from "./state-store.mjs";
import { safePid, isPidAlive } from "./reconcile.mjs";

// 順序是教訓(codex-plugin-cc):先 claim 終態,只有 CAS winner 可以 signal。
// loser 絕不 signal — 那個 pid 可能已被重用。
export function cancelJob(stateDir, jobId, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const killImpl = deps.killImpl ?? ((pid, sig) => process.kill(pid, sig));
  const job = readJob(stateDir, jobId);
  if (!job) return { ok: false, message: `No job ${jobId} in this workspace.` };
  if (TERMINAL_STATUSES.has(job.status)) {
    return { ok: false, message: `Job ${jobId} already ${job.status}.` };
  }
  deps.beforeFinalize?.(); // 測試縫:注入 worker 交錯
  if (!finalizeJob(stateDir, jobId, { status: "cancelled" })) {
    const latest = readJob(stateDir, jobId);
    return {
      ok: false,
      message: `Job ${jobId} already ${latest?.status ?? "finalized"}.`,
    };
  }
  // CAS 贏了才重讀 pid:queued 可能剛轉 running,finalizeJob 的 fresh-merge
  // 保住了 worker 的 pid stamp — post-finalize 的 JSON 才是準的。
  const pidToKill = safePid(readJob(stateDir, jobId)?.pid ?? job.pid);
  if (pidToKill && isAlive(pidToKill)) {
    try {
      killImpl(pidToKill, "SIGTERM");
    } catch {}
  }
  return { ok: true, message: `Cancelled ${jobId}.` };
}
