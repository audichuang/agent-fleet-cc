import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AGY_BIN,
  resolveAgyBin,
} from '../../plugins/antigravity/scripts/lib/agent-runtime.mjs';
import { detectHost } from '../../plugins/antigravity/scripts/lib/host-detect.mjs';
import { buildPluginInfo } from '../../plugins/antigravity/scripts/lib/plugin-info.mjs';

describe('resolveAgyBin', () => {
  it('returns AGY_BIN env value when it points to an existing file', () => {
    const env = { AGY_BIN: process.execPath, PATH: '' };
    assert.equal(resolveAgyBin(env), process.execPath);
  });

  it('falls back to DEFAULT_AGY_BIN when nothing resolves', () => {
    const env = { PATH: '/nonexistent/dir', HOME: '/also/nonexistent' };
    assert.equal(resolveAgyBin(env), DEFAULT_AGY_BIN);
  });
});

describe('detectHost', () => {
  it('returns standalone when no host vars are set', () => {
    assert.equal(detectHost({}), 'standalone');
  });

  it('returns codex when CODEX_HOME is set', () => {
    assert.equal(detectHost({ CODEX_HOME: '/tmp/c' }), 'codex');
  });

  it('returns agy when AGY_HOME is set', () => {
    assert.equal(detectHost({ AGY_HOME: '/tmp/a' }), 'agy');
  });

  it('ignores CLAUDE_ENV_FILE if it does not point to an actual file', () => {
    assert.equal(detectHost({ CLAUDE_ENV_FILE: '/nope/nope/nope' }), 'standalone');
  });
});

describe('buildPluginInfo', () => {
  it('produces a frozen object with name/version/description/homepage', () => {
    const info = buildPluginInfo({
      name: 'antigravity',
      version: '0.1.0',
      description: 'd',
      homepage: 'h',
      extra: 'ignored',
    });
    assert.equal(info.name, 'antigravity');
    assert.equal(info.version, '0.1.0');
    assert.equal(info.description, 'd');
    assert.equal(info.homepage, 'h');
    assert.equal(info.extra, undefined);
    assert.equal(Object.isFrozen(info), true);
  });
});
