/**
 * Recursion guard (spec D-15). bin/antigravity.mjs refuses any invocation when
 * ANTIGRAVITY_ACTIVE=1 is set (an agy-in-agy recursion). The adapter declares
 * recursionMarker:"ANTIGRAVITY_ACTIVE" so buildEngineEnv force-injects it into
 * the agy child env; the read-side guard here is the new protection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../../plugins/antigravity/bin/antigravity.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('bin recursion guard (ANTIGRAVITY_ACTIVE)', () => {
  it('refuses any command with exit 1 + stderr hint when ANTIGRAVITY_ACTIVE=1', () => {
    const res = run(['status'], { ANTIGRAVITY_ACTIVE: '1' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /refusing recursive invocation/i);
  });

  it('refuses even --version when ANTIGRAVITY_ACTIVE=1 (guard is before dispatch)', () => {
    const res = run(['--version'], { ANTIGRAVITY_ACTIVE: '1' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /refusing recursive invocation/i);
  });

  it('does NOT refuse when ANTIGRAVITY_ACTIVE is unset', () => {
    const res = run(['--version'], { ANTIGRAVITY_ACTIVE: '' });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /refusing recursive invocation/i);
  });

  it('does NOT refuse when ANTIGRAVITY_ACTIVE has a non-"1" value', () => {
    const res = run(['--version'], { ANTIGRAVITY_ACTIVE: '0' });
    assert.equal(res.status, 0, res.stderr);
  });
});
