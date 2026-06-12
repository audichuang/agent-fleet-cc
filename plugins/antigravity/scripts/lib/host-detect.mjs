/**
 * host-detect — figure out which host launched us.
 *
 * Possible values:
 *   - 'claude'      — Claude Code session (CLAUDE_ENV_FILE present + is a file)
 *   - 'codex'       — Codex CLI session (CODEX_PLUGIN_DATA points at a real dir,
 *                                        or CODEX_HOME / CODEX_SESSION_ID is set)
 *   - 'agy'         — invoked under Antigravity CLI
 *                     (AGY_HOME, AGY_PLUGIN_DATA, or AGY_SESSION_ID)
 *   - 'standalone'  — none of the above (likely `npx antigravity-plugin`)
 *
 * Defensive: tightly checks env shape so a stray CLAUDE_ or CODEX_PLUGIN_DATA
 * var from a parent shell rc doesn't pull us into the wrong host's state tree.
 *
 * Mirrors the PR #37 hardening (validate that the env var points at an actual
 * filesystem entry, not just any string).
 */
import { statSync } from 'node:fs';

/** @returns {'claude'|'codex'|'agy'|'standalone'} */
export function detectHost(env = process.env) {
  if (isClaude(env)) return 'claude';
  if (isCodex(env)) return 'codex';
  if (isAgy(env)) return 'agy';
  return 'standalone';
}

function isClaude(env) {
  const f = env.CLAUDE_ENV_FILE;
  if (!f) return false;
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
}

function isCodex(env) {
  // Strong signal: CODEX_PLUGIN_DATA points at a real directory (this is what
  // Codex CLI sets when it spawns a plugin process — see the OpenAI Codex plugin
  // docs at https://developers.openai.com/codex/plugins/build).
  if (isDir(env.CODEX_PLUGIN_DATA)) return true;
  // Weaker signals: any of the Codex env shape vars set. These can come from a
  // user-exported shell rc, but combined with the absence of CLAUDE_ENV_FILE
  // (checked earlier in detectHost) they still mean "treat as Codex / non-Claude".
  return Boolean(env.CODEX_HOME || env.CODEX_SESSION_ID || env.CODEX_PLUGIN_DATA);
}

function isAgy(env) {
  if (isDir(env.AGY_PLUGIN_DATA)) return true;
  return Boolean(env.AGY_HOME || env.AGY_SESSION_ID || env.AGY_PLUGIN_DATA);
}

function isDir(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
