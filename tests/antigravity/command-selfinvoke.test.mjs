/**
 * Black-box tests that the command modules self-invoke when run directly —
 * the exact path the slash-command `.md` files use
 * (`node scripts/commands/<verb>.mjs $ARGUMENTS`). Before runAsMain was wired
 * in, these modules only exported run() and did nothing when executed, so the
 * slash commands were silent no-ops in Claude Code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmd = (name) => path.resolve(__dirname, `../../plugins/antigravity/scripts/commands/${name}.mjs`);

function runCmd(name, args = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-si-'));
  try {
    return spawnSync(process.execPath, [cmd(name), ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, ...env },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('command self-invoke', () => {
  it('status prints a snapshot and exits 0 when run directly', () => {
    const res = runCmd('status');
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.match(res.stdout, /Antigravity Status/);
  });

  it('result with no jobs exits 1 with a friendly error when run directly', () => {
    const res = runCmd('result');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /antigravity:result/);
  });

  it('cancel with no active jobs exits 1 with a friendly error when run directly', () => {
    const res = runCmd('cancel');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No active antigravity jobs|antigravity:cancel/);
  });

  it('wait with no job id exits 1 with a friendly error when run directly', () => {
    const res = runCmd('wait');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /antigravity:wait/);
    assert.match(res.stderr, /job id/i);
  });

  it('logs with an unknown job exits 1 with a friendly error when run directly', () => {
    const res = runCmd('logs', ['missing-job']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /antigravity:logs/);
    assert.match(res.stderr, /No job found|unknown/i);
  });

  it('setup self-invokes and reports an unusable agy without invoking the real one', () => {
    // Use a stub `agy` whose `--version` fails, so probeAgy returns not-ok and
    // setup exits 2 — without falling back to (and OAuth-probing) the real agy.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-setup-'));
    const stub = path.join(dir, 'agy');
    fs.writeFileSync(stub, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    try {
      const res = spawnSync(process.execPath, [cmd('setup')], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, AGY_BIN: stub },
      });
      assert.equal(res.status, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
      assert.match(res.stderr, /antigravity:setup/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
