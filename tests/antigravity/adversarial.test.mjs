/**
 * Adversarial review: agy is asked to return a strict JSON review, which
 * parseReviewJson tolerantly extracts (fenced or bare, with prose around it)
 * and renderReviewResult formats. buildAdversarialReviewPrompt asks for exactly
 * the fields the renderer expects, under a read-only directive.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseReviewJson, renderReviewResult } from '../../plugins/antigravity/scripts/lib/render.mjs';
import { buildAdversarialReviewPrompt } from '../../plugins/antigravity/scripts/lib/prompt-templates.mjs';

const SAMPLE = {
  verdict: 'changes_requested',
  summary: 'Two issues.',
  findings: [
    { severity: 'HIGH', title: 'NPE risk', body: 'x may be null', file: 'a.js', line_start: 10, line_end: 12, confidence: 0.9, recommendation: 'guard it' },
  ],
  next_steps: ['fix the NPE'],
};

describe('parseReviewJson', () => {
  it('parses a bare JSON object', () => {
    const r = parseReviewJson(JSON.stringify(SAMPLE));
    assert.equal(r.verdict, 'changes_requested');
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].severity, 'high'); // normalized lowercase
  });

  it('parses a ```json fenced block', () => {
    const r = parseReviewJson('Here is the review:\n```json\n' + JSON.stringify(SAMPLE) + '\n```\nDone.');
    assert.equal(r.verdict, 'changes_requested');
    assert.equal(r.findings[0].title, 'NPE risk');
  });

  it('extracts a JSON object embedded in prose', () => {
    const r = parseReviewJson('blah blah ' + JSON.stringify(SAMPLE) + ' trailing');
    assert.equal(r.summary, 'Two issues.');
  });

  it('returns null for non-JSON output', () => {
    assert.equal(parseReviewJson('I could not produce JSON, sorry.'), null);
    assert.equal(parseReviewJson(''), null);
  });

  it('produces a renderable shape (renderReviewResult does not throw)', () => {
    const r = parseReviewJson(JSON.stringify(SAMPLE));
    const md = renderReviewResult(r);
    assert.match(md, /Adversarial Review/);
    assert.match(md, /NPE risk/);
  });
});

describe('buildAdversarialReviewPrompt', () => {
  it('requests strict JSON with the expected fields under a read-only directive', () => {
    const prompt = buildAdversarialReviewPrompt({
      scope: 'working-tree',
      context: { summary: 's', diff: 'diff --git a b' },
    });
    assert.match(prompt, /JSON/);
    assert.match(prompt, /verdict/);
    assert.match(prompt, /findings/);
    assert.match(prompt, /severity/);
    assert.match(prompt, /read-only|do not modify/i);
  });
});
