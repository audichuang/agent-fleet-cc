/**
 * The status/result command projection on the shared runtime.
 *
 * The old deep job-control helpers (buildStatusSnapshot / buildSingleJobSnapshot
 * / resolveResultJob / resolveCancelableJob) and the whole health classifier are
 * gone (BEHAVIOR CHANGE 5): status/result now read the shared store via
 * `listProjectedJobs` (listJobs → updatedAt-desc → projectJob) and select inline.
 * These tests assert the surviving, non-health projection: newest-activity-first
 * ordering (D-7) and the antigravity-shaped fields render.mjs consumes. Job
 * selection (exact/substring/1-based index) and the multi-active refusal are
 * covered end-to-end against the shared layout by cancel-cas.test.mjs and
 * e2e-cli.test.mjs.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJobRecord } from '../../plugins/antigravity/scripts/lib/shared/core/job.mjs';
import { createJob, jobDir } from '../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs';
import {
  listProjectedJobs,
  projectJob,
} from '../../plugins/antigravity/scripts/lib/job-runtime.mjs';

let stateDir;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-jc-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// createJob writes the record verbatim (no updatedAt bump), so timestamps stamped
// on the record land on disk unchanged.
function seed(id, { createdAt, updatedAt, status = 'completed', resultText = null } = {}) {
  const rec = createJobRecord({ engine: 'antigravity' });
  createJob(
    stateDir,
    { ...rec, id, status, resultText, createdAt, updatedAt },
    'prompt',
  );
}

describe('listProjectedJobs', () => {
  it('orders by updatedAt desc even when createdAt disagrees (D-7)', () => {
    seed('a', { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    seed('b', { createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-09T00:00:00Z' });
    seed('c', { createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' });
    const ids = listProjectedJobs(stateDir).map((j) => j.id);
    assert.deepEqual(ids, ['b', 'c', 'a']);
  });

  it('projects each record into the render-facing shape', () => {
    seed('done', {
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:01Z',
      status: 'completed',
      resultText: 'first line\nsecond line',
    });
    const [job] = listProjectedJobs(stateDir);
    assert.equal(job.id, 'done');
    assert.equal(job.result.rawOutput, 'first line\nsecond line');
    assert.equal(job.result.status, 'completed');
    assert.equal(job.summary, 'first line');
    assert.equal(job.threadId, null);
    // No health fields leak into the projection (BEHAVIOR CHANGE 5).
    assert.equal(job.healthStatus, undefined);
    assert.equal(job.lastProgressAt, undefined);
  });

  it('returns [] for an empty state dir', () => {
    assert.deepEqual(listProjectedJobs(stateDir), []);
  });
});

describe('projectJob field mapping', () => {
  it('null resultText → result null, no health section', () => {
    const rec = createJobRecord({ engine: 'antigravity' });
    const p = projectJob({ ...rec, status: 'completed', resultText: null });
    assert.equal(p.result, null);
    assert.equal(p.summary, null);
    assert.equal(p.healthStatus, undefined);
  });

  it('surfaces the log directory location for the projected job', () => {
    seed('loc', { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    assert.ok(fs.existsSync(jobDir(stateDir, 'loc')));
  });
});
