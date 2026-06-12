// shared/lib/core/events.mjs
import fs from "node:fs";
import path from "node:path";

// 正規化事件最小集(spec §3)。狀態真相在 job.json;這裡是觀測脊椎。
export const EVENT_TYPES = [
  "job-created",
  "spawned",
  "engine-event",
  "result",
  "finalized",
];
const TYPE_SET = new Set(EVENT_TYPES);

export function eventsFilePath(jobDir) {
  return path.join(jobDir, "events.ndjson");
}

export function appendEvent(jobDir, type, data = {}) {
  if (!TYPE_SET.has(type)) throw new Error(`unknown event type: ${type}`);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
  fs.appendFileSync(eventsFilePath(jobDir), line + "\n", { mode: 0o600 });
}

export function readEvents(jobDir, { afterIndex = -1 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(eventsFilePath(jobDir), "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && TYPE_SET.has(parsed.type)) events.push(parsed);
    } catch {
      // junk line — 容錯跳過,永不 fatal
    }
  }
  return events.slice(afterIndex + 1);
}
