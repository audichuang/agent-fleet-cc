/**
 * Black-box tests for bin/antigravity.mjs.
 *
 * We spawn the bin in a subprocess and assert exit code + stdio. The
 * `dispatch` test points at a temporary script-root via the
 * ANTIGRAVITY_SCRIPT_ROOT env hook so we never touch the real `agy`
 * binary.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../plugins/antigravity');
const BIN = path.resolve(REPO_ROOT, 'bin', 'antigravity.mjs');
const PLUGIN_JSON = JSON.parse(
  fs.readFileSync(path.resolve(REPO_ROOT, 'plugin.json'), 'utf8'),
);

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('bin/antigravity.mjs', () => {
  let tmpRoot;
  let probeMarker;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-bin-test-'));
    probeMarker = path.join(tmpRoot, 'probe.json');

    // Drop a stub command module that writes a marker file then returns
    // a predictable exit code. The bin should import this and invoke run().
    const stub = `
export async function run(argv, ctx) {
  const fs = await import('node:fs');
  fs.writeFileSync(${JSON.stringify(probeMarker)}, JSON.stringify({
    argv,
    host: ctx.host,
    cwd: ctx.cwd,
  }));
  return 42;
}
`;
    fs.writeFileSync(path.join(tmpRoot, 'review.mjs'), stub);
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('--version prints plugin.json version and exits 0', () => {
    const res = run(['--version']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), PLUGIN_JSON.version);
  });

  it('-V prints version and exits 0', () => {
    const res = run(['-V']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), PLUGIN_JSON.version);
  });

  it('no args prints help and exits 0', () => {
    const res = run([]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /antigravity-plugin/);
    assert.match(res.stdout, /Commands:/);
    assert.match(res.stdout, /setup/);
  });

  it('help <command> prints per-command help and exits 0', () => {
    const res = run(['help', 'review']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /antigravity-plugin review/);
    assert.match(res.stdout, /--base/);
    assert.match(res.stdout, /--scope/);
  });

  it('help image prints the image command help and exits 0', () => {
    const res = run(['help', 'image']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /antigravity-plugin image/);
    assert.match(res.stdout, /--output/);
    assert.match(res.stdout, /--name/);
  });

  it('lists image in the top-level help', () => {
    const res = run([]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /image/);
  });

  it('unknown command suggests closest match and exits 2', () => {
    const res = run(['reviw']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown command 'reviw'/);
    assert.match(res.stderr, /Did you mean 'review'\?/);
  });

  it('AGY_BIN points at a missing file → exit 127 with install URL', () => {
    const res = run(['setup'], { AGY_BIN: '/nonexistent/agy' });
    assert.equal(res.status, 127);
    assert.match(res.stderr, /AGY_BIN=\/nonexistent\/agy/);
    assert.match(res.stderr, /antigravity\.google\/download/);
  });

  it('dispatches to a stub command via ANTIGRAVITY_SCRIPT_ROOT', () => {
    const res = run(['review', '--scope', 'working-tree', 'extra'], {
      ANTIGRAVITY_SCRIPT_ROOT: tmpRoot,
    });
    assert.equal(res.status, 42, `stderr=${res.stderr} stdout=${res.stdout}`);
    const probe = JSON.parse(fs.readFileSync(probeMarker, 'utf8'));
    assert.deepEqual(probe.argv, ['--scope', 'working-tree', 'extra']);
    assert.equal(probe.host, 'standalone');
  });

  it('missing command module exits 2', () => {
    const res = run(['cancel'], { ANTIGRAVITY_SCRIPT_ROOT: tmpRoot });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /command module not found/);
  });

  it('per-command --help exits 0 without running command', () => {
    const res = run(['review', '--help'], { ANTIGRAVITY_SCRIPT_ROOT: tmpRoot });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /antigravity-plugin review/);
    // The stub was NOT invoked: probe marker should reflect the previous run only.
    // (We rely on dispatch test having already populated it; verify it wasn't
    // overwritten with a help-shaped payload.)
    const probe = JSON.parse(fs.readFileSync(probeMarker, 'utf8'));
    assert.deepEqual(probe.argv, ['--scope', 'working-tree', 'extra']);
  });
});
