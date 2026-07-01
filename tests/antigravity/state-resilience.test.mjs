/**
 * State resilience on the shared runtime (directory-per-job layout).
 *
 * The old flat `state.json` index quarantined corrupt files aside; the shared
 * store instead makes reads defensive — `readJob` returns null on a corrupt or
 * missing job.json (never throws) and `listJobs` simply skips any unreadable
 * job directory, so a partial write / power loss / an old ≤0.2.0 flat-layout
 * `jobs/<id>.json` file can never make every job vanish or crash a read
 * (state-store.mjs:52-75; migration DATA-INTEGRITY §). The exhaustive CAS /
 * corruption matrix lives in tests/shared/; here we assert the antigravity
 * plugin inherits it through the vendored copy.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { createJobRecord } from '../../plugins/antigravity/scripts/lib/shared/core/job.mjs';
import {
  createJob,
  readJob,
  listJobs,
  jobDir,
} from '../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs';

let stateDir;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-resil-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function seed(id, resultText = 'ok') {
  const rec = createJobRecord({ engine: 'antigravity' });
  createJob(stateDir, { ...rec, id, status: 'completed', resultText }, 'prompt');
  return id;
}

describe('shared read resilience', () => {
  it('readJob returns null (no throw) for a corrupt job.json', () => {
    const id = 'corrupt-' + randomBytes(2).toString('hex');
    fs.mkdirSync(jobDir(stateDir, id), { recursive: true });
    fs.writeFileSync(path.join(jobDir(stateDir, id), 'job.json'), '{ not valid json ');
    assert.equal(readJob(stateDir, id), null);
  });

  it('readJob returns null for a missing job', () => {
    assert.equal(readJob(stateDir, 'never-created'), null);
  });

  it('listJobs skips corrupt/foreign directories and keeps the good jobs', () => {
    seed('good-one');
    seed('good-two');
    // A corrupt job dir.
    const bad = 'bad-' + randomBytes(2).toString('hex');
    fs.mkdirSync(jobDir(stateDir, bad), { recursive: true });
    fs.writeFileSync(path.join(jobDir(stateDir, bad), 'job.json'), 'definitely not json');
    // An old ≤0.2.0 flat-layout file where the shared store expects a directory.
    fs.writeFileSync(path.join(jobDir(stateDir, '..'), 'legacy.json'), '{"id":"legacy"}');

    const ids = listJobs(stateDir).map((j) => j.id).sort();
    assert.deepEqual(ids, ['good-one', 'good-two']);
  });

  it('listJobs returns [] for a state dir with no jobs root (never throws)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-empty-'));
    try {
      assert.deepEqual(listJobs(empty), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
