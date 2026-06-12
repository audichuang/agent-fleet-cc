/**
 * Tests for scripts/lib/job-helpers.mjs.
 *
 * Replaces `agent-runtime` exports and `node:child_process.spawn` with
 * mutable test doubles installed via node:test's experimental module
 * mocking. A single mock is installed and the underlying behaviour is
 * swapped via a shared `state` object, so all tests share the same
 * cached job-helpers module — that keeps the V8 coverage report
 * accurate (one module instance, one tally).
 *
 *   node --test --experimental-test-module-mocks tests/job-helpers.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SESSION_ID_ENV } from '../../plugins/antigravity/scripts/lib/job-control.mjs';

const TMPROOT = '/tmp';

/** Mutable state that the mocks read on each invocation. */
const runtime = {
  next: { status: 'completed', exitCode: 0, stdout: '', stderr: '' },
  throws: null,
  spawnPid: 4242,
};

mock.module('../../plugins/antigravity/scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async () => {
      if (runtime.throws) throw runtime.throws;
      return { ...runtime.next };
    },
    spawnAgyDetached: () => ({ pid: runtime.spawnPid }),
    resolveAgyBin: () => 'agy',
    resolveAgyTimeouts: () => ({ printMs: 300000, hardMs: 360000 }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

mock.module('node:child_process', {
  namedExports: {
    spawn: () => ({
      pid: runtime.spawnPid,
      unref() {},
      on() {},
    }),
  },
});

// Now the mocked modules are installed in the loader's cache; importing
// job-helpers below will pick them up.
const { runForegroundJob, startBackgroundJob, createTrackedJob, patchJob, waitForJob, newJobId, currentSessionId } =
  await import('../../plugins/antigravity/scripts/lib/job-helpers.mjs');
const { readJobFile, listJobs } = await import('../../plugins/antigravity/scripts/lib/state.mjs');

let workspaceRoot;
const tmpToCleanup = [];

function freshWorkspace() {
  const dir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jh-'));
  const data = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jh-data-'));
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env[SESSION_ID_ENV] = 'sess-' + randomBytes(2).toString('hex');
  tmpToCleanup.push(dir, data);
  workspaceRoot = dir;
  return dir;
}

after(() => {
  for (const p of tmpToCleanup) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env[SESSION_ID_ENV];
});

describe('runForegroundJob — terminal status mapping', () => {
  it('completed → status=completed, summary derived from stdout first line', async () => {
    freshWorkspace();
    runtime.throws = null;
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'final answer\nmore', stderr: '' };
    const { job, result } = await runForegroundJob({
      workspaceRoot, kind: 'task', title: 'demo', prompt: 'hi',
    });
    assert.equal(result.status, 'completed');
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.summary, 'final answer');
    assert.equal(stored.exitCode, 0);
  });

  it('completed with very long first line → summary is truncated', async () => {
    freshWorkspace();
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'x'.repeat(200), stderr: '' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 't', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.summary.length, 120);
    assert.ok(stored.summary.endsWith('...'));
  });

  it('completed with empty stdout → summary is null', async () => {
    freshWorkspace();
    runtime.next = { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 't', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.summary, null);
  });

  it('auth_required → failed + healthStatus=auth_required + OAuth URL', async () => {
    freshWorkspace();
    runtime.next = {
      status: 'auth_required', exitCode: 1, stdout: '', stderr: 'oauth',
      oauthUrl: 'https://example/oauth',
    };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.healthStatus, 'auth_required');
    assert.equal(stored.oauthUrl, 'https://example/oauth');
    assert.match(stored.healthMessage, /not authenticated/);
    assert.match(stored.recommendedAction, /setup/);
  });

  it('timeout → failed with retry hint', async () => {
    freshWorkspace();
    runtime.next = { status: 'timeout', exitCode: 124, stdout: '', stderr: 'slow' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'failed');
    assert.match(stored.healthMessage, /timed out/);
    assert.match(stored.recommendedAction, /background/);
  });

  it('cancelled → status=cancelled', async () => {
    freshWorkspace();
    runtime.next = { status: 'cancelled', exitCode: 130, stdout: '', stderr: '' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    assert.equal(readJobFile(workspaceRoot, job.id).status, 'cancelled');
  });

  it('failed → status=failed and errorMessage from stderr', async () => {
    freshWorkspace();
    runtime.next = { status: 'failed', exitCode: 1, stdout: '', stderr: '  err\n' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.errorMessage, 'err');
  });

  it('thrown runAgyPrint → propagates and marks job failed', async () => {
    freshWorkspace();
    runtime.throws = new Error('boom');
    await assert.rejects(
      runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' }),
      /boom/
    );
    runtime.throws = null;
    // Find the failed job on disk.
    const jobs = listJobs(workspaceRoot);
    assert.ok(jobs.length >= 1);
    const stored = readJobFile(workspaceRoot, jobs[jobs.length - 1].id);
    assert.equal(stored.status, 'failed');
    assert.match(stored.errorMessage, /boom/);
  });
});

describe('startBackgroundJob + patchJob + waitForJob + newJobId', () => {
  it('startBackgroundJob records the spawned pid', async () => {
    freshWorkspace();
    runtime.spawnPid = 5555;
    const { job, pid } = await startBackgroundJob({
      workspaceRoot, kind: 'task', title: 'bg', prompt: 'do',
    });
    assert.equal(pid, 5555);
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.pid, 5555);
    assert.equal(stored.kind, 'task');
    // The background request payload is persisted.
    assert.equal(stored.request.prompt, 'do');
  });

  it('patchJob merges + strips detail fields from the index', async () => {
    freshWorkspace();
    const job = await createTrackedJob({ workspaceRoot, kind: 'task', title: 'p' });
    await patchJob(workspaceRoot, job.id, {
      status: 'running',
      request: { p: 1 },
      result: { x: 1 },
      stdout: 'unused',
    });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'running');
    assert.deepEqual(stored.request, { p: 1 });
    const indexEntry = listJobs(workspaceRoot).find((j) => j.id === job.id);
    assert.equal(indexEntry.request, undefined);
    assert.equal(indexEntry.result, undefined);
    assert.equal(indexEntry.stdout, undefined);
  });

  it('patchJob on an unknown id creates a fresh record', async () => {
    freshWorkspace();
    await patchJob(workspaceRoot, 'fresh-id', { status: 'completed' });
    const stored = readJobFile(workspaceRoot, 'fresh-id');
    assert.equal(stored.id, 'fresh-id');
    assert.equal(stored.status, 'completed');
  });

  it('waitForJob returns the terminal record promptly when status flips', async () => {
    freshWorkspace();
    const job = await createTrackedJob({ workspaceRoot, kind: 'task', title: 'w' });
    setTimeout(() => { patchJob(workspaceRoot, job.id, { status: 'completed' }); }, 30);
    const finalJob = await waitForJob(workspaceRoot, job.id, { pollMs: 15, timeoutMs: 2000 });
    assert.equal(finalJob.status, 'completed');
  });

  it('waitForJob returns the latest snapshot when the deadline elapses', async () => {
    freshWorkspace();
    const job = await createTrackedJob({ workspaceRoot, kind: 'task', title: 'w2' });
    const timedOut = await waitForJob(workspaceRoot, job.id, { pollMs: 20, timeoutMs: 80 });
    // Either null or the still-queued snapshot.
    assert.ok(timedOut === null || timedOut.status === 'queued');
  });

  it('newJobId returns unique 12-char ids; currentSessionId reads SESSION_ID_ENV', () => {
    const a = newJobId(), b = newJobId();
    assert.notEqual(a, b);
    assert.equal(a.length, 12);
    assert.equal(currentSessionId({ [SESSION_ID_ENV]: 'sess' }), 'sess');
    assert.equal(currentSessionId({}), null);
  });
});
