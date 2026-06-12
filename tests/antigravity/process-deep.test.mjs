/**
 * Deep tests for scripts/lib/process.mjs covering terminateProcessTree,
 * binaryAvailable, and spawnDetached. Uses short-lived `sleep` children so
 * the suite stays well within the 30-second budget.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  binaryAvailable,
  terminateProcessTree,
  spawnDetached,
} from '../../plugins/antigravity/scripts/lib/process.mjs';

const TMPROOT = '/tmp';

describe('binaryAvailable', () => {
  it('returns true for an executable that exists on PATH (sh)', () => {
    assert.equal(binaryAvailable('sh'), true);
  });

  it('returns false for a binary that does not exist', () => {
    assert.equal(binaryAvailable('definitely-not-a-real-binary-xyz'), false);
  });
});

describe('terminateProcessTree', () => {
  it('ignores invalid pids (≤0, NaN)', () => {
    // None of these should throw.
    terminateProcessTree(0);
    terminateProcessTree(-1);
    terminateProcessTree(NaN);
    terminateProcessTree(undefined);
  });

  it('SIGTERMs a real child process group', async () => {
    // Launch a detached child running `sleep`. detached:true puts it in its
    // own process group so process.kill(-pid, SIGTERM) hits the group.
    const child = spawn('sh', ['-c', 'sleep 10'], { detached: true, stdio: 'ignore' });
    try {
      assert.ok(child.pid, 'child should have a pid');
      terminateProcessTree(child.pid);
      // Wait a bit for the SIGTERM to take effect, then assert exit.
      const exited = await new Promise((resolve) => {
        child.on('exit', () => resolve(true));
        setTimeout(() => resolve(false), 1500);
      });
      assert.equal(exited, true, 'child should have exited after SIGTERM');
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  });

  it('silently absorbs ESRCH when the pid is already gone', () => {
    // Pick a pid that will not exist. process.kill throws ESRCH internally
    // which the helper catches.
    terminateProcessTree(2 ** 22);
  });
});

describe('spawnDetached', () => {
  it('spawns with stdio=ignore and unrefs when no log file is provided', () => {
    const child = spawnDetached('sh', ['-c', 'exit 0']);
    assert.ok(child.pid);
    // Wait for exit so the test does not leave a zombie.
    return new Promise((resolve) => child.on('exit', () => resolve()));
  });

  it('redirects stderr to a log file when logFile is provided', async () => {
    const dir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-spawn-'));
    const log = path.join(dir, 'out.log');
    try {
      const child = spawnDetached('sh', ['-c', 'echo line-to-stderr 1>&2; exit 0'], { logFile: log });
      assert.ok(child.pid);
      await new Promise((resolve) => child.on('exit', () => resolve()));
      const body = fs.readFileSync(log, 'utf8');
      assert.match(body, /line-to-stderr/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
