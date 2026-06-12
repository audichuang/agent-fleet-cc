/**
 * Liveness classification + escalate-not-kill gate for the background-job
 * watchdog. A single bad observation never terminates a job; the verdict must
 * repeat for `confirmRounds` consecutive ticks, and any HEALTHY tick resets the
 * counter — so a slow-but-working job is never false-killed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLiveness, createLivenessGate, LIVENESS_DEFAULTS } from '../../plugins/antigravity/scripts/lib/liveness.mjs';

describe('classifyLiveness', () => {
  const base = { status: 'running', workerAlive: true, nowMs: 1000, deadlineMs: null };

  it('DONE when the job already reached a terminal status', () => {
    assert.equal(classifyLiveness({ ...base, status: 'completed' }), 'DONE');
    assert.equal(classifyLiveness({ ...base, status: 'cancelled' }), 'DONE');
  });

  it('DEAD when the worker process is gone', () => {
    assert.equal(classifyLiveness({ ...base, workerAlive: false }), 'DEAD');
  });

  it('HUNG when alive but past its deadline + grace', () => {
    const deadlineMs = 1000;
    const nowMs = deadlineMs + LIVENESS_DEFAULTS.deadlineGraceMs + 1;
    assert.equal(classifyLiveness({ ...base, deadlineMs, nowMs }), 'HUNG');
  });

  it('HEALTHY when alive, within deadline, not terminal', () => {
    assert.equal(classifyLiveness({ ...base, deadlineMs: 10 ** 12 }), 'HEALTHY');
    assert.equal(classifyLiveness(base), 'HEALTHY');
  });

  it('does NOT treat mere silence as fatal (no deadline → healthy)', () => {
    assert.equal(classifyLiveness({ ...base, quietMs: 10 ** 9 }), 'HEALTHY');
  });
});

describe('createLivenessGate (escalate-not-kill)', () => {
  const cfg = { ...LIVENESS_DEFAULTS, confirmRounds: 2 };

  it('terminates only after confirmRounds consecutive bad verdicts', () => {
    const gate = createLivenessGate(cfg);
    const dead = { status: 'running', workerAlive: false, nowMs: 1, deadlineMs: null };
    assert.deepEqual(gate.assess(dead), { verdict: 'DEAD', action: 'wait' });
    assert.deepEqual(gate.assess(dead), { verdict: 'DEAD', action: 'terminate' });
  });

  it('a HEALTHY tick resets the bad counter', () => {
    const gate = createLivenessGate(cfg);
    const dead = { status: 'running', workerAlive: false, nowMs: 1, deadlineMs: null };
    const ok = { status: 'running', workerAlive: true, nowMs: 1, deadlineMs: null };
    gate.assess(dead); // 1 bad
    assert.deepEqual(gate.assess(ok), { verdict: 'HEALTHY', action: 'wait' });
    // counter reset → one more bad is not yet terminate
    assert.deepEqual(gate.assess(dead), { verdict: 'DEAD', action: 'wait' });
  });

  it('stops immediately on a terminal status', () => {
    const gate = createLivenessGate(cfg);
    assert.deepEqual(
      gate.assess({ status: 'completed', workerAlive: true, nowMs: 1, deadlineMs: null }),
      { verdict: 'DONE', action: 'stop' },
    );
  });
});
