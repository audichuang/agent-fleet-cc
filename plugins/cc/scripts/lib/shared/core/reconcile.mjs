// shared/lib/core/reconcile.mjs
import fs from "node:fs";
import { TERMINAL_STATUSES } from "./job.mjs";
import {
  listJobs,
  readJob,
  writeJob,
  finalizeJob,
  readTerminalLock,
  lockFilePath,
} from "./state-store.mjs";

// 終態 claim 一般只在 O_EXCL claim 與寫 JSON 之間存活幾微秒;一個 claim 若在
// 還活著的 job 上撐過這麼久,就是 claimer 崩了(無論 pid 死活)。寬鬆(遠超任何
// GC/IO 卡頓)但夠小,讓卡住的 job 一分鐘內自癒。
const TERMINAL_CLAIM_TTL_MS = 60_000;

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

// terminal.lock 的 claim 是否已成孤兒 — 不會有人來補完它了 — reconcile 可接手?
// 活著的 claimer(claim 擁有者 pid 活 + claim 新鮮)是進行中的 finalize,必須留著
// (即使 job.json 的 worker pid 已死:獨立的 finalizer 如 watchdog/cancel 可在
// worker 死後仍在寫終態,絕不能搶它、覆蓋它更豐富的紀錄)。
//
// 有效 claimer = lock 自帶的 owner pid(可辨識時),否則退回 worker pid:在「worker
// 自己 finalize」的模型裡 worker 就是 claimer,所以一個 owner 無法辨識、由死掉的
// worker 留下的 lock 就是孤兒。判定孤兒:有效 claimer 死,或 claim 比 TTL 老
// (recycled pid;或 malformed/empty 的 claimer 崩在 O_EXCL create 與寫 payload 之間)。
// 新鮮且(claimer 活 或 無可辨識 claimer)→ 進行中的 finalize / live holder mid-acquire,留著。
export function isClaimOrphaned(
  stateDir,
  jobId,
  { isAlive = isPidAlive, nowMs = Date.now(), ttlMs = TERMINAL_CLAIM_TTL_MS, workerPid = null } = {},
) {
  let raw;
  try {
    raw = fs.readFileSync(lockFilePath(stateDir, jobId), "utf8");
  } catch {
    return false; // 沒有 lock
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  const isObj = parsed !== null && typeof parsed === "object";
  // 一個帶「已知終態 status」的 lock 是 COMPLETE claim:claimer 已寫完 payload。
  // 沒有已知 status(空檔/半寫/垃圾)是 INCOMPLETE:claimer 可能還在 O_EXCL create
  // 與寫 payload 之間(live holder mid-acquire),也可能崩在中途。
  const hasStatus = isObj && TERMINAL_STATUSES.has(parsed.status);

  const at = isObj && parsed.at ? Date.parse(parsed.at) : NaN;
  let ageMs;
  if (Number.isFinite(at)) {
    ageMs = nowMs - at;
  } else {
    try {
      ageMs = nowMs - fs.statSync(lockFilePath(stateDir, jobId)).mtimeMs;
    } catch {
      return false;
    }
  }

  if (hasStatus) {
    // COMPLETE claim:claimer = lock 自帶 owner pid(可辨識時)否則退回 worker pid。
    // claimer 死 → 孤兒;活著但過 TTL = recycled pid → 孤兒;活著且新鮮 → 進行中,留著。
    const claimerPid = safePid(isObj ? parsed.pid : null) ?? safePid(workerPid);
    if (claimerPid && !isAlive(claimerPid)) return true;
    return ageMs > ttlMs;
  }
  // INCOMPLETE claim:絕不能因 worker pid 死就回收 — 那可能是另一個活著的 finalizer
  // 卡在 create 與寫 payload 之間。只有過 TTL(claimer 確實崩在中途)才算孤兒。
  return ageMs > ttlMs;
}

export function reconcileDeadPids(stateDir, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const nowMs = deps.nowMs ?? Date.now();
  const ttlMs = deps.ttlMs ?? TERMINAL_CLAIM_TTL_MS;
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
      //
      // 只在 claim 已成孤兒時才補。孤兒與否純由 CLAIM(lock owner,worker pid 為退路)
      // 的死活/新鮮度判定,不看 worker pid 本身:獨立的 finalizer(cancel/watchdog)可在
      // worker 死後仍持有 lock 寫終態——這時 worker pid 雖死,但 claim 仍活,絕不能搶它
      // 覆蓋它更豐富的紀錄(否則就是 over-reclaim)。反之 worker 活但 claim 是死掉的獨立
      // finalizer 留下的孤兒時,worker 自己的 finalize 會 EEXIST 補不了,必須由此處補。
      if (!isClaimOrphaned(stateDir, job.id, { isAlive, nowMs, ttlMs, workerPid: pid })) {
        continue; // 進行中的 finalize / live holder mid-acquire → 留著
      }
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
    // F3:queued job 也要 cover。background spawn 後 worker-entry 會先 stamp
    // 自己的 pid;若 launcher 在 markJobRunning 之前就崩潰,job 停在 "queued"
    // 但帶了一個死 pid → 視同 running 死 pid 一併 finalize。無 pid 的 queued
    // (剛寫入、worker 尚未 stamp)仍 continue,不誤殺正常排隊中的 job。
    if ((job.status !== "running" && job.status !== "queued") || !pid) continue;
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
