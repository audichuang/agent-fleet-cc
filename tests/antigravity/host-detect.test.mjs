/**
 * host-detect tests — verify detectHost() returns the right host for each
 * of the four supported entry points and is defensive against:
 *
 *   - stray shell-rc exports of CLAUDE_ENV_FILE / CODEX_PLUGIN_DATA /
 *     AGY_PLUGIN_DATA that point at non-existent paths,
 *   - Codex being mistaken for Claude when CLAUDE_PLUGIN_DATA is exported
 *     globally but CLAUDE_ENV_FILE does not point at a real session file.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { detectHost } from '../../plugins/antigravity/scripts/lib/host-detect.mjs';

function tmpDir(label) {
  const d = path.join(os.tmpdir(), `antigravity-host-detect-${label}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function tmpFile(label) {
  const d = tmpDir(label);
  const f = path.join(d, 'session.env');
  fs.writeFileSync(f, '# antigravity host-detect test fixture\n');
  return f;
}

describe('detectHost', () => {
  /** @type {string[]} */
  let cleanup;
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const p of cleanup) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('returns "standalone" when no host vars are set', () => {
    assert.equal(detectHost({}), 'standalone');
  });

  it('returns "claude" when CLAUDE_ENV_FILE points at a real file', () => {
    const f = tmpFile('claude'); cleanup.push(path.dirname(f));
    assert.equal(detectHost({ CLAUDE_ENV_FILE: f }), 'claude');
  });

  it('ignores CLAUDE_ENV_FILE that points at a non-existent path', () => {
    assert.equal(
      detectHost({ CLAUDE_ENV_FILE: '/no/such/path/session.env' }),
      'standalone',
    );
  });

  it('ignores CLAUDE_ENV_FILE that points at a directory, not a file', () => {
    const d = tmpDir('claudedir'); cleanup.push(d);
    assert.equal(detectHost({ CLAUDE_ENV_FILE: d }), 'standalone');
  });

  it('returns "codex" when CODEX_PLUGIN_DATA points at a real directory (PR #37 strong signal)', () => {
    const d = tmpDir('codexdata'); cleanup.push(d);
    assert.equal(detectHost({ CODEX_PLUGIN_DATA: d }), 'codex');
  });

  it('returns "codex" when only CODEX_HOME is set (weak signal, no Claude env)', () => {
    assert.equal(detectHost({ CODEX_HOME: '/tmp/c' }), 'codex');
  });

  it('returns "codex" when only CODEX_SESSION_ID is set', () => {
    assert.equal(detectHost({ CODEX_SESSION_ID: 'abc123' }), 'codex');
  });

  it('returns "agy" when AGY_PLUGIN_DATA points at a real directory', () => {
    const d = tmpDir('agydata'); cleanup.push(d);
    assert.equal(detectHost({ AGY_PLUGIN_DATA: d }), 'agy');
  });

  it('returns "agy" when only AGY_HOME is set', () => {
    assert.equal(detectHost({ AGY_HOME: '/tmp/a' }), 'agy');
  });

  it('prefers Claude over Codex/agy when CLAUDE_ENV_FILE is a real file', () => {
    const f = tmpFile('mix-c'); cleanup.push(path.dirname(f));
    const d = tmpDir('mix-cx'); cleanup.push(d);
    assert.equal(
      detectHost({ CLAUDE_ENV_FILE: f, CODEX_PLUGIN_DATA: d, AGY_HOME: '/x' }),
      'claude',
    );
  });

  it('prefers Codex over agy when Codex signal is present and Claude is not', () => {
    const d = tmpDir('mix-cx2'); cleanup.push(d);
    assert.equal(
      detectHost({ CODEX_PLUGIN_DATA: d, AGY_HOME: '/x' }),
      'codex',
    );
  });

  it('does not let a stray CLAUDE_PLUGIN_DATA in the shell pull Codex into Claude state', () => {
    // Mirrors the PR #37 hardening: CLAUDE_PLUGIN_DATA alone (without
    // CLAUDE_ENV_FILE pointing at a real session file) must NOT count as Claude.
    const d = tmpDir('codex-with-stray-claude'); cleanup.push(d);
    assert.equal(
      detectHost({ CLAUDE_PLUGIN_DATA: '/some/exported/path', CODEX_PLUGIN_DATA: d }),
      'codex',
    );
  });
});
