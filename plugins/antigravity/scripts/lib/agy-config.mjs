/**
 * Workspace-level config for antigravity (spec D-6 / codex must-fix M2).
 *
 * The shared runtime is jobs-only — it has no workspace-level config container
 * (state.json is gone under the dir-per-job layout). antigravity keeps a single
 * setting, `stopReviewGate`, so config lives in its own `<stateDir>/config.json`
 * (sibling of the legacy `state.json`, same stateDir root).
 *
 * ONE-TIME MIGRATION: when `config.json` is absent but a legacy `state.json`
 * exists, `stopReviewGate` is seeded from `state.json.config` so an in-place
 * upgrade does not silently reset the user's gate. The legacy `state.json` is
 * left untouched (inert; may be deleted in a later phase).
 *
 * Keyed by `stateDir` (the workspace dir, e.g. `stateDirFor(cwd)` from
 * job-runtime), NOT by cwd — the shared store is stateDir-native.
 */

import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE_NAME = "config.json";
const LEGACY_STATE_FILE_NAME = "state.json";

/** The default config shape. Extend here if new settings are ever added. */
function defaultConfig() {
  return { stopReviewGate: false };
}

function configFilePath(stateDir) {
  return path.join(stateDir, CONFIG_FILE_NAME);
}

function legacyStateFilePath(stateDir) {
  return path.join(stateDir, LEGACY_STATE_FILE_NAME);
}

function readJsonOrNull(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null; // missing/unreadable
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null; // corrupt — treat as absent (safe: fall back to defaults)
  }
}

/**
 * Seed a fresh config.json from a legacy state.json.config block (D-6). Only
 * `stopReviewGate` migrates. Best-effort: a failed write is non-fatal (the
 * next getConfig/setConfig retries). Returns the migrated config object.
 */
function seedFromLegacy(stateDir) {
  const legacy = readJsonOrNull(legacyStateFilePath(stateDir));
  const migrated = {
    ...defaultConfig(),
    stopReviewGate: Boolean(legacy?.config?.stopReviewGate),
  };
  writeConfigAtomic(stateDir, migrated);
  return migrated;
}

function writeConfigAtomic(stateDir, config) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = configFilePath(stateDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort; a lost write leaves the previous config in place.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}

/**
 * Read the workspace config. If `config.json` is absent but a legacy
 * `state.json` exists, migrate `stopReviewGate` from it once (D-6).
 *
 * @param {string} stateDir
 * @returns {{ stopReviewGate: boolean }}
 */
export function getConfig(stateDir) {
  const existing = readJsonOrNull(configFilePath(stateDir));
  if (existing) {
    return { ...defaultConfig(), ...existing };
  }
  // No config.json yet. Seed from legacy state.json if it exists; otherwise
  // return defaults WITHOUT writing (a read must not create files on a fresh
  // workspace with no legacy state).
  if (fs.existsSync(legacyStateFilePath(stateDir))) {
    return seedFromLegacy(stateDir);
  }
  return defaultConfig();
}

/**
 * Merge `patch` into the workspace config and persist it (D-6). Runs the
 * legacy migration first so a set never clobbers an un-migrated gate.
 *
 * @param {string} stateDir
 * @param {{ stopReviewGate?: boolean }} patch
 * @returns {{ stopReviewGate: boolean }} the persisted config
 */
export function setConfig(stateDir, patch) {
  const current = getConfig(stateDir);
  const next = { ...current, ...patch };
  writeConfigAtomic(stateDir, next);
  return next;
}
