import fs from "node:fs";
import path from "node:path";

export class ProfileError extends Error {}

// Profile names are joined into the profiles dir path — reject traversal.
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function profilesDir(dataRoot) {
  return path.join(dataRoot, "profiles");
}

export function listProfiles(dataRoot) {
  let entries;
  try {
    entries = fs.readdirSync(profilesDir(dataRoot));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

function loadProfileFile(file, name) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ProfileError(`Profile "${name}" not found at ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProfileError(`Profile "${name}" is not valid JSON: ${file}`);
  }
  const env =
    parsed && typeof parsed.env === "object" && parsed.env !== null
      ? parsed.env
      : {};
  for (const [key, value] of Object.entries(env)) {
    // Fail fast pre-spawn: a nested object would otherwise be dropped (or
    // stringified to "[object Object]") and silently break auth/model config.
    if (value !== null && typeof value === "object") {
      throw new ProfileError(
        `Profile "${name}" env.${key} must be a string/number/boolean, not ${Array.isArray(value) ? "an array" : "an object"}`,
      );
    }
  }
  return { name, path: file, env, settings: parsed };
}

export function resolveProfile({ dataRoot, profile, settingsPath, env = process.env } = {}) {
  if (settingsPath) {
    const abs = path.resolve(settingsPath);
    return loadProfileFile(abs, path.basename(abs, ".json"));
  }
  const name = profile ?? env.CC_DEFAULT_PROFILE;
  if (!name) {
    const available = listProfiles(dataRoot);
    // 恰好一個 profile:無歧義 → 自動採用。這讓 cc:setup 自動建的 native 真正
    // 開箱即用(/cc:task 免帶 --profile),也讓 raw companion 呼叫端(例如其他
    // 引擎把任務外包給 cc)免去先查 profile 名。0 個或 2+ 個才需要使用者指定 —
    // 那才是「猜」,這裡不猜。
    if (available.length === 1) {
      return loadProfileFile(
        path.join(profilesDir(dataRoot), `${available[0]}.json`),
        available[0],
      );
    }
    throw new ProfileError(
      available.length
        ? `No profile specified. Use --profile <name> or set CC_DEFAULT_PROFILE. Available: ${available.join(", ")}`
        : `No profile specified and none exist. Create one at ${profilesDir(dataRoot)}/<name>.json (standard Claude Code settings format).`,
    );
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ProfileError(`Invalid profile name: ${name}`);
  }
  return loadProfileFile(path.join(profilesDir(dataRoot), `${name}.json`), name);
}
