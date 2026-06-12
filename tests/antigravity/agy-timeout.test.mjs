/**
 * Worker timeout wiring. A hung `agy --print` must be bounded:
 *  - agy's own `--print-timeout` is forwarded explicitly (no reliance on its
 *    hidden 5m default), and
 *  - resolveAgyTimeouts derives a Node-side hard backstop so a wedged agy that
 *    ignores its own timeout is still killed by runAgyPrint's SIGTERM timer.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAgyPrint, resolveAgyTimeouts } from '../../plugins/antigravity/scripts/lib/agent-runtime.mjs';

let tempDir;
let argEcho;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-timeout-'));
  // Fake agy that prints each argv entry on its own line.
  argEcho = path.join(tempDir, 'agy');
  fs.writeFileSync(argEcho, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveAgyTimeouts', () => {
  it('defaults to a 5m print timeout and a longer hard backstop', () => {
    const { printMs, hardMs } = resolveAgyTimeouts({});
    assert.equal(printMs, 300000);
    assert.ok(hardMs > printMs, 'hard backstop should exceed the print timeout');
  });

  it('honors AGY_PRINT_TIMEOUT_MS and AGY_JOB_TIMEOUT_MS overrides', () => {
    const { printMs, hardMs } = resolveAgyTimeouts({
      AGY_PRINT_TIMEOUT_MS: '1000',
      AGY_JOB_TIMEOUT_MS: '5000',
    });
    assert.equal(printMs, 1000);
    assert.equal(hardMs, 5000);
  });
});

describe('runAgyPrint forwards --print-timeout', () => {
  it('passes the print timeout as a Go duration when printTimeoutMs is set', async () => {
    const res = await runAgyPrint({ prompt: 'hi', printTimeoutMs: 30000, bin: argEcho });
    assert.equal(res.status, 'completed');
    assert.match(res.stdout, /--print-timeout/);
    assert.match(res.stdout, /\b30s\b/);
  });

  it('omits --print-timeout when not requested', async () => {
    const res = await runAgyPrint({ prompt: 'hi', bin: argEcho });
    assert.doesNotMatch(res.stdout, /--print-timeout/);
  });
});
