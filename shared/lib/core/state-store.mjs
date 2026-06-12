// shared/lib/core/state-store.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TERMINAL_STATUSES } from "./job.mjs";
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
