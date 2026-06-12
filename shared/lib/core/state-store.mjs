// shared/lib/core/state-store.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./job.mjs";
import { appendEvent } from "./events.mjs";

// 目錄式佈局(spec §3):jobs/<id>/{job.json,prompt.txt,events.ndjson,log}
export function jobsRoot(stateDir) {
  return path.join(stateDir, "jobs");
}
export function jobDir(stateDir, jobId) {
  return path.join(jobsRoot(stateDir), jobId);
}
export function jobFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "job.json");
}
export function promptFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "prompt.txt");
}
export function logFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "log");
}
export function lockFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "terminal.lock");
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  // 0600/0700:job 目錄含 prompt/result/log — 一律 owner-only。
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createJob(stateDir, record, prompt) {
  const dir = jobDir(stateDir, record.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(promptFilePath(stateDir, record.id), prompt, { mode: 0o600 });
  writeJsonAtomic(jobFilePath(stateDir, record.id), record);
  appendEvent(dir, "job-created", { engine: record.engine, jobId: record.id });
  return record;
}

export function writeJob(stateDir, job) {
  writeJsonAtomic(jobFilePath(stateDir, job.id), {
    ...job,
    updatedAt: new Date().toISOString(),
  });
}

export function readJob(stateDir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFilePath(stateDir, jobId), "utf8"));
  } catch {
    return null;
  }
}

export function listJobs(stateDir) {
  let entries;
  try {
    entries = fs.readdirSync(jobsRoot(stateDir));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of entries) {
    const job = readJob(stateDir, name);
    if (job) jobs.push(job); // 壞目錄/in-flight — 跳過,永不 fatal
  }
  return jobs.sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

// --- CAS 區段:O_EXCL lock,first terminal writer wins ---
//
// Cross-process CAS:O_EXCL lock,first terminal writer wins。lock 內容記
// intended status,讓修復路徑(reconcile)能在 winner 死於 claim 與寫 JSON
// 之間時把轉移補完。

function claimTerminalTransition(stateDir, jobId, status) {
  fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      lockFilePath(stateDir, jobId),
      JSON.stringify({ pid: process.pid, status, at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// null = 無 lock;{ status } = 已被 claim。內容可能是垃圾 — JSON.parse("12345")
// 是合法 JSON(數字),guard 必須驗「物件且帶已知終態」。
export function readTerminalLock(stateDir, jobId) {
  let raw;
  try {
    raw = fs.readFileSync(lockFilePath(stateDir, jobId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && TERMINAL_STATUSES.has(parsed.status)) {
      return { status: parsed.status };
    }
  } catch {}
  return { status: null };
}

// _hooks 是測試縫:afterClaim() 在 O_EXCL claim 成功後、fresh re-read 之前
// 觸發,讓測試能構造「claim 成功後才發生的競態」(pid stamp 寫入、prune 刪 JSON)。
// 生產路徑不傳 _hooks,行為與原始實作完全相同。
export function finalizeJob(stateDir, jobId, patch, _hooks = {}) {
  if (!TERMINAL_STATUSES.has(patch.status)) {
    throw new Error(`finalizeJob requires a terminal status, got ${patch.status}`);
  }
  // 終態 JSON 表示有人已贏過 CAS — 即使 lock 被 prune 掉也要拒絕,
  // 讓 stale finalizer 永遠無法復活已 prune 的 job。
  const existing = readJob(stateDir, jobId);
  if (!existing || TERMINAL_STATUSES.has(existing.status)) return false;
  if (!claimTerminalTransition(stateDir, jobId, patch.status)) return false;
  // afterClaim hook:測試縫——在 claim 與 fresh 讀之間注入競態(pid stamp 或 prune)。
  _hooks.afterClaim?.();
  // claim 後重讀:prune 若在中間刪了 JSON,undo 自己的 lock 並退出。
  // 安全性依賴 prune 的 unlink 順序(json 先於 lock,見 pruneJobs)。
  const fresh = readJob(stateDir, jobId);
  if (!fresh) {
    try {
      fs.unlinkSync(lockFilePath(stateDir, jobId));
    } catch {}
    return false;
  }
  // fresh-merge 保住 claim 後才寫入的欄位(如 worker 的 pid stamp)—
  // cancelJob 靠它找到要 signal 的 pid。
  writeJob(stateDir, { ...fresh, ...patch });
  return true;
}

// queued → running,防著並發 canceller。回傳 running job;null 表示
// job 不在/已終態/lock 已被 claim — 呼叫端絕不可在 null 時 spawn。
// hooks.beforeRecheck 是測試縫。
export function markJobRunning(stateDir, jobId, patch = {}, hooks = {}) {
  if (readTerminalLock(stateDir, jobId)) return null;
  const job = readJob(stateDir, jobId);
  if (!job || TERMINAL_STATUSES.has(job.status)) return null;
  writeJob(stateDir, { ...job, ...patch, status: "running" });
  hooks.beforeRecheck?.();
  if (readTerminalLock(stateDir, jobId)) return null;
  return readJob(stateDir, jobId);
}

// pruneJobs:刪掉最舊的 terminal job 目錄,令總數不超過 max。
// unlink 順序是 load-bearing:job.json 必須先於 terminal.lock 消失。
// finalizeJob 在 claim 後 re-read JSON,靠「lock 可被 prune ⇒ JSON 已不在」
// 偵測並 undo post-prune claim。目錄最後整個移除。
// active job(queued/running)永遠不碰。
export function pruneJobs(stateDir, { max = 50 } = {}) {
  const jobs = listJobs(stateDir);
  const activeCount = jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const terminal = jobs
    .filter((j) => TERMINAL_STATUSES.has(j.status))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const keep = Math.max(0, max - activeCount);
  for (const job of terminal.slice(keep)) {
    // 1. job.json 先消失 — finalizeJob re-read 見 null 即 undo 自己的 lock claim。
    try {
      fs.unlinkSync(jobFilePath(stateDir, job.id));
    } catch {}
    // 2. terminal.lock 次之。
    try {
      fs.unlinkSync(lockFilePath(stateDir, job.id));
    } catch {}
    // 3. 整目錄最後移除(含 prompt.txt / events.ndjson / log 等殘餘)。
    fs.rmSync(jobDir(stateDir, job.id), { recursive: true, force: true });
  }
}
