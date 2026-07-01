/**
 * Focused unit tests for small library modules — args, fs, process,
 * prompt-templates, plugin-info, and workspace. The atomic-state / state blocks
 * were removed with the shared-runtime migration (those modules are deleted; the
 * shared store + tests/shared/ own persistence/CAS now).
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
