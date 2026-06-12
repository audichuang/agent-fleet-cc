/**
 * Shared text helpers (deduped from _worker.mjs and job-helpers.mjs).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveSummary, trimToNull } from '../../plugins/antigravity/scripts/lib/text.mjs';

describe('deriveSummary', () => {
  it('returns the first non-empty line', () => {
    assert.equal(deriveSummary('\n  \nhello world\nmore'), 'hello world');
  });
  it('truncates a long first line to 120 chars', () => {
    const long = 'x'.repeat(200);
    const out = deriveSummary(long);
    assert.equal(out.length, 120);
    assert.match(out, /\.\.\.$/);
  });
  it('returns null for empty / non-string input', () => {
    assert.equal(deriveSummary(''), null);
    assert.equal(deriveSummary(undefined), null);
  });
});

describe('trimToNull', () => {
  it('trims and returns the string, or null when empty', () => {
    assert.equal(trimToNull('  hi  '), 'hi');
    assert.equal(trimToNull('   '), null);
    assert.equal(trimToNull(undefined), null);
  });
});
