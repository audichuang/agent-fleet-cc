/**
 * Phase B feature correctness, exercised by running each command as a real
 * subprocess (the slash-command path) against a fake `agy` that echoes its
 * argv — so we assert exactly which flags the command forwards, with full
 * process isolation and no monkey-patching of process.stdout.
 *
 *  - B1: --model is forwarded verbatim (agy 1.0.7 has a native --model).
 *  - B2: review passes --sandbox (terminal containment only — NOT a write-block).
 *  - B5: rescue accepts --prompt-file (so /antigravity:handoff can pass a long
 *        composed prompt without an unwieldy argv).
 *  - B4: the resume hint points at the working `--continue`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderResultOutput } from '../../plugins/antigravity/scripts/lib/render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmd = (name) => path.resolve(__dirname, `../../plugins/antigravity/scripts/commands/${name}.mjs`);

function makeEnv() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-feat-data-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-feat-cwd-'));
  const agy = path.join(data, 'agy');
  fs.writeFileSync(agy, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  return { data, cwd, agy };
}

function runCmd(name, args, env) {
  return spawnSync(process.execPath, [cmd(name), ...args], {
    encoding: 'utf8',
    cwd: env.cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: env.data, AGY_BIN: env.agy, ANTIGRAVITY_PLUGIN_SESSION_ID: '' },
  });
}

function cleanup(env) {
  fs.rmSync(env.data, { recursive: true, force: true });
  fs.rmSync(env.cwd, { recursive: true, force: true });
}

describe('Phase B — feature correctness', () => {
  it('B1: rescue forwards --model verbatim to agy', () => {
    const env = makeEnv();
    try {
      const res = runCmd('rescue', ['--model', 'Gemini 3.1 Pro', 'do a thing'], env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /--model/);
      assert.match(res.stdout, /Gemini 3\.1 Pro/);
    } finally {
      cleanup(env);
    }
  });

  it('B2: review passes --sandbox for terminal containment', () => {
    const env = makeEnv();
    try {
      const genv = {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
      };
      execSync('git init -q', { cwd: env.cwd, stdio: 'ignore' });
      fs.writeFileSync(path.join(env.cwd, 'f.txt'), 'one\n');
      execSync('git add f.txt && git commit -q -m init', { cwd: env.cwd, stdio: 'ignore', env: genv });
      fs.writeFileSync(path.join(env.cwd, 'f.txt'), 'one\ntwo\n');

      const res = runCmd('review', [], env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /--sandbox/);
    } finally {
      cleanup(env);
    }
  });

  it('B5: rescue --prompt-file reads the prompt from a file', () => {
    const env = makeEnv();
    try {
      const promptFile = path.join(env.cwd, 'handoff.md');
      fs.writeFileSync(promptFile, 'CONTINUE_THE_HANDOFF_WORK marker');
      const res = runCmd('rescue', ['--prompt-file', promptFile], env);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /CONTINUE_THE_HANDOFF_WORK marker/);
    } finally {
      cleanup(env);
    }
  });

  it('B6: rescue --apply forwards write-mode flags; plain rescue does not', () => {
    const env = makeEnv();
    try {
      const plain = runCmd('rescue', ['do a thing'], env);
      assert.equal(plain.status, 0, plain.stderr);
      assert.doesNotMatch(plain.stdout, /--new-project/);
      assert.doesNotMatch(plain.stdout, /accept-edits/);

      const write = runCmd('rescue', ['--apply', 'edit the file'], env);
      assert.equal(write.status, 0, write.stderr);
      assert.match(write.stdout, /--new-project/);
      assert.match(write.stdout, /--mode\naccept-edits/);
      assert.doesNotMatch(write.stdout, /--dangerously-skip-permissions/);

      const yolo = runCmd('rescue', ['--apply', '--dangerously-skip-permissions', 'go'], env);
      assert.equal(yolo.status, 0, yolo.stderr);
      assert.match(yolo.stdout, /--dangerously-skip-permissions/);

      // skip-permissions without --apply is ignored (gated behind write).
      const bare = runCmd('rescue', ['--dangerously-skip-permissions', 'go'], env);
      assert.equal(bare.status, 0, bare.stderr);
      assert.doesNotMatch(bare.stdout, /--dangerously-skip-permissions/);
    } finally {
      cleanup(env);
    }
  });

  it('B7: task --apply forwards write-mode flags; plain task does not; skip gated behind apply', () => {
    const env = makeEnv();
    try {
      // task defaults to background; use --foreground so the argv-echo reaches stdout.
      const plain = runCmd('task', ['--foreground', 'do a thing'], env);
      assert.equal(plain.status, 0, plain.stderr);
      assert.doesNotMatch(plain.stdout, /--new-project/);
      assert.doesNotMatch(plain.stdout, /accept-edits/);

      const write = runCmd('task', ['--foreground', '--apply', 'edit the file'], env);
      assert.equal(write.status, 0, write.stderr);
      assert.match(write.stdout, /--new-project/);
      assert.match(write.stdout, /--mode\naccept-edits/);
      assert.doesNotMatch(write.stdout, /--dangerously-skip-permissions/);

      const yolo = runCmd('task', ['--foreground', '--apply', '--dangerously-skip-permissions', 'go'], env);
      assert.equal(yolo.status, 0, yolo.stderr);
      assert.match(yolo.stdout, /--dangerously-skip-permissions/);

      // skip-permissions without --apply is ignored (gated behind write).
      const bare = runCmd('task', ['--foreground', '--dangerously-skip-permissions', 'go'], env);
      assert.equal(bare.status, 0, bare.stderr);
      assert.doesNotMatch(bare.stdout, /--dangerously-skip-permissions/);
    } finally {
      cleanup(env);
    }
  });

  it('B4: resume hint uses --continue when no conversation id is known', () => {
    const out = renderResultOutput('/tmp/x', { id: 'j1', status: 'completed' }, {
      result: { rawOutput: 'done' },
    });
    assert.match(out, /--continue/);
    assert.doesNotMatch(out, /--conversation\s*$/m);
  });
});
