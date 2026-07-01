/**
 * End-to-end background-job path on the SHARED runtime: startBackground spawns
 * the REAL scripts/worker-entry.mjs subprocess (2-arg: <stateDir> <jobId>),
 * which runs `agy --print` (here a directly-spawnable fake `agy` stub) and
 * finalizes the job through the shared CAS. Highest-fidelity guard for the
 * worker → state finalize wiring after the Phase 4e migration.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startBackground } from '../../plugins/antigravity/scripts/lib/job-runtime.mjs';
import { readJob, jobDir } from '../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs';
import { readEvents } from '../../plugins/antigravity/scripts/lib/shared/core/events.mjs';

const ORIGINAL = { ...process.env };
let tempDir;
let cwd;
let env;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-bg-data-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-bg-cwd-'));
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true }); // resolveWorkspaceRoot anchor
  // Directly-spawnable fake agy: echoes a line, ignoring all flags/positionals.
  // resolveAgyBin returns AGY_BIN when it exists and spawnEngine spawns argv[0].
  const agyStub = path.join(tempDir, 'agy');
  fs.writeFileSync(agyStub, '#!/usr/bin/env bash\necho "hello from fake agy"\nexit 0\n', { mode: 0o755 });
  // A hermetic env for the launch helper: state root under tempDir, AGY_BIN →
  // stub, and NO test-runner IPC (so the detached worker does not switch into
  // node --test reporter mode).
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_PLUGIN_DATA: tempDir,
    AGY_BIN: agyStub,
  };
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('background job end-to-end', () => {
  it('runs the detached worker and finalizes the job completed with output', async () => {
    const { stateDir, job, failed } = startBackground({
      cwd,
      kind: 'task',
      title: 'fake',
      prompt: 'say hi',
      request: { mode: 'print' },
      env,
    });
    assert.equal(failed, false);

    // Poll for the detached worker to finalize the job.
    const deadline = Date.now() + 15000;
    const TERMINAL = ['completed', 'failed', 'cancelled', 'timed-out'];
    let final = readJob(stateDir, job.id);
    while (Date.now() < deadline && !TERMINAL.includes(final?.status)) {
      await new Promise((r) => setTimeout(r, 100));
      final = readJob(stateDir, job.id);
    }
    assert.ok(final, 'job should reach a terminal state');
    assert.equal(final.status, 'completed', `got ${final?.status}`);
    assert.match(final.resultText ?? '', /hello from fake agy/);

    // The full shared event trail must be present.
    const events = readEvents(jobDir(stateDir, job.id));
    for (const t of ['job-created', 'spawned', 'result', 'finalized']) {
      assert.ok(events.some((e) => e.type === t), `missing event ${t}`);
    }
  });
});
