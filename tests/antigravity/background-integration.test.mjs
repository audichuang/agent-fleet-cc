/**
 * End-to-end background-job path: startBackgroundJob spawns the REAL
 * scripts/commands/_worker.mjs subprocess, which runs `agy --print` (here a
 * fake `agy` stub) and finalizes the job through the CAS. This is the highest-
 * fidelity guard for the worker → state finalize wiring.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGINAL = { ...process.env };
let tempDir;
let agyStub;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-bg-'));
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  // Fake agy: echoes a line, ignoring all flags/positionals.
  agyStub = path.join(tempDir, 'agy');
  fs.writeFileSync(agyStub, '#!/usr/bin/env bash\necho "hello from fake agy"\nexit 0\n', { mode: 0o755 });
  process.env.AGY_BIN = agyStub;
});
afterEach(() => {
  process.env.CLAUDE_PLUGIN_DATA = ORIGINAL.CLAUDE_PLUGIN_DATA ?? '';
  if (ORIGINAL.CLAUDE_PLUGIN_DATA === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  if (ORIGINAL.AGY_BIN === undefined) delete process.env.AGY_BIN;
  else process.env.AGY_BIN = ORIGINAL.AGY_BIN;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('background job end-to-end', () => {
  it('runs the worker and finalizes the job as completed with output', async () => {
    const { startBackgroundJob, waitForJob } = await import('../../plugins/antigravity/scripts/lib/job-helpers.mjs');
    const { job } = await startBackgroundJob({
      workspaceRoot: tempDir,
      kind: 'task',
      title: 'fake',
      prompt: 'say hi',
      cwd: tempDir,
      request: {},
      watchdog: false,
    });
    const final = await waitForJob(tempDir, job.id, { pollMs: 100, timeoutMs: 15000 });
    assert.ok(final, 'job should reach a terminal state');
    assert.equal(final.status, 'completed', `got ${final?.status}`);
    assert.match(final.result?.rawOutput ?? '', /hello from fake agy/);
  });
});
