/**
 * End-to-end /antigravity:adversarial-review: run the real command subprocess
 * against a fake `agy` that emits a JSON review, and assert it renders the
 * structured report.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CMD = path.resolve(__dirname, '../../plugins/antigravity/scripts/commands/adversarial-review.mjs');

const REVIEW_JSON = JSON.stringify({
  verdict: 'changes_requested',
  summary: 'Found a null-deref risk.',
  findings: [
    {
      severity: 'high',
      title: 'NPE risk in f.txt',
      body: 'value may be null',
      file: 'f.txt',
      line_start: 2,
      line_end: 2,
      confidence: 0.85,
      recommendation: 'guard the null case',
    },
  ],
  next_steps: ['add a null guard'],
});

describe('adversarial-review (integration)', () => {
  it('renders a structured review from agy JSON output', () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-adv-data-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-adv-cwd-'));
    const agy = path.join(data, 'agy');
    // Fake agy: ignore args, print the JSON review on stdout.
    fs.writeFileSync(agy, `#!/usr/bin/env bash\ncat <<'JSON_EOF'\n${REVIEW_JSON}\nJSON_EOF\n`, { mode: 0o755 });

    const genv = {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
    };
    try {
      execSync('git init -q', { cwd, stdio: 'ignore' });
      fs.writeFileSync(path.join(cwd, 'f.txt'), 'one\n');
      execSync('git add f.txt && git commit -q -m init', { cwd, stdio: 'ignore', env: genv });
      fs.writeFileSync(path.join(cwd, 'f.txt'), 'one\ntwo\n');

      const res = spawnSync(process.execPath, [CMD], {
        encoding: 'utf8',
        cwd,
        env: { ...process.env, CLAUDE_PLUGIN_DATA: data, AGY_BIN: agy, ANTIGRAVITY_PLUGIN_SESSION_ID: '' },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Antigravity Adversarial Review/);
      assert.match(res.stdout, /NPE risk in f\.txt/);
      assert.match(res.stdout, /changes_requested/);
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
