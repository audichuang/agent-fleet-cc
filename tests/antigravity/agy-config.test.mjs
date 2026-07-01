/**
 * Config split + one-time migration (spec D-6 / codex must-fix M2).
 *
 * agy-config stores `stopReviewGate` in `<stateDir>/config.json`. When
 * config.json is absent but a legacy `state.json` exists, `stopReviewGate` is
 * seeded from `state.json.config` ONCE so an in-place upgrade never resets it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getConfig, setConfig } from '../../plugins/antigravity/scripts/lib/agy-config.mjs';

let stateDir;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-config-'));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('agy-config getConfig', () => {
  it('returns defaults (gate disabled) on a fresh workspace without writing a file', () => {
    const config = getConfig(stateDir);
    assert.deepEqual(config, { stopReviewGate: false });
    // A pure read on a fresh workspace with no legacy state must not create a file.
    assert.equal(fs.existsSync(path.join(stateDir, 'config.json')), false);
  });

  it('one-time-migrates stopReviewGate:true from a legacy state.json.config', () => {
    fs.writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }),
    );
    const config = getConfig(stateDir);
    assert.equal(config.stopReviewGate, true);
    // Migration writes config.json so it is only seeded once.
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    assert.equal(persisted.stopReviewGate, true);
  });

  it('one-time-migrates stopReviewGate:false from a legacy state.json.config', () => {
    fs.writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [] }),
    );
    assert.equal(getConfig(stateDir).stopReviewGate, false);
    assert.ok(fs.existsSync(path.join(stateDir, 'config.json')));
  });

  it('does not re-migrate once config.json exists (config.json wins over legacy)', () => {
    fs.writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }),
    );
    // config.json already says disabled — legacy true must NOT override it.
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ stopReviewGate: false }),
    );
    assert.equal(getConfig(stateDir).stopReviewGate, false);
  });

  it('treats a corrupt config.json as absent and falls back to defaults', () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{ not json');
    assert.deepEqual(getConfig(stateDir), { stopReviewGate: false });
  });
});

describe('agy-config setConfig', () => {
  it('persists a patch and getConfig reads it back', () => {
    const next = setConfig(stateDir, { stopReviewGate: true });
    assert.equal(next.stopReviewGate, true);
    assert.equal(getConfig(stateDir).stopReviewGate, true);
  });

  it('merges over the migrated legacy value rather than clobbering it', () => {
    fs.writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }),
    );
    // First set touches an unrelated (future) key; the migrated gate survives.
    const next = setConfig(stateDir, {});
    assert.equal(next.stopReviewGate, true);
  });
});
