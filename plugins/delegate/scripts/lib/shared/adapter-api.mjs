// shared/lib/adapter-api.mjs
// ProcessAdapter 合約(spec §2/§5;藍圖 §5.2)。SessionAdapter 是第二合法
// 形態,無限期延後 — 但形態無關五不變量已寫死於 adapter-api.md,
// conformance 驗的是不變量,日後落地不得重簽。
const REQUIRED_STRINGS = ["name", "engine", "recursionMarker"];
const REQUIRED_FUNCTIONS = [
  "buildInvocation", // ({job, prompt}) → { argv, env, stdinPayload }
  "parseEvent",      // (rawLine) → 正規化事件 | null(容錯跳行)
  "extractResult",   // (events, exitCode) → { ok, resultText, sessionId, usage? }
  "classifyError",   // (stderrTail, exitCode) → errorKind 字串
  "resumeArgs",      // (sessionId) → 額外 argv 片段
];

export function validateProcessAdapter(adapter) {
  const problems = [];
  if (!adapter || typeof adapter !== "object") return ["adapter must be an object"];
  for (const key of REQUIRED_STRINGS) {
    if (typeof adapter[key] !== "string" || !adapter[key]) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  if (typeof adapter.wantsWatchdog !== "boolean") {
    problems.push("wantsWatchdog must be a boolean (reconcile policy declaration)");
  }
  for (const key of REQUIRED_FUNCTIONS) {
    if (typeof adapter[key] !== "function") {
      problems.push(`${key} must be a function`);
    }
  }
  return problems;
}
