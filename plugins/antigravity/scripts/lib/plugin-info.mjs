/**
 * plugin-info — single source of truth for plugin name + version.
 *
 * Used by the standalone CLI banner, the OAuth wizard, command help text, and
 * (when we add MCP support) the MCP `clientInfo` block.
 */
import { promises as fs } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(__filename), '..', '..');

let cached;

/** Resolve `{ name, version, description, homepage }` from `plugin.json`. */
export async function getPluginInfo() {
  if (cached) return cached;
  const raw = await fs.readFile(join(PKG_ROOT, 'plugin.json'), 'utf8');
  const json = JSON.parse(raw);
  cached = Object.freeze({
    name: json.name,
    version: json.version,
    description: json.description,
    homepage: json.homepage,
  });
  return cached;
}

/** Sync variant for hot paths that already loaded the file via `import`. */
export function buildPluginInfo(json) {
  return Object.freeze({
    name: json.name,
    version: json.version,
    description: json.description,
    homepage: json.homepage,
  });
}

/** Test-only: reset the cache. */
export function _resetCache() {
  cached = undefined;
}
