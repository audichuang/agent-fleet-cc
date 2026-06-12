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
      const job = readJob(stateDir, jobId);
      drain();
      if (!job) return { done: true, job: null };
      if (TERMINAL_STATUSES.has(job.status)) return { done: true, job };
      if (nowImpl() >= deadline) return { done: false, job };
      await sleepImpl(pollMs);
    }
  })();
}
