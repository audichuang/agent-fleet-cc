/**
 * Dead-PID reconciliation. A background worker that is SIGKILL'd or whose
 * machine reboots leaves its job stuck at status:'running' forever. listJobs
 * PID-probes active jobs and auto-fails any whose worker process is gone, so
 * status/result/cancel never report a phantom 'running' job.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { ensureStateDir, upsertJob, writeJobFile, readJobFile, listJobs } from '../../plugins/antigravity/scripts/lib/state.mjs';

const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-recon-'));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const DEAD_PID = 2 ** 22;

async function seed(id, job) {
  ensureStateDir(tempDir);
  await upsertJob(tempDir, { id, ...job });
  await writeJobFile(tempDir, id, { id, ...job });
}

describe('reconcileDeadPidJobs (via listJobs)', () => {
  it('auto-fails a running job whose worker pid is gone', async () => {
    const id = 'dead' + randomBytes(2).toString('hex');
    await seed(id, { kind: 'task', status: 'running', phase: 'running', pid: DEAD_PID });

    const jobs = listJobs(tempDir);
    const job = jobs.find((j) => j.id === id);
    assert.equal(job.status, 'failed');
    assert.equal(job.autoReconciled, true);
    // Persisted to the per-job file too (source of truth).
    assert.equal(readJobFile(tempDir, id).status, 'failed');
  });

  it('leaves a running job alone when its worker pid is alive', async () => {
    const id = 'alive' + randomBytes(2).toString('hex');
    await seed(id, { kind: 'task', status: 'running', phase: 'running', pid: process.pid });

    const job = listJobs(tempDir).find((j) => j.id === id);
    assert.equal(job.status, 'running');
  });

  it('does not touch a job that has no tracked pid yet', async () => {
    const id = 'nopid' + randomBytes(2).toString('hex');
    await seed(id, { kind: 'task', status: 'queued', phase: 'queued' });

    const job = listJobs(tempDir).find((j) => j.id === id);
    assert.equal(job.status, 'queued');
  });

  it('does not resurrect or alter an already-terminal job', async () => {
    const id = 'done' + randomBytes(2).toString('hex');
    await seed(id, { kind: 'task', status: 'completed', phase: 'completed', pid: DEAD_PID });

    const job = listJobs(tempDir).find((j) => j.id === id);
    assert.equal(job.status, 'completed');
  });
});
