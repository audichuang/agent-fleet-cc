import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortJobsNewestFirst,
  filterJobsForCurrentSession,
  defaultIsProcessAlive,
  SESSION_ID_ENV,
} from '../../plugins/antigravity/scripts/lib/job-control.mjs';

describe('sortJobsNewestFirst', () => {
  it('sorts by updatedAt descending', () => {
    const jobs = [
      { id: 'a', updatedAt: '2026-05-22T10:00:00Z' },
      { id: 'b', updatedAt: '2026-05-22T12:00:00Z' },
      { id: 'c', updatedAt: '2026-05-22T11:00:00Z' },
    ];
    assert.deepEqual(sortJobsNewestFirst(jobs).map((j) => j.id), ['b', 'c', 'a']);
  });

  it('does not mutate input array', () => {
    const jobs = [{ id: 'a', updatedAt: '1' }, { id: 'b', updatedAt: '2' }];
    sortJobsNewestFirst(jobs);
    assert.deepEqual(jobs.map((j) => j.id), ['a', 'b']);
  });
});

describe('filterJobsForCurrentSession', () => {
  it('returns input unchanged when SESSION_ID_ENV is absent', () => {
    const jobs = [{ id: 'a', sessionId: 's1' }];
    assert.deepEqual(filterJobsForCurrentSession(jobs, {}), jobs);
  });

  it('keeps only jobs matching the current session id', () => {
    const jobs = [
      { id: 'a', sessionId: 's1' },
      { id: 'b', sessionId: 's2' },
      { id: 'c', sessionId: 's1' },
    ];
    const env = { [SESSION_ID_ENV]: 's1' };
    assert.deepEqual(filterJobsForCurrentSession(jobs, env).map((j) => j.id), ['a', 'c']);
  });
});

describe('defaultIsProcessAlive', () => {
  it('returns true for own PID', () => {
    assert.equal(defaultIsProcessAlive(process.pid), true);
  });
  it('returns true for falsy pid (treat as no-info)', () => {
    assert.equal(defaultIsProcessAlive(undefined), true);
    assert.equal(defaultIsProcessAlive(0), true);
    assert.equal(defaultIsProcessAlive(null), true);
  });
  it('returns false for a PID that does not exist', () => {
    // Very high PID unlikely to exist
    assert.equal(defaultIsProcessAlive(2 ** 22), false);
  });
});
