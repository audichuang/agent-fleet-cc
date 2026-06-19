// shared/lib/core/env.mjs
// 引擎 env 是重建的,不是繼承的(delegate「env 完全重建」的一般化,spec §5)。
// 剝掉主 session 注入的 provider/runtime 變數 → 疊加 adapter/profile 顯式 env
// → 設遞迴守衛標記。worker 在 spawn 前強制走這裡,adapter 不可繞過。
export const DENY_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CLAUDECODE"];
// 刻意保留:使用者級 skills/subagents 活在(可能自訂的)config dir 下,
// 剝掉它會毀掉生態重用;模型路由隔離仍由 strip + 顯式注入保證。
export const DEFAULT_PRESERVED = new Set(["CLAUDE_CONFIG_DIR"]);

export function buildEngineEnv({
  baseEnv = process.env,
  engineEnv = {},
  recursionMarker,
  preserveKeys = DEFAULT_PRESERVED,
  denyPrefixes = DENY_PREFIXES,
} = {}) {
  if (!recursionMarker) {
    throw new Error("buildEngineEnv requires a recursionMarker (recursion guard is not optional)");
  }
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (denyPrefixes.some((p) => key.startsWith(p)) && !preserveKeys.has(key)) {
      continue;
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(engineEnv)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    env[key] = String(value);
  }
  env[recursionMarker] = "1";
  return env;
}
