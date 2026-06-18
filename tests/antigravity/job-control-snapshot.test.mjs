/**
 * Deep tests for scripts/lib/job-control.mjs and the status/result/cancel
 * helpers it powers.
 *
 * All tests are pure data-driven: we seed jobs via state.mjs (no subprocesses)
 * and exercise buildStatusSnapshot, buildSingleJobSnapshot, resolveResultJob,
 * resolveCancelableJob, plus the classifyRuntimeHealth branches (active /
 * quiet / possibly_stalled / worker_missing / persisted_diagnostic).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  upsertJob,
  writeJobFile,
  appendJobLog,
  ensureStateDir,
  saveState,
  resolveJobLogFile,
} from '../../plugins/antigravity/scripts/lib/state.mjs';
import {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
  resolveResultJob,
  resolveCancelableJob,
  SESSION_ID_ENV,
  QUIET_AFTER_MS,
  POSSIBLY_STALLED_AFTER_MS,
} from '../../plugins/antigravity/scripts/lib/job-control.mjs';

const TMPROOT = '/tmp';

let workCwd;
let dataDir;
const savedEnv = {};

beforeEach(() => {
  // Fresh workspace + data dir per test so the on-disk state is deterministic.
  workCwd = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jc-'));
  dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jc-data-'));
  savedEnv.CLAUDE_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;
  savedEnv[SESSION_ID_ENV] = process.env[SESSION_ID_ENV];
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  process.env[SESSION_ID_ENV] = 'sess-' + randomBytes(2).toString('hex');
});

after(() => {
  // Best-effort restore.
  if (savedEnv.CLAUDE_PLUGIN_DATA === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = savedEnv.CLAUDE_PLUGIN_DATA;
  if (savedEnv[SESSION_ID_ENV] === undefined) delete process.env[SESSION_ID_ENV];
  else process.env[SESSION_ID_ENV] = savedEnv[SESSION_ID_ENV];
});

async function seedJob(overrides = {}) {
  const id = overrides.id ?? randomBytes(4).toString('hex');
  const sessionId = overrides.sessionId ?? process.env[SESSION_ID_ENV];
  const job = {
    id,
    kind: 'task',
    status: 'queued',
    phase: 'queued',
    sessionId,
    pid: null,
    createdAt: new Date(2024, 0, 1, 0, 0, 0).toISOString(),
    updatedAt: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
    logFile: resolveJobLogFile(workCwd, id),
    ...overrides,
  };
  await upsertJob(workCwd, job);
  await writeJobFile(workCwd, id, { ...job, request: null, result: null });
  return job;
}

describe('buildStatusSnapshot', () => {
  it('partitions session jobs into running/recent and respects maxJobs', async () => {
    await seedJob({ id: 'a', status: 'running' });
    await seedJob({ id: 'b', status: 'queued' });
    await seedJob({ id: 'c', status: 'completed', completedAt: new Date().toISOString() });
    await seedJob({ id: 'd', status: 'failed' });

    const snap = buildStatusSnapshot(workCwd, { env: process.env, maxJobs: 2 });
    assert.equal(snap.running.length, 2);
    assert.equal(snap.recent.length, 2);
    assert.ok(snap.running.some((j) => j.id === 'a'));
    assert.ok(snap.recent.some((j) => j.id === 'c'));
    assert.equal(snap.needsReview, false);
    assert.ok(snap.workspaceRoot.length > 0);
  });

  it('falls back to all jobs when no session id is set', async () => {
    await seedJob({ id: 'q', status: 'running', sessionId: 'other-session' });
    delete process.env[SESSION_ID_ENV];
    const snap = buildStatusSnapshot(workCwd, { env: { /* no session */ } });
    assert.ok(snap.running.some((j) => j.id === 'q'));
  });
});

describe('buildSingleJobSnapshot', () => {
  it('resolves by exact id, partial id, and 1-based positional index', async () => {
    await seedJob({ id: 'abcd1234', status: 'running' });
    const exact = buildSingleJobSnapshot(workCwd, 'abcd1234');
    assert.equal(exact.job.id, 'abcd1234');

    const partial = buildSingleJobSnapshot(workCwd, 'abcd');
    assert.equal(partial.job.id, 'abcd1234');

    const byIdx = buildSingleJobSnapshot(workCwd, '1');
    assert.equal(byIdx.job.id, 'abcd1234');
  });

  it('throws a helpful error when no job matches', () => {
    assert.throws(() => buildSingleJobSnapshot(workCwd, 'missing'), /No job found/);
  });

  it('enriches a running job with computed elapsed and reads tail of the log file', async () => {
    const created = new Date(Date.now() - 3000).toISOString();
    const job = await seedJob({
      id: 'enrich1',
      status: 'running',
      startedAt: created,
      lastProgressAt: new Date().toISOString(),
    });
    appendJobLog(workCwd, job.id, 'progress: line 1');
    appendJobLog(workCwd, job.id, 'progress: line 2');
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.ok(snap.job.elapsed, 'expected elapsed to be computed');
    assert.ok(Array.isArray(snap.job.recentProgress));
    assert.ok(snap.job.recentProgress.length >= 1);
  });
});

describe('classifyRuntimeHealth — branches via buildSingleJobSnapshot', () => {
  it('active when lastProgressAt is recent', async () => {
    const job = await seedJob({
      id: 'h-active',
      status: 'running',
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.equal(snap.job.healthStatus, 'active');
  });

  it('quiet when recent heartbeat but stale progress', async () => {
    const now = Date.now();
    const job = await seedJob({
      id: 'h-quiet',
      status: 'running',
      startedAt: new Date(now - QUIET_AFTER_MS * 2).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      lastProgressAt: new Date(now - QUIET_AFTER_MS - 30_000).toISOString(),
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id, { now });
    assert.equal(snap.job.healthStatus, 'quiet');
  });

  it('possibly_stalled when neither progress nor heartbeat are recent', async () => {
    const now = Date.now();
    const job = await seedJob({
      id: 'h-stall',
      status: 'running',
      startedAt: new Date(now - POSSIBLY_STALLED_AFTER_MS * 3).toISOString(),
      lastHeartbeatAt: new Date(now - POSSIBLY_STALLED_AFTER_MS * 2).toISOString(),
      lastProgressAt: new Date(now - POSSIBLY_STALLED_AFTER_MS * 2).toISOString(),
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id, { now });
    assert.equal(snap.job.healthStatus, 'possibly_stalled');
  });

  it('worker_missing when pid is dead (via injected isProcessAlive)', async () => {
    // Use a live pid (this process) so the listJobs dead-PID reconcile does NOT
    // auto-fail it; we exercise the health classifier in isolation via the
    // injected isProcessAlive seam.
    const job = await seedJob({ id: 'h-dead', status: 'running', pid: process.pid });
    const snap = buildSingleJobSnapshot(workCwd, job.id, { isProcessAlive: () => false });
    assert.equal(snap.job.healthStatus, 'worker_missing');
  });

  it('persisted auth_required survives reclassification', async () => {
    const job = await seedJob({
      id: 'h-auth',
      status: 'running',
      healthStatus: 'auth_required',
      healthMessage: 'auth pending',
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.equal(snap.job.healthStatus, 'auth_required');
  });

  it('terminal jobs get no classifier output', async () => {
    const job = await seedJob({ id: 'h-done', status: 'completed' });
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.equal(snap.job.healthStatus, null);
  });
});

describe('resolveResultJob', () => {
  it('returns the most recent terminal job when no reference is given', async () => {
    await seedJob({ id: 'r-done', status: 'completed', updatedAt: '2024-01-02T00:00:00Z' });
    await seedJob({ id: 'r-run', status: 'running', updatedAt: '2024-01-03T00:00:00Z' });
    const { job } = resolveResultJob(workCwd, null, process.env);
    assert.equal(job.id, 'r-done');
  });

  it('throws when the matched job is still running, suggesting --wait', async () => {
    await seedJob({ id: 'r-run-only', status: 'running' });
    assert.throws(() => resolveResultJob(workCwd, 'r-run-only', process.env), /still running/);
  });

  it('throws when nothing matches a reference', async () => {
    await seedJob({ id: 'x', status: 'completed' });
    assert.throws(() => resolveResultJob(workCwd, 'nothing', process.env), /No job found/);
  });

  it('throws when no finished jobs exist at all', () => {
    assert.throws(() => resolveResultJob(workCwd, null, process.env), /No finished/);
  });
});

describe('resolveCancelableJob', () => {
  it('returns the matching active job', async () => {
    await seedJob({ id: 'c1', status: 'running' });
    await seedJob({ id: 'c2', status: 'queued' });
    const { job } = resolveCancelableJob(workCwd, 'c1');
    assert.equal(job.id, 'c1');
  });

  it('selects the only active job when no reference is given', async () => {
    await seedJob({ id: 'only-active', status: 'running' });
    const { job } = resolveCancelableJob(workCwd, null);
    assert.equal(job.id, 'only-active');
  });

  it('requires a job id when multiple active jobs exist', async () => {
    await seedJob({ id: 'active-one', status: 'running' });
    await seedJob({ id: 'active-two', status: 'queued' });
    assert.throws(
      () => resolveCancelableJob(workCwd, null),
      (err) => {
        assert.match(err.message, /Multiple active antigravity jobs/);
        assert.match(err.message, /active-one/);
        assert.match(err.message, /active-two/);
        return true;
      },
    );
  });

  it('does not accept positional indexes as job ids when multiple active jobs exist', async () => {
    await seedJob({ id: 'idx-one', status: 'running' });
    await seedJob({ id: 'idx-two', status: 'queued' });
    assert.throws(
      () => resolveCancelableJob(workCwd, '1'),
      /pass a job id/,
    );
  });

  it('errors when there are no active jobs', () => {
    assert.throws(() => resolveCancelableJob(workCwd, null), /No active antigravity jobs/);
  });

  it('errors when reference does not match any active job', async () => {
    await seedJob({ id: 'c3', status: 'running' });
    assert.throws(() => resolveCancelableJob(workCwd, 'unknown'), /No active job matched/);
  });
});
