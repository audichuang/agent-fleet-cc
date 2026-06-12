/**
 * Cross-process terminal-transition safety in state.mjs.
 *
 * claimTerminalTransition is an O_EXCL .lock compare-and-swap: the first writer
 * to finalize a job wins; later writers (a cancel racing a natural completion,
 * a watchdog, a dead-PID reconcile) lose and must not clobber the winner.
 * applyJobPatchIfActive layers the active-state gate + terminal claim over a
 * per-job write so terminal writes are first-writer-wins, not last-writer.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  ensureStateDir,
  upsertJob,
  writeJobFile,
  readJobFile,
  resolveJobLockFile,
  claimTerminalTransition,
  applyJobPatchIfActive,
} from '../../plugins/antigravity/scripts/lib/state.mjs';

const ORIGINAL_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-cas-'));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});
afterEach(() => {
  if (ORIGINAL_PLUGIN_DATA === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_PLUGIN_DATA;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const DEAD_PID = 2 ** 22; // guaranteed-not-running

async function seedRunningJob(id, extra = {}) {
  ensureStateDir(tempDir);
  const base = {
    id,
    kind: 'task',
    status: 'running',
    phase: 'running',
    pid: process.pid,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  await upsertJob(tempDir, base);
  await writeJobFile(tempDir, id, base);
}

describe('claimTerminalTransition', () => {
  it('lets the first writer win and rejects the second', async () => {
    const id = 'cas' + randomBytes(2).toString('hex');
    await seedRunningJob(id);
    assert.equal(claimTerminalTransition(tempDir, id, 'completed', new Date().toISOString()), true);
    assert.equal(claimTerminalTransition(tempDir, id, 'cancelled', new Date().toISOString()), false);
    assert.ok(fs.existsSync(resolveJobLockFile(tempDir, id)));
  });

  it('reclaims a stale lock whose owner pid is dead', async () => {
    const id = 'stale' + randomBytes(2).toString('hex');
    await seedRunningJob(id);
    // Plant a lock owned by a dead pid.
    ensureStateDir(tempDir);
    fs.writeFileSync(resolveJobLockFile(tempDir, id), JSON.stringify({ status: 'failed', pid: DEAD_PID }));
    // A live claimant should reclaim it.
    assert.equal(claimTerminalTransition(tempDir, id, 'completed', new Date().toISOString()), true);
  });
});

describe('applyJobPatchIfActive', () => {
  it('applies a terminal patch to an active job and persists it', async () => {
    const id = 'act' + randomBytes(2).toString('hex');
    await seedRunningJob(id);
    const res = await applyJobPatchIfActive(tempDir, id, { status: 'completed', phase: 'completed' });
    assert.equal(res.applied, true);
    assert.equal(readJobFile(tempDir, id).status, 'completed');
  });

  it('refuses to overwrite a job that is already terminal (race resolution)', async () => {
    const id = 'race' + randomBytes(2).toString('hex');
    await seedRunningJob(id);
    // Worker completes first.
    const first = await applyJobPatchIfActive(tempDir, id, { status: 'completed', phase: 'completed' });
    assert.equal(first.applied, true);
    // Cancel arrives late — must NOT win.
    const second = await applyJobPatchIfActive(tempDir, id, { status: 'cancelled', phase: 'cancelled' });
    assert.equal(second.applied, false);
    assert.equal(readJobFile(tempDir, id).status, 'completed');
  });

  it('honors an extra guard (e.g. pid identity)', async () => {
    const id = 'guard' + randomBytes(2).toString('hex');
    await seedRunningJob(id, { pid: 12345 });
    const res = await applyJobPatchIfActive(
      tempDir,
      id,
      { status: 'failed', phase: 'failed' },
      (stored) => Number(stored.pid) === 999, // never matches
    );
    assert.equal(res.applied, false);
    assert.equal(readJobFile(tempDir, id).status, 'running');
  });

  it('applies a non-terminal patch without requiring a claim', async () => {
    const id = 'beat' + randomBytes(2).toString('hex');
    await seedRunningJob(id);
    const res = await applyJobPatchIfActive(tempDir, id, { lastHeartbeatAt: new Date().toISOString() });
    assert.equal(res.applied, true);
    assert.equal(readJobFile(tempDir, id).status, 'running');
    assert.ok(readJobFile(tempDir, id).lastHeartbeatAt);
  });
});
