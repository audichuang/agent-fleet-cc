// shared/lib/core/wait.mjs
import { TERMINAL_STATUSES } from "./job.mjs";
import { readEvents } from "./events.mjs";
import { readJob, jobDir } from "./state-store.mjs";

// 編排 re-entry 動詞的核心(spec §2.3):poll 到終態或超時,把新增 events
// 透傳給 onEvent 當進度心跳。超時不是錯誤 — 回 done:false 由呼叫端再 wait。
export function waitForJob({
  stateDir,
  jobId,
  timeoutMs,
  pollMs = 500,
  onEvent = () => {},
  // reconcile-each-poll(F1):worker 中途死亡時 job.json 停在 "running" 帶死 pid,
  // 不主動 reconcile 就會卡到 timeout(wait 至 timeoutMs,logs --follow 至 24h)。
  // 預設 no-op:不傳 reconcile 的呼叫端行為與舊版完全相同(向後相容)。
  reconcile = () => {},
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  nowImpl = Date.now,
}) {
  const deadline = nowImpl() + timeoutMs;
  let emitted = -1;
  const drain = () => {
    const fresh = readEvents(jobDir(stateDir, jobId), { afterIndex: emitted });
    for (const event of fresh) {
      emitted += 1;
      onEvent(event);
    }
  };
  return (async () => {
    for (;;) {
      // 每輪 poll 先 reconcile,再 readJob:死 pid 的 running/queued job 會被
      // terminalize,下一行 readJob 立刻看到終態並回傳,不必空等到 timeout。
      reconcile(stateDir);
      const job = readJob(stateDir, jobId);
      drain();
      if (!job) return { done: true, job: null };
      if (TERMINAL_STATUSES.has(job.status)) return { done: true, job };
      if (nowImpl() >= deadline) return { done: false, job };
      await sleepImpl(pollMs);
    }
  })();
}
