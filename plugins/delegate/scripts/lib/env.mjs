// Spec §7: the delegate env is REBUILT, never inherited. Strip every
// main-session provider/runtime var, then inject the profile's env block as
// real process env (belt-and-suspenders vs settings precedence), then add the
// recursion marker. Same trick as claudecode-telegram's clean_env, extended.
const DENY_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CLAUDECODE"];

// Spec §7 deliberately keeps HOME and CLAUDE_CONFIG_DIR shared: user-level
// skills/subagents live under the (possibly custom) config dir, and stripping
// it would defeat the ecosystem-reuse selling point. Model-routing isolation
// is still guaranteed by the strip + profile-env injection.
const PRESERVED_KEYS = new Set(["CLAUDE_CONFIG_DIR"]);

export const RECURSION_MARKER = "CLAUDE_DELEGATE_ACTIVE";

export function buildDelegateEnv({ baseEnv = process.env, profileEnv = {} } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (
      DENY_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
      !PRESERVED_KEYS.has(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(profileEnv)) {
    // Primitives are coerced like child_process would; nullish is skipped.
    // Objects/arrays are rejected earlier, at profile-resolve time.
    if (value === null || value === undefined || typeof value === "object") continue;
    env[key] = String(value);
  }
  env[RECURSION_MARKER] = "1";
  return env;
}
