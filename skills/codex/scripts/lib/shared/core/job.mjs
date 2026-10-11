// shared/lib/core/job.mjs
import crypto from "node:crypto";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
]);

export function newJobId(prefix, now = Date.now()) {
  return `${prefix}-${now.toString(36).padStart(8, "0")}-${crypto.randomBytes(3).toString("hex")}`;
}

// 統一 Job schema 工廠(spec §3)。核心欄位攤平;引擎特定參數整包進 request。
/**
 * @param {{ engine?: string, title?: string, cwd?: string, timeoutMs?: number | null, request?: Record<string, any>, now?: Date }} [options]
 */
export function createJobRecord({
  engine,
  title = "",
  cwd = process.cwd(),
  timeoutMs = null,
  request = {},
  now = new Date(),
} = {}) {
  if (!engine) throw new Error("createJobRecord requires an engine name");
  const iso = now.toISOString();
  return {
    id: newJobId(engine, now.getTime()),
    engine,
    status: "queued",
    createdAt: iso,
    updatedAt: iso,
    title,
    cwd,
    pid: null,
    sessionId: null,
    exitCode: null, // session 型引擎無單一退出碼 — 永遠允許 null
    error: null,
    errorKind: null,
    phase: null,
    resultText: null,
    durationMs: null,
    timeoutMs,
    model: request.model ?? null,
    usage: null, // { inputTokens, outputTokens } | null — 成本遙測
    request,
  };
}
