/**
 * Focused unit tests for small library modules — args, fs, process,
 * prompt-templates, atomic-state, state, plugin-info, and workspace.
 *
 * All tests use deterministic inputs and avoid sleeps or external
 * subprocesses (except `node` itself for plugin-info, which is fast).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Force a real /tmp; the sandbox TMPDIR may be inside a git repo.
const TMPROOT = '/tmp';

import { parseArgs, splitRawArgumentString, parseCommandInput } from '../../plugins/antigravity/scripts/lib/args.mjs';
import { readJsonFile, isProbablyText, readFileSafe } from '../../plugins/antigravity/scripts/lib/fs.mjs';
import { runCommand, runCommandChecked, formatCommandFailure } from '../../plugins/antigravity/scripts/lib/process.mjs';
import {
  buildReviewPrompt,
  buildRescuePrompt,
  buildTaskPrompt,
} from '../../plugins/antigravity/scripts/lib/prompt-templates.mjs';
import {
  withJobMutex,
  withWorkspaceMutex,
  writeJsonAtomic,
} from '../../plugins/antigravity/scripts/lib/atomic-state.mjs';
import {
  resolveStateDir,
  resolveStateFile,
  resolveJobsDir,
  resolveJobFile,
  resolveJobLogFile,
  ensureStateDir,
  loadState,
  saveState,
  upsertJob,
  setConfig,
  getConfig,
  listJobs,
  readJobFile,
  writeJobFile,
  appendJobLog,
  readJobLog,
} from '../../plugins/antigravity/scripts/lib/state.mjs';
import { buildPluginInfo, getPluginInfo, _resetCache } from '../../plugins/antigravity/scripts/lib/plugin-info.mjs';
import { resolveWorkspaceRoot } from '../../plugins/antigravity/scripts/lib/workspace.mjs';

// ───────────────────────────── args ─────────────────────────────

describe('args.parseArgs', () => {
  it('handles boolean flags, value flags, positionals, and -- terminator', () => {
    const out = parseArgs(['--json', '--scope', 'branch', 'pos1', '--', '--literal', 'pos2'], {
      booleanOptions: ['json'],
      valueOptions: ['scope'],
    });
    assert.equal(out.options.json, true);
    assert.equal(out.options.scope, 'branch');
    assert.deepEqual(out.positionals, ['pos1', '--literal', 'pos2']);
  });

  it('infers value vs boolean for unknown flags', () => {
    const explicit = parseArgs(['--unknown', 'value', '--bool', '--next'], {});
    assert.equal(explicit.options.unknown, 'value');
    assert.equal(explicit.options.bool, true);
    assert.equal(explicit.options.next, true);
  });

  it('value flag with no following arg gets empty string', () => {
    const out = parseArgs(['--scope'], { valueOptions: ['scope'] });
    assert.equal(out.options.scope, '');
  });

  it('supports --flag=value for value options and unknown options', () => {
    const out = parseArgs(['--scope=branch', '--timeout-ms=-1', '--custom=value'], {
      valueOptions: ['scope', 'timeout-ms'],
    });
    assert.equal(out.options.scope, 'branch');
    assert.equal(out.options['timeout-ms'], '-1');
    assert.equal(out.options.custom, 'value');
  });

  it('parses inline boolean false as false, not a truthy string', () => {
    const out = parseArgs(['--json=false', '--wait=true', '--follow'], {
      booleanOptions: ['json', 'wait', 'follow'],
    });
    assert.equal(out.options.json, false);
    assert.equal(out.options.wait, true);
    assert.equal(out.options.follow, true);
  });
});

describe('args.splitRawArgumentString', () => {
  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(splitRawArgumentString(''), []);
    assert.deepEqual(splitRawArgumentString(null), []);
    assert.deepEqual(splitRawArgumentString(42), []);
  });

  it('respects single and double quotes', () => {
    assert.deepEqual(splitRawArgumentString('a "b c" d'), ['a', 'b c', 'd']);
    assert.deepEqual(splitRawArgumentString("'x y' z"), ['x y', 'z']);
  });

  it('supports backslash escape inside the string', () => {
    assert.deepEqual(splitRawArgumentString('a\\ b c'), ['a b', 'c']);
  });

  it('handles trailing token and consecutive spaces', () => {
    assert.deepEqual(splitRawArgumentString('  one   two  '), ['one', 'two']);
  });
});

describe('args.parseCommandInput', () => {
  it('splits a single quoted argv element', () => {
    const out = parseCommandInput(['--json "hello world"'], { booleanOptions: ['json'] });
    assert.equal(out.options.json, true);
    assert.deepEqual(out.positionals, ['hello world']);
  });

  it('passes plain argv through unchanged', () => {
    const out = parseCommandInput(['--json', 'plain'], { booleanOptions: ['json'] });
    assert.equal(out.options.json, true);
    assert.deepEqual(out.positionals, ['plain']);
  });

  it('skips falsy or non-string entries', () => {
    const out = parseCommandInput(['', null, undefined, 42, 'foo'], {});
    assert.deepEqual(out.positionals, ['foo']);
  });
});

// ───────────────────────────── fs ─────────────────────────────

describe('fs helpers', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-fs-')); });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

  it('readJsonFile returns parsed object or null on missing/invalid', () => {
    const valid = path.join(tmp, 'ok.json');
    fs.writeFileSync(valid, JSON.stringify({ a: 1 }));
    assert.deepEqual(readJsonFile(valid), { a: 1 });

    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    assert.equal(readJsonFile(bad), null);
    assert.equal(readJsonFile(path.join(tmp, 'missing.json')), null);
  });

  it('isProbablyText flags NULL bytes as binary', () => {
    assert.equal(isProbablyText(Buffer.from('hello world')), true);
    assert.equal(isProbablyText(Buffer.from([0x48, 0x00, 0x69])), false);
    assert.equal(isProbablyText(Buffer.alloc(0)), true);
  });

  it('readFileSafe returns "" for missing files and contents otherwise', () => {
    const f = path.join(tmp, 'safe.txt');
    fs.writeFileSync(f, 'safe');
    assert.equal(readFileSafe(f), 'safe');
    assert.equal(readFileSafe(path.join(tmp, 'nope.txt')), '');
  });
});

// ───────────────────────────── process ─────────────────────────────

describe('process helpers', () => {
  it('runCommand returns stdout/status for a known good command', () => {
    const r = runCommand(process.execPath, ['-e', 'console.log("ok")']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ok/);
    assert.equal(r.error, null);
  });

  it('runCommand returns error shape for a missing binary', () => {
    const r = runCommand('definitely-not-a-real-binary-xyz', ['arg']);
    assert.notEqual(r.status, 0);
    assert.ok(r.error || r.status !== 0);
  });

  it('runCommandChecked throws on non-zero exit and returns stdout otherwise', () => {
    assert.throws(() => runCommandChecked(process.execPath, ['-e', 'process.exit(2)']));
    const out = runCommandChecked(process.execPath, ['-e', 'console.log("hi")']);
    assert.match(out, /hi/);
  });

  it('formatCommandFailure includes status and stderr', () => {
    const s = formatCommandFailure({ stdout: '', stderr: 'boom', status: 2 });
    assert.match(s, /status 2/);
    assert.match(s, /stderr: boom/);
  });

  it('formatCommandFailure handles null status and missing stderr', () => {
    const s = formatCommandFailure({ stdout: '', stderr: '', status: null });
    assert.match(s, /unknown/);
  });
});

// ───────────────────────────── prompt-templates ─────────────────────────────

describe('prompt-templates', () => {
  it('buildRescuePrompt / buildTaskPrompt pass through the user prompt verbatim', () => {
    assert.equal(buildRescuePrompt('hello'), 'hello');
    assert.equal(buildTaskPrompt('do thing'), 'do thing');
  });

  it('buildReviewPrompt with working-tree scope includes diff and summary', () => {
    const out = buildReviewPrompt({
      scope: 'working-tree',
      context: { summary: 'changes', diff: 'diff body', untrackedContents: [] },
    });
    assert.match(out, /Scope: working-tree/);
    assert.match(out, /diff body/);
    assert.match(out, /## Output/);
  });

  it('buildReviewPrompt with branch scope includes commits block', () => {
    const out = buildReviewPrompt({
      scope: 'branch',
      context: { summary: 's', commits: 'abc feat', diff: 'd' },
    });
    assert.match(out, /## Commits/);
    assert.match(out, /abc feat/);
  });

  it('buildReviewPrompt truncates a large diff', () => {
    const big = 'X'.repeat(200 * 1024);
    const out = buildReviewPrompt({
      scope: 'working-tree',
      context: { summary: 's', diff: big, untrackedContents: [] },
    });
    assert.match(out, /more diff bytes truncated/);
  });

  it('buildReviewPrompt embeds untracked files', () => {
    const out = buildReviewPrompt({
      scope: 'working-tree',
      context: {
        summary: 's',
        diff: '',
        untrackedContents: [{ path: 'a.txt', content: 'hello' }, { path: 'b.bin', skipped: 'binary' }],
      },
    });
    assert.match(out, /### a\.txt/);
    assert.match(out, /hello/);
  });
});

// ───────────────────────────── atomic-state ─────────────────────────────

describe('atomic-state', () => {
  it('withJobMutex serializes concurrent callers FIFO', async () => {
    const order = [];
    const start = (id, ms) =>
      withJobMutex('/w', 'k', async () => {
        order.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end:${id}`);
      });
    await Promise.all([start('a', 5), start('b', 1), start('c', 1)]);
    assert.deepEqual(order, [
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('withWorkspaceMutex isolates different keys', async () => {
    const ops = [];
    const a = withWorkspaceMutex('/wa', async () => {
      ops.push('a-start');
      await new Promise((r) => setTimeout(r, 2));
      ops.push('a-end');
    });
    const b = withWorkspaceMutex('/wb', async () => {
      ops.push('b-start');
      ops.push('b-end');
    });
    await Promise.all([a, b]);
    // Both completed; b ran while a was waiting.
    assert.ok(ops.includes('a-end') && ops.includes('b-end'));
  });

  it('writeJsonAtomic writes via temp rename', () => {
    const dir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-atomic-'));
    try {
      const target = path.join(dir, 'state.json');
      writeJsonAtomic(target, { a: 1 });
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 1 });
      // No leftover temp files.
      const left = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
      assert.equal(left.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeJsonAtomic surfaces serialization errors and cleans the temp file', () => {
    const dir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-atomic-err-'));
    try {
      const target = path.join(dir, 'state.json');
      // BigInt cannot be serialized to JSON.
      assert.throws(() => writeJsonAtomic(target, { n: 1n }));
      // Target should not exist.
      assert.equal(fs.existsSync(target), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeJsonAtomic cleans up when rename fails (target dir missing)', () => {
    const target = '/this/path/should/not/exist/foo.json';
    assert.throws(() => writeJsonAtomic(target, { a: 1 }));
  });
});

// ───────────────────────────── state ─────────────────────────────

describe('state — persistence + reconciliation', () => {
  let tmpData;
  let workCwd;
  const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;

  before(() => {
    tmpData = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-state-data-'));
    workCwd = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-state-work-'));
    process.env.CLAUDE_PLUGIN_DATA = tmpData;
  });
  after(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(workCwd, { recursive: true, force: true }); } catch {}
  });

  it('resolveStateDir/File/JobsDir/JobFile/JobLogFile compose correctly', () => {
    const dir = resolveStateDir(workCwd);
    assert.equal(resolveStateFile(workCwd), path.join(dir, 'state.json'));
    assert.equal(resolveJobsDir(workCwd), path.join(dir, 'jobs'));
    assert.equal(resolveJobFile(workCwd, 'abc'), path.join(dir, 'jobs', 'abc.json'));
    assert.equal(resolveJobLogFile(workCwd, 'abc'), path.join(dir, 'jobs', 'abc.log'));
  });

  it('loadState returns defaults when nothing on disk', () => {
    const s = loadState(workCwd);
    assert.equal(s.version, 1);
    assert.deepEqual(s.jobs, []);
    assert.deepEqual(s.config, { stopReviewGate: false });
  });

  it('loadState recovers default state from corrupt file', () => {
    ensureStateDir(workCwd);
    fs.writeFileSync(resolveStateFile(workCwd), '{ bad');
    const s = loadState(workCwd);
    assert.deepEqual(s.jobs, []);
  });

  it('setConfig persists and getConfig reads back', async () => {
    await setConfig(workCwd, { stopReviewGate: true });
    const cfg = getConfig(workCwd);
    assert.equal(cfg.stopReviewGate, true);
  });

  it('upsertJob inserts then updates by id', async () => {
    await upsertJob(workCwd, { id: 'j1', kind: 'task', status: 'queued' });
    let jobs = listJobs(workCwd);
    assert.equal(jobs.find((j) => j.id === 'j1').status, 'queued');

    await upsertJob(workCwd, { id: 'j1', status: 'running' });
    jobs = listJobs(workCwd);
    assert.equal(jobs.find((j) => j.id === 'j1').status, 'running');
  });

  it('writeJobFile + readJobFile + log append/read round-trip', async () => {
    await writeJobFile(workCwd, 'j1', { id: 'j1', payload: 'p' });
    const read = readJobFile(workCwd, 'j1');
    assert.equal(read.payload, 'p');

    appendJobLog(workCwd, 'j1', 'line one');
    appendJobLog(workCwd, 'j1', 'line two');
    const log = readJobLog(workCwd, 'j1');
    assert.match(log, /line one/);
    assert.match(log, /line two/);

    // readJobFile on missing returns null.
    assert.equal(readJobFile(workCwd, 'no-such'), null);
  });

  it('saveState prunes jobs beyond MAX_JOBS=50 and removes per-job files', async () => {
    // Build 52 jobs in a single saveState call.
    const now = new Date();
    const many = Array.from({ length: 52 }, (_, i) => ({
      id: `b${String(i).padStart(3, '0')}`,
      kind: 'task',
      status: 'completed',
      updatedAt: new Date(now.getTime() + i * 1000).toISOString(),
    }));
    // Pre-write per-job files so we can detect pruning of files.
    ensureStateDir(workCwd);
    for (const j of many) {
      fs.writeFileSync(resolveJobFile(workCwd, j.id), JSON.stringify(j));
    }
    await saveState(workCwd, { version: 1, config: {}, jobs: many });
    const after = listJobs(workCwd);
    assert.ok(after.length <= 50, `expected <=50 jobs, got ${after.length}`);
    // Oldest jobs should be pruned out of the on-disk index.
    assert.equal(after.find((j) => j.id === 'b000'), undefined);
  });

  it('saveState removes per-job files for jobs dropped by the MAX_JOBS cap', async () => {
    // Use an isolated workspace so test order does not matter.
    const isoData = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-prune-'));
    const isoCwd = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-prune-cwd-'));
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = isoData;
    try {
      // Seed the index with 50 old jobs (each with a corresponding on-disk file).
      const oldJobs = Array.from({ length: 50 }, (_, i) => ({
        id: `old${String(i).padStart(2, '0')}`,
        updatedAt: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      }));
      await saveState(isoCwd, { version: 1, config: {}, jobs: oldJobs });
      // Write the per-job files referenced by the index.
      for (const j of oldJobs) {
        fs.writeFileSync(resolveJobFile(isoCwd, j.id), JSON.stringify(j));
      }
      // Save a snapshot that adds a 51st newer job. Reconciliation will keep
      // all 51, then the MAX_JOBS=50 cap drops the oldest ("old00").
      const newer = { id: 'newest', updatedAt: new Date(2025, 0, 1).toISOString() };
      await saveState(isoCwd, { version: 1, config: {}, jobs: [...oldJobs, newer] });

      const after = listJobs(isoCwd);
      assert.equal(after.length, 50);
      // Oldest dropped from the index.
      assert.equal(after.find((j) => j.id === 'old00'), undefined);
      // Per-job file for the dropped job removed.
      assert.equal(fs.existsSync(resolveJobFile(isoCwd, 'old00')), false);
      // Newest retained.
      assert.ok(after.find((j) => j.id === 'newest'));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = saved;
      try { fs.rmSync(isoData, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(isoCwd, { recursive: true, force: true }); } catch {}
    }
  });
});

// ───────────────────────────── plugin-info + workspace ─────────────────────────────

describe('plugin-info + workspace', () => {
  it('buildPluginInfo returns a frozen object', () => {
    const info = buildPluginInfo({ name: 'x', version: '1.0', description: 'd', homepage: 'h' });
    assert.equal(info.name, 'x');
    assert.equal(Object.isFrozen(info), true);
  });

  it('getPluginInfo loads from disk and caches', async () => {
    _resetCache();
    const a = await getPluginInfo();
    const b = await getPluginInfo();
    assert.equal(a, b);
    assert.equal(typeof a.name, 'string');
  });

  it('resolveWorkspaceRoot returns a string path for cwd', () => {
    const r = resolveWorkspaceRoot(process.cwd());
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
  });
});
