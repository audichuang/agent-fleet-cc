/**
 * State resilience:
 *  - Corrupt state.json / per-job files are quarantined (renamed aside) and a
 *    warning is emitted, instead of silently returning an empty index — so a
 *    partial write or power loss can't make every job vanish without a trace.
 *  - touchJobProgress writes lastProgressAt/lastHeartbeatAt so the health
 *    classifier's 'active' branch is reachable (previously nothing wrote them,
 *    so every long job eventually showed a misleading 'possibly_stalled').
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  ensureStateDir,
  loadState,
  readJobFile,
  resolveStateFile,
  resolveJobFile,
  upsertJob,
  writeJobFile,
  touchJobProgress,
} from '../../plugins/antigravity/scripts/lib/state.mjs';
import { buildSingleJobSnapshot } from '../../plugins/antigravity/scripts/lib/job-control.mjs';

const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
let tempDir;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-resil-'));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function captureStderr() {
  const buf = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => (buf.push(String(c)), true);
  return { text: () => buf.join(''), restore: () => { process.stderr.write = orig; } };
}

describe('corruption quarantine', () => {
  it('quarantines a corrupt state.json and returns defaults', () => {
    ensureStateDir(tempDir);
    const stateFile = resolveStateFile(tempDir);
    fs.writeFileSync(stateFile, '{ not valid json ');
    const cap = captureStderr();
    let state;
    try {
      state = loadState(tempDir);
    } finally {
      cap.restore();
    }
    assert.deepEqual(state.jobs, []);
    const dir = path.dirname(stateFile);
    assert.ok(
      fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt')),
      'corrupt state.json should be quarantined aside',
    );
    assert.match(cap.text(), /corrupt/i);
  });

  it('readJobFile returns null and quarantines a corrupt per-job file', () => {
    ensureStateDir(tempDir);
    const jf = resolveJobFile(tempDir, 'bad');
    fs.writeFileSync(jf, 'definitely not json');
    const cap = captureStderr();
    let r;
    try {
      r = readJobFile(tempDir, 'bad');
    } finally {
      cap.restore();
    }
    assert.equal(r, null);
    const dir = path.dirname(jf);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('bad.json.corrupt')));
  });

  it('readJobFile returns null for a missing file without quarantining', () => {
    ensureStateDir(tempDir);
    assert.equal(readJobFile(tempDir, 'nope'), null);
    const dir = path.dirname(resolveJobFile(tempDir, 'nope'));
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('corrupt')));
  });
});

describe('heartbeat → health', () => {
  it('touchJobProgress drives a live running job to active health', async () => {
    const id = 'hb' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    const job = { id, kind: 'task', status: 'running', phase: 'running', pid: process.pid };
    await upsertJob(tempDir, job);
    await writeJobFile(tempDir, id, job);

    await touchJobProgress(tempDir, id);

    const snap = buildSingleJobSnapshot(tempDir, id);
    assert.equal(snap.job.healthStatus, 'active');
    assert.ok(readJobFile(tempDir, id).lastProgressAt);
  });
});
