/**
 * Tests for scripts/lib/render.mjs — pure rendering, no I/O, no clocks.
 *
 * Each render helper is exercised on representative input so that all
 * conditional branches (verdict, scope, missing fields, event tail,
 * elapsed buckets, follow-up commands) are covered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderReviewResult,
  renderStatusSnapshot,
  renderSingleJobStatus,
  renderResultOutput,
  renderCancelReport,
  renderSetupReport,
  outputCommandResult,
} from '../../plugins/antigravity/scripts/lib/render.mjs';

describe('renderReviewResult', () => {
  it('renders an approve verdict with no findings or steps', () => {
    const out = renderReviewResult({
      verdict: 'approve',
      summary: 'looks fine',
      findings: [],
      next_steps: [],
    });
    assert.match(out, /APPROVED/);
    assert.match(out, /Verdict.*approve/);
    assert.match(out, /Summary.*looks fine/);
    assert.doesNotMatch(out, /## Next Steps/);
  });

  it('renders changes-requested with findings and steps', () => {
    const out = renderReviewResult({
      verdict: 'changes_requested',
      summary: 'fix me',
      findings: [
        {
          severity: 'critical',
          title: 'Bad',
          body: 'why',
          file: 'a.js',
          line_start: 1,
          line_end: 5,
          confidence: 0.9,
          recommendation: 'do x',
        },
      ],
      next_steps: ['rerun tests'],
    });
    assert.match(out, /NEEDS ATTENTION/);
    assert.match(out, /Bad/);
    assert.match(out, /a\.js/);
    assert.match(out, /do x/);
    assert.match(out, /## Next Steps/);
    assert.match(out, /rerun tests/);
  });
});

describe('renderStatusSnapshot', () => {
  it('renders the empty snapshot', () => {
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      runtimeStatus: {},
      running: [],
      latestFinished: null,
      recent: [],
      needsReview: false,
    });
    assert.match(out, /Antigravity Status/);
    assert.match(out, /Review gate: disabled/);
    assert.match(out, /No antigravity jobs/);
  });

  it('renders running + recent tables and review-gate enabled', () => {
    const now = new Date().toISOString();
    const out = renderStatusSnapshot({
      workspaceRoot: '/tmp',
      config: {},
      runtimeStatus: {},
      running: [{ id: 'r1', kind: 'task', status: 'running', startedAt: now }],
      latestFinished: null,
      recent: [
        { id: 'd1', kind: 'task', status: 'completed', startedAt: now, completedAt: now, summary: 'ok' },
        { id: 'f1', kind: 'rescue', status: 'failed', startedAt: now, completedAt: now },
      ],
      needsReview: true,
    });
    assert.match(out, /Review gate: enabled/);
    assert.match(out, /## Active Jobs/);
    assert.match(out, /\| r1 /);
    assert.match(out, /## Recent Jobs/);
    assert.match(out, /\/antigravity:result d1/);
    // Failed jobs render "-" as follow-up, not the result command.
    assert.doesNotMatch(out, /\/antigravity:result f1/);
  });
});

describe('renderSingleJobStatus', () => {
  it('handles a bare job object with minimal fields', () => {
    const out = renderSingleJobStatus({ id: 'job1', status: 'queued' });
    assert.match(out, /Antigravity Job: job1/);
    assert.match(out, /Kind.*unknown/);
    assert.match(out, /Status.*queued/);
  });

  it('handles a wrapper { job } and includes error + progress + events', () => {
    const job = {
      id: 'job2',
      kind: 'task',
      status: 'failed',
      phase: 'failed',
      title: 'demo',
      threadId: 'thr_1',
      summary: 'broke',
      healthStatus: 'failed',
      healthMessage: 'oom',
      recommendedAction: 'retry',
      pid: 123,
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: '2024-01-01T00:00:01Z',
      completedAt: '2024-01-01T00:00:02Z',
      errorMessage: 'segfault',
      recentProgress: ['line a', 'line b'],
      runtime: { transport: 'stdio' },
      events: [
        { type: 'model_text_chunk', chars: 10, timestamp: '2024-01-01T00:00:01Z' },
        { type: 'model_thought_chunk', chars: 4, timestamp: '2024-01-01T00:00:01Z' },
        { type: 'tool_call', toolName: 'bash', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'file_change', action: 'edit', path: 'a.js', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'phase', message: 'thinking', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'phase_changed', phase: 'tooling', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'diagnostic', source: 'lsp', message: 'warn', timestamp: '2024-01-01T00:00:01Z' },
        { type: 'mystery', timestamp: '2024-01-01T00:00:01Z' },
      ],
    };
    const out = renderSingleJobStatus({ workspaceRoot: '/w', job }, { now: Date.parse('2024-01-01T00:00:05Z') });
    assert.match(out, /Antigravity Job: job2/);
    assert.match(out, /Session ID.*thr_1/);
    assert.match(out, /## Error/);
    assert.match(out, /segfault/);
    assert.match(out, /## Recent Progress/);
    assert.match(out, /line a/);
    assert.match(out, /## Recent Events/);
    assert.match(out, /chunks=1/);
    assert.match(out, /thoughts=1/);
    assert.match(out, /tools=1/);
    assert.match(out, /files=1/);
    assert.match(out, /Transport.*stdio/);
  });
});

describe('renderResultOutput', () => {
  it('renders raw stdout with conversation footer', () => {
    const out = renderResultOutput(
      '/cwd',
      { id: 'j', threadId: 'thr_x' },
      { result: { rawOutput: 'final answer' } }
    );
    assert.match(out, /final answer/);
    assert.match(out, /Conversation ID: thr_x/);
    assert.match(out, /Resume conversation: agy --conversation thr_x/);
  });

  it('renders raw stdout without thread footer when no threadId', () => {
    const out = renderResultOutput('/cwd', { id: 'j' }, { result: { agy: { stdout: 'hi' } } });
    assert.match(out, /hi/);
    assert.doesNotMatch(out, /Conversation ID/);
  });

  it('renders pre-rendered markdown when present', () => {
    const out = renderResultOutput('/cwd', { id: 'j', threadId: 't' }, { rendered: '## Done' });
    assert.match(out, /## Done/);
    assert.match(out, /Resume conversation/);
  });

  it('falls back to metadata when no raw output and no rendered', () => {
    const out = renderResultOutput(
      '/cwd',
      { id: 'j2', title: 'T', status: 'completed', summary: 'sum' },
      { errorMessage: 'oops' }
    );
    // Title takes precedence over the default "Antigravity Result" header.
    assert.match(out, /# T/);
    assert.match(out, /Job: j2/);
    assert.match(out, /Status: completed/);
    assert.match(out, /Summary: sum/);
    assert.match(out, /oops/);
  });

  it('uses default header "Antigravity Result" when title is missing', () => {
    const out = renderResultOutput('/cwd', { id: 'j4', status: 'failed' }, {});
    assert.match(out, /Antigravity Result/);
    assert.match(out, /No captured result payload/);
  });

  it('falls back with no metadata produces the empty-result message', () => {
    const out = renderResultOutput('/cwd', { id: 'j3', status: 'queued' }, {});
    assert.match(out, /No captured result payload/);
  });
});

describe('renderCancelReport / renderSetupReport / outputCommandResult', () => {
  it('renders cancel without optional fields', () => {
    const out = renderCancelReport({ id: 'j', status: 'cancelled' });
    assert.match(out, /Antigravity Cancel/);
    assert.match(out, /Cancelled j/);
    assert.match(out, /Status: cancelled/);
  });

  it('renders cancel with title and kind', () => {
    const out = renderCancelReport({ id: 'j', status: 'cancelled', title: 'T', kind: 'task' });
    assert.match(out, /Title: T/);
    assert.match(out, /Kind: task/);
  });

  it('renders setup with all fields', () => {
    const out = renderSetupReport({
      agyAvailable: true,
      agyVersion: '1.0.1',
      authenticated: true,
      authMethod: 'oauth',
      npmAvailable: true,
      reviewGate: true,
      message: 'all good',
    });
    assert.match(out, /agy CLI: installed \(1\.0\.1\)/);
    assert.match(out, /Authentication: authenticated/);
    assert.match(out, /Auth method: oauth/);
    assert.match(out, /npm: available/);
    assert.match(out, /Review gate: enabled/);
    assert.match(out, /all good/);
  });

  it('renders setup with negative branches', () => {
    const out = renderSetupReport({
      agyAvailable: false,
      authenticated: false,
      npmAvailable: false,
      reviewGate: false,
    });
    assert.match(out, /not installed/);
    assert.match(out, /not authenticated/);
    assert.match(out, /npm: not available/);
    assert.match(out, /Review gate: disabled/);
  });

  it('outputCommandResult emits markdown or JSON based on flag', () => {
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s, ...rest) => { chunks.push(s); return true; };
    try {
      outputCommandResult({ ok: 1 }, '# Markdown\n', false);
      outputCommandResult({ ok: 2 }, 'IGNORED', true);
    } finally {
      process.stdout.write = origWrite;
    }
    assert.equal(chunks[0], '# Markdown\n');
    assert.match(chunks[1], /"ok": 2/);
  });
});
