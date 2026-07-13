/**
 * Smoke tests for the per-command modules, all on the SHARED runtime.
 *
 * Read commands (status/result/wait/logs/cancel) seed the shared dir-per-job
 * layout via createJob/finalizeJob (seedSharedJob). Launch commands
 * (task/rescue/review/adversarial/image) run their real run() entry in-process
 * against a directly-spawnable bash `agy` stub (AGY_BIN) so the shared worker
 * lifecycle is exercised end-to-end without a real agy binary.
 */

import { describe, it, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cmdPath = (name) =>
  path.resolve(HERE, `../../plugins/antigravity/scripts/commands/${name}.mjs`);

// Run a launch command as a REAL subprocess against the bash `agy` stub. Launch
// commands await real engine work; running them in-process under the shared
// process.stdout capture would swallow the test runner's own reporter output
// for sibling tests during the await. A subprocess keeps stdio fully isolated.
// Callers pass a stub body (agy script) + the state/data dir via CLAUDE_PLUGIN_DATA.
function runCmdSubprocess(name, args, { cwd, data, agyBody }) {
  const agy = path.join(data, 'agy');
  fs.writeFileSync(agy, `#!/usr/bin/env bash\n${agyBody}`, { mode: 0o755 });
  const childEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: data,
    AGY_BIN: agy,
    ANTIGRAVITY_PLUGIN_SESSION_ID: '',
  };
  // Strip the test-runner IPC so a detached worker child does not switch into
  // test-reporter mode (undefined env values would stringify to "undefined").
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  return spawnSync(process.execPath, [cmdPath(name), ...args], {
    encoding: 'utf8',
    cwd,
    env: childEnv,
  });
}

import { createJobRecord } from '../../plugins/antigravity/scripts/lib/shared/core/job.mjs';
import { createJob, finalizeJob, writeJob, logFilePath, jobDir } from '../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs';
import { appendEvent } from '../../plugins/antigravity/scripts/lib/shared/core/events.mjs';
import { stateDirFor } from '../../plugins/antigravity/scripts/lib/job-runtime.mjs';

const ORIGINAL_ENV = { ...process.env };

function makeTempCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
  // Make it look like a workspace root: an empty .git dir is enough for
  // git.mjs's ensureGitRepository(cwd) to return cwd itself when run by
  // resolveWorkspaceRoot. But ensureGitRepository runs `git rev-parse`, so
  // simpler: skip git and pass cwd directly.
  return dir;
}

function setPluginDataEnv(dir) {
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'test-session-' + randomBytes(3).toString('hex');
}

function captureStdio() {
  const out = [];
  const err = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    out.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    err.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

let tempDir;
beforeEach(() => {
  tempDir = makeTempCwd();
  setPluginDataEnv(tempDir);
});
afterEach(() => {
  process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_ENV.CLAUDE_PLUGIN_DATA ?? '';
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  if (ORIGINAL_ENV.AGY_BIN === undefined) delete process.env.AGY_BIN;
  else process.env.AGY_BIN = ORIGINAL_ENV.AGY_BIN;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

// Turn tempDir into a real git repo so resolveWorkspaceRoot anchors on it and
// review's collectReviewContext can produce a diff.
function initGitRepo() {
  const genv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
  };
  execSync('git init -q', { cwd: tempDir, stdio: 'ignore' });
  execSync('git commit --allow-empty -q -m init', { cwd: tempDir, stdio: 'ignore', env: genv });
}

// Commit a tracked file then modify it, so `git diff HEAD` (the working-tree
// diff review collects) is non-empty. Untracked files do NOT appear in that
// diff, so a tracked+modified file is required to exercise the review path.
function commitAndModify() {
  const genv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
  };
  fs.writeFileSync(path.join(tempDir, 'f.txt'), 'one\n');
  execSync('git add f.txt && git commit -q -m add', { cwd: tempDir, stdio: 'ignore', env: genv });
  fs.writeFileSync(path.join(tempDir, 'f.txt'), 'one\ntwo\n');
}

// Wait for a detached background worker to finalize the job (and be reaped), so
// it does not outlive the test file. Returns the terminal job.
async function waitForTerminal(id, deadlineMs = 10000) {
  const stateDir = stateDirFor(tempDir);
  const { readJob } = await import('../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs');
  const deadline = Date.now() + deadlineMs;
  const TERMINAL = ['completed', 'failed', 'cancelled', 'timed-out'];
  let job = readJob(stateDir, id);
  while (Date.now() < deadline && !TERMINAL.includes(job?.status)) {
    await new Promise((r) => setTimeout(r, 50));
    job = readJob(stateDir, id);
  }
  return job;
}

// Seed a job in the SHARED dir-per-job layout (Phase 4a status/result read this).
// status/result key off top-level sessionId (D-14), so stamp the current one.
function seedSharedJob(overrides = {}) {
  const stateDir = stateDirFor(tempDir);
  const record = createJobRecord({
    engine: 'antigravity',
    title: overrides.title ?? 'demo',
    cwd: tempDir,
    request: { kind: overrides.kind ?? 'task' },
  });
  record.sessionId = process.env.ANTIGRAVITY_PLUGIN_SESSION_ID ?? null;
  if (overrides.id) record.id = overrides.id;
  createJob(stateDir, record, overrides.prompt ?? 'hello');
  const status = overrides.status ?? 'completed';
  if (status === 'running') {
    // Active job with NO pid: reconcileDeadPids skips it (never auto-failed),
    // so it stays active and a wait/logs deadline can fire.
    writeJob(stateDir, { ...record, status: 'running', pid: overrides.pid ?? null });
  } else if (status !== 'queued') {
    const patch = { status };
    if (status === 'completed' || status === 'failed') {
      patch.resultText = overrides.resultText ?? null;
    }
    if (overrides.error) patch.error = overrides.error;
    if (overrides.errorKind) patch.errorKind = overrides.errorKind;
    finalizeJob(stateDir, record.id, patch);
  }
  // Optionally seed log content (shared layout: logFilePath(stateDir, id)).
  if (overrides.log != null) {
    fs.mkdirSync(path.dirname(logFilePath(stateDir, record.id)), { recursive: true });
    fs.writeFileSync(logFilePath(stateDir, record.id), overrides.log);
  }
  return { stateDir, id: record.id };
}

// ───────────────────────────── status ─────────────────────────────

describe('/antigravity:status', () => {
  it('renders an empty snapshot when no jobs exist', async () => {
    const { run } = await import('../../plugins/antigravity/scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /Antigravity Status/);
  });

  it('renders a single job snapshot when given a job id', async () => {
    const { id } = seedSharedJob({ status: 'completed', resultText: 'hi' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, new RegExp(id));
    assert.match(text, /Antigravity Job/);
  });

  it('shows a liveness summary for a running job (shared projection)', async () => {
    const { id, stateDir } = seedSharedJob({ status: 'running', pid: process.pid });
    appendEvent(jobDir(stateDir, id), 'spawned', { pid: process.pid });
    appendEvent(jobDir(stateDir, id), 'engine-event', { kind: 'line', text: 'applying patch to server.ts' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], {
        cwd: tempDir,
        livenessDeps: { isAlive: () => true, gitChanges: () => 4, nowMs: Date.now() },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /## Liveness/);
    assert.match(text, /alive✓/);
    assert.match(text, /applying patch to server\.ts/);
    assert.match(text, /Δwt: 4/);
  });
});

// ───────────────────────────── result ─────────────────────────────

describe('/antigravity:result', () => {
  it('returns 1 with a friendly error when no jobs exist', async () => {
    const { run } = await import('../../plugins/antigravity/scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /antigravity:result/);
  });

  it('renders a completed job and exits 0', async () => {
    const { id } = seedSharedJob({
      status: 'completed',
      resultText: 'hello world from agy',
    });

    const { run } = await import('../../plugins/antigravity/scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /hello world from agy/);
  });

  it('returns 2 for cancelled jobs', async () => {
    const { id } = seedSharedJob({ id: 'cancelledjob', status: 'cancelled' });
    const { run } = await import('../../plugins/antigravity/scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 2);
  });
});

// ───────────────────────────── wait ─────────────────────────────
// wait now runs on the shared runtime; seed via seedSharedJob. Exhaustive
// exit-code coverage (0/2/1/10 + terminal-timed-out vs deadline + missing)
// lives in poll.test.mjs; these are the command-level smoke checks.

describe('/antigravity:wait', () => {
  it('emits JSON and exits 0 for a completed job', async () => {
    const { id } = seedSharedJob({
      id: 'waitdone',
      status: 'completed',
      resultText: 'all done',
    });

    const { run } = await import('../../plugins/antigravity/scripts/commands/wait.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.engine, 'antigravity');
    assert.equal(payload.jobId, id);
    assert.equal(payload.status, 'completed');
    assert.equal(payload.summary, 'all done');
  });

  it('returns 2 for a cancelled job', async () => {
    const { id } = seedSharedJob({ id: 'waitcancelled', status: 'cancelled' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/wait.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 2);
    assert.equal(JSON.parse(cap.out.join('')).status, 'cancelled');
  });

  it('returns 10 when timeout expires before the job reaches terminal state', async () => {
    const { id } = seedSharedJob({ id: 'waitrunning', status: 'running' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/wait.mjs');
    const cap = captureStdio();
    let exit;
    try {
      // timeout-ms 0 → deadline reached on the first poll without a timer tick
      // (a tick under the global stdout capture leaks test-runner IPC bytes).
      exit = await run([id, '--timeout-ms', '0', '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 10);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.engine, 'antigravity');
    assert.equal(payload.jobId, id);
    assert.equal(payload.status, 'running');
    assert.equal(payload.timedOut, true);
  });

  it('attaches a liveness summary on a wait-deadline return for a running job', async () => {
    const { id, stateDir } = seedSharedJob({ id: 'waitlive', status: 'running', pid: process.pid });
    appendEvent(jobDir(stateDir, id), 'spawned', { pid: process.pid });
    appendEvent(jobDir(stateDir, id), 'engine-event', { kind: 'line', text: 'running the migration' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/wait.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--timeout-ms', '0', '--json'], {
        cwd: tempDir,
        livenessDeps: { isAlive: () => true, gitChanges: () => 4, nowMs: Date.now() },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 10);
    const payload = JSON.parse(cap.out.join(''));
    assert.ok(payload.liveness, 'wait-deadline payload must carry liveness');
    assert.equal(payload.liveness.alive, true);
    assert.equal(payload.liveness.workingTreeChanges, 4);
    assert.match(payload.liveness.lastActivity.text, /running the migration/);
  });

  it('rejects invalid and missing timeout values', async () => {
    const { id } = seedSharedJob({ id: 'waitbadtimeout', status: 'running' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/wait.mjs');
    for (const args of [
      [id, '--timeout-ms', 'abc'],
      [id, '--timeout-ms'],
      [id, '--timeout-ms', '-1'],
      [id, '--timeout-ms=-1'],
    ]) {
      const cap = captureStdio();
      let exit;
      try {
        exit = await run(args, { cwd: tempDir });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 1);
      assert.match(cap.err.join(''), /antigravity:wait/);
      assert.match(cap.err.join(''), /--timeout-ms/);
    }
  });
});

// ───────────────────────────── logs ─────────────────────────────

describe('/antigravity:logs', () => {
  it('prints the persisted job log without follow', async () => {
    const { id } = seedSharedJob({
      id: 'logdone',
      status: 'completed',
      log: 'first persisted line\nsecond persisted line\n',
    });

    const { run } = await import('../../plugins/antigravity/scripts/commands/logs.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /first persisted line/);
    assert.match(text, /second persisted line/);
  });

  it('emits JSON with engine, job id, status, and log', async () => {
    const { id } = seedSharedJob({ id: 'logjson', status: 'failed', log: 'failure details\n' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/logs.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.engine, 'antigravity');
    assert.equal(payload.jobId, id);
    assert.equal(payload.status, 'failed');
    assert.match(payload.log, /failure details/);
  });

  it('follows an already-terminal job log and exits cleanly', async () => {
    const { id } = seedSharedJob({ id: 'logfollow', status: 'completed', log: 'already terminal log\n' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/logs.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--follow'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /already terminal log/);
  });

  it('returns 1 with a friendly error when the job is unknown', async () => {
    const { run } = await import('../../plugins/antigravity/scripts/commands/logs.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['missing-job'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /antigravity:logs/);
    assert.match(cap.err.join(''), /no job found/i);
  });

  it('follow json emits current log and exits 10 when timeout expires before terminal state', async () => {
    const { id } = seedSharedJob({ id: 'logfollowtimeout', status: 'running', log: 'still running\n' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/logs.mjs');
    const cap = captureStdio();
    let exit;
    try {
      // timeout-ms 0 → the follow-to-terminal loop reaches the deadline on its
      // first check WITHOUT parking on a timer (a timer tick under the global
      // stdout capture would let the test-runner IPC leak into cap.out).
      exit = await run([id, '--follow', '--json', '--timeout-ms', '0'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 10);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.engine, 'antigravity');
    assert.equal(payload.jobId, id);
    assert.equal(payload.status, 'running');
    assert.equal(payload.timedOut, true);
    assert.match(payload.log, /still running/);
  });

  it('rejects invalid timeout values in --flag=value form', async () => {
    const { id } = seedSharedJob({ id: 'logbadtimeout', status: 'running', log: 'still running\n' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/logs.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--follow', '--json', '--timeout-ms=-1'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /antigravity:logs/);
    assert.match(cap.err.join(''), /--timeout-ms/);
  });
});

// ───────────────────────────── cancel ─────────────────────────────

describe('/antigravity:cancel', () => {
  it('errors out when no active jobs exist', async () => {
    const { run } = await import('../../plugins/antigravity/scripts/commands/cancel.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /No active antigravity jobs/);
  });

  it('marks a running job cancelled (no tracked pid to signal)', async () => {
    // A running job with no recorded worker pid: the dead-PID reconcile skips it
    // (no pid), and cancel marks it cancelled without signalling anything. A
    // dead-pid running job is instead auto-failed by reconcile (tests/shared).
    const { id } = seedSharedJob({ id: 'runningjob', status: 'running' });

    const { run } = await import('../../plugins/antigravity/scripts/commands/cancel.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0, cap.err.join(''));
    assert.match(cap.out.join(''), /Antigravity Cancel/);
    assert.match(cap.out.join(''), new RegExp(`Cancelled ${id}`));
  });
});

// ───────────────────────────── review ─────────────────────────────

describe('/antigravity:review', () => {
  it('returns 0 with "no changes" when collectReviewContext finds nothing', async (t) => {
    // Patch collectReviewContext via a module mock: create a fake git env by
    // pointing cwd at tempDir which is not a git repo, then short-circuit by
    // installing a global hook on the prototype is impossible. Instead, we
    // simulate by injecting an empty diff via a sibling-helper: temporarily
    // replace process.env.GIT_DIR with a path that yields empty diffs.
    //
    // Simpler path: initialize an empty git repo in tempDir so working-tree
    // diff is genuinely empty.
    const { execSync } = await import('node:child_process');
    try {
      execSync('git init -q', { cwd: tempDir, stdio: 'ignore' });
      execSync('git commit --allow-empty -q -m init', { cwd: tempDir, stdio: 'ignore', env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 't@example.com',
      } });
    } catch {
      t.skip('git not available');
      return;
    }

    const { run } = await import('../../plugins/antigravity/scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /no changes to review/i);
  });

  it('foreground: runs agy on the diff and returns its output (exit 0)', () => {
    initGitRepo();
    commitAndModify(); // tracked change → non-empty `git diff HEAD`
    const res = runCmdSubprocess('review', [], {
      cwd: tempDir,
      data: tempDir,
      agyBody: 'echo "REVIEW_OK"\nexit 0\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /REVIEW_OK/);
  });

  it('foreground: prints setup hint and exits 1 on an auth failure', () => {
    initGitRepo();
    commitAndModify(); // tracked change → non-empty `git diff HEAD`
    // agy emits the auth sentinel to stderr and exits nonzero → errorKind auth.
    const res = runCmdSubprocess('review', [], {
      cwd: tempDir,
      data: tempDir,
      agyBody: 'echo "Authentication required" 1>&2\nexit 1\n',
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not authenticated/i);
    assert.match(res.stderr, /antigravity:setup/);
  });
});

// ───────────────────────────── rescue + task launch ─────────────────────────────

describe('/antigravity:rescue', () => {
  it('rejects empty prompt without --conversation', async () => {
    const { run } = await import('../../plugins/antigravity/scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /no task text/);
  });

  it('foreground: runs agy and returns its output (exit 0)', () => {
    const res = runCmdSubprocess('rescue', ['do a thing'], {
      cwd: tempDir,
      data: tempDir,
      agyBody: 'echo "RESCUE_DONE"\nexit 0\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /RESCUE_DONE/);
  });

  it('foreground: setup hint + exit 1 on auth failure', () => {
    const res = runCmdSubprocess('rescue', ['do a thing'], {
      cwd: tempDir,
      data: tempDir,
      agyBody: 'echo "Authentication required" 1>&2\nexit 1\n',
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not authenticated/i);
    assert.match(res.stderr, /antigravity:setup/);
  });

  it('background: queues a job and returns immediately (exit 0)', async () => {
    const res = runCmdSubprocess('rescue', ['--background', 'do a thing', '--json'], {
      cwd: tempDir,
      data: tempDir,
      agyBody: 'echo "BG_RESCUE"\nexit 0\n',
    });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'queued');
    assert.ok(payload.jobId);
    // The detached worker finalizes the job on its own; wait so it is reaped.
    const final = await waitForTerminal(payload.jobId);
    assert.equal(final.status, 'completed', `got ${final?.status}`);
  });
});

describe('/antigravity:task', () => {
  it('rejects empty prompt without --conversation', async () => {
    const { run } = await import('../../plugins/antigravity/scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /no task text/);
  });

  it('foreground: runs agy and returns its output (exit 0)', () => {
    const res = runCmdSubprocess('task', ['--foreground', 'do it'], {
      cwd: tempDir,
      data: tempDir,
      agyBody: 'echo "TASK_DONE"\nexit 0\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK_DONE/);
  });

  it('background (default): queues a job and returns a jobId (exit 0)', async () => {
    const res = runCmdSubprocess('task', ['do it', '--json'], {
      cwd: tempDir,
      data: tempDir,
      agyBody: 'echo "BG_TASK"\nexit 0\n',
    });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'queued');
    assert.ok(payload.jobId);
    // The detached worker finalizes the job on its own; wait so it is reaped.
    const final = await waitForTerminal(payload.jobId);
    assert.equal(final.status, 'completed', `got ${final?.status}`);
  });
});

// ───────────────────────────── slash wrappers ─────────────────────────────

describe('slash command wrappers', () => {
  for (const name of ['wait', 'logs']) {
    it(`ships /antigravity:${name} wrapper`, () => {
      const file = path.resolve(process.cwd(), `plugins/antigravity/commands/${name}.md`);
      const text = fs.readFileSync(file, 'utf8');
      assert.match(text, /disable-model-invocation: true/);
      assert.ok(
        text.includes(`node "\${CLAUDE_PLUGIN_ROOT}/scripts/commands/${name}.mjs"`),
        text,
      );
    });
  }
});

test("logs --follow does not corrupt multibyte UTF-8 split across a poll boundary", async () => {
  // unit-level guard on the decoder seam: feed bytes split mid-character
  const { decodeStreamForTest } = await import("../../plugins/antigravity/scripts/commands/logs.mjs");
  const full = Buffer.from("héllo 中文 🚀 done\n", "utf8");
  const cut = 2; // splits the 'é' (0xC3 0xA9) across chunks
  const out = decodeStreamForTest([full.subarray(0, cut), full.subarray(cut)]);
  assert.equal(out, "héllo 中文 🚀 done\n");
  assert.ok(!out.includes("�"), "no replacement char");
});
