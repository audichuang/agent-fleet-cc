/**
 * The detached watchdog reaps a background job whose worker died, WITHOUT
 * anyone calling /antigravity:status. We spawn the real _watchdog.mjs against a
 * running job with a dead pid and assert it transitions the job to failed via
 * the CAS, independently of the listJobs reconcile path.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { ensureStateDir, upsertJob, writeJobFile, readJobFile } from '../../plugins/antigravity/scripts/lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHDOG = path.resolve(__dirname, '../../plugins/antigravity/scripts/commands/_watchdog.mjs');
const DEAD_PID = 2 ** 22;

const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-wd-'));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('watchdog reaps a dead-worker job', () => {
  it('marks a running job failed when its worker pid is gone', async () => {
    const id = 'wd' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    const job = { id, kind: 'task', status: 'running', phase: 'running', pid: DEAD_PID };
    await upsertJob(tempDir, job);
    await writeJobFile(tempDir, id, job);

    const child = spawn(process.execPath, [WATCHDOG, tempDir, id], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: tempDir,
        AGY_WATCHDOG_INTERVAL_MS: '50',
        AGY_WATCHDOG_CONFIRM_ROUNDS: '1',
      },
      stdio: 'ignore',
    });

    try {
      const deadline = Date.now() + 6000;
      let final;
      while (Date.now() < deadline) {
        final = readJobFile(tempDir, id);
        if (final?.status === 'failed') break;
        await sleep(50);
      }
      assert.equal(final?.status, 'failed', `watchdog should have failed the job; got ${final?.status}`);
      assert.equal(final.watchdogTerminated, true);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  });
});
