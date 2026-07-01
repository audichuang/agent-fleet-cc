// Session filtering (D-14 / BEHAVIOR CHANGE 6) survived the shared-runtime
// migration and now lives in lib/job-runtime.mjs (job-control.mjs deleted).
// The host session id rides the shared job's top-level `sessionId` field
// (agy's engine sessionId is always null), so status/result/cancel keep their
// multi-session isolation. sortJobsNewestFirst is now private to job-runtime and
// covered via listProjectedJobs (job-runtime.test.mjs); process-liveness is owned
// by the shared reconcile layer (tests/shared/).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterJobsForCurrentSession,
  SESSION_ID_ENV,
} from '../../plugins/antigravity/scripts/lib/job-runtime.mjs';

describe('filterJobsForCurrentSession', () => {
  it('returns input unchanged when SESSION_ID_ENV is absent', () => {
    const jobs = [{ id: 'a', sessionId: 's1' }];
    assert.deepEqual(filterJobsForCurrentSession(jobs, {}), jobs);
  });

  it('keeps only jobs whose top-level sessionId matches the current session', () => {
    const jobs = [
      { id: 'a', sessionId: 's1' },
      { id: 'b', sessionId: 's2' },
      { id: 'c', sessionId: 's1' },
    ];
    const env = { [SESSION_ID_ENV]: 's1' };
    assert.deepEqual(filterJobsForCurrentSession(jobs, env).map((j) => j.id), ['a', 'c']);
  });

  it('drops jobs from other sessions (isolation)', () => {
    const jobs = [{ id: 'x', sessionId: 'other' }];
    const env = { [SESSION_ID_ENV]: 'mine' };
    assert.deepEqual(filterJobsForCurrentSession(jobs, env), []);
  });
});
