/**
 * Cancel must be race-safe and signal the right process.
 *
 * - It routes the terminal write through applyJobPatchIfActive, so a cancel
 *   that arrives after the worker already finished does NOT clobber the result.
 * - It reads the pid from the per-job file (source of truth), not the possibly
 *   stale state.json index, and verifies liveness before signalling.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { ensureStateDir, upsertJob, writeJobFile, readJobFile } from '../../plugins/antigravity/scripts/lib/state.mjs';

const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
const ORIGINAL_SESSION = process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-cancel-'));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
  if (ORIGINAL_SESSION === undefined) delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  else process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = ORIGINAL_SESSION;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const DEAD_PID = 2 ** 22;

function capture() {
  const out = [];
  const err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => (out.push(String(c)), true);
  process.stderr.write = (c) => (err.push(String(c)), true);
  return { out, err, restore: () => { process.stdout.write = o; process.stderr.write = e; } };
}

describe('/antigravity:cancel race + signal safety', () => {
  it('does not clobber a job that already completed (stale index says running)', async () => {
    const id = 'late' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    // Index still says running (stale), but the per-job file is already completed.
    await upsertJob(tempDir, { id, kind: 'task', status: 'running', pid: DEAD_PID, updatedAt: new Date().toISOString() });
    await writeJobFile(tempDir, id, { id, status: 'completed', phase: 'completed', result: { rawOutput: 'done' } });

    const { run } = await import('../../plugins/antigravity/scripts/commands/cancel.mjs');
    const cap = capture();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    // The real result must survive.
    assert.equal(readJobFile(tempDir, id).status, 'completed');
    // And cancel must report it could not cancel a finished job (non-zero, friendly).
    assert.notEqual(exit, 0);
  });

  it('reads the pid from the per-job file, not the stale index', async () => {
    const id = 'pidsrc' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    // Index has a bogus pid; the per-job file has the authoritative (dead) pid.
    await upsertJob(tempDir, { id, kind: 'task', status: 'running', pid: 4242, updatedAt: new Date().toISOString() });
    await writeJobFile(tempDir, id, { id, status: 'running', phase: 'running', pid: DEAD_PID });

    const { run } = await import('../../plugins/antigravity/scripts/commands/cancel.mjs');
    const cap = capture();
    let exit;
    try {
      exit = await run([id, '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0, cap.err.join(''));
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.pid, DEAD_PID); // sourced from per-job file, not index 4242
    assert.equal(payload.killed, false); // dead pid → not signalled
    assert.equal(readJobFile(tempDir, id).status, 'cancelled');
  });
});
