/**
 * Tests for runAsMain — the shared shim that makes a command module execute
 * its run() when invoked directly as a script (the slash-command `.md` path
 * runs `node scripts/commands/<verb>.mjs $ARGUMENTS`). Exporting run() alone is
 * not enough; without this the slash command would be a silent no-op.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = pathToFileURL(path.resolve(__dirname, '../../plugins/antigravity/scripts/lib/cli-entry.mjs')).href;

describe('runAsMain', () => {
  it('invokes run() with argv + ctx and exits with the returned code when run as main', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-entry-'));
    const marker = path.join(dir, 'marker.json');
    const fixture = path.join(dir, 'fixture.mjs');
    fs.writeFileSync(
      fixture,
      `import { runAsMain } from ${JSON.stringify(LIB)};\n` +
        `import fs from 'node:fs';\n` +
        `async function run(argv, ctx) {\n` +
        `  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv, host: ctx.host, cwd: ctx.cwd }));\n` +
        `  return 7;\n` +
        `}\n` +
        `runAsMain(import.meta.url, run, 'fixture');\n`,
    );
    const res = spawnSync(process.execPath, [fixture, 'a', 'b'], { encoding: 'utf8' });
    assert.equal(res.status, 7, `stderr=${res.stderr}`);
    const probe = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.deepEqual(probe.argv, ['a', 'b']);
    assert.equal(probe.host, 'claude-code');
    assert.equal(typeof probe.cwd, 'string');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 and prints a namespaced error when run() rejects', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-entry-'));
    const fixture = path.join(dir, 'boom.mjs');
    fs.writeFileSync(
      fixture,
      `import { runAsMain } from ${JSON.stringify(LIB)};\n` +
        `async function run() { throw new Error('kaboom'); }\n` +
        `runAsMain(import.meta.url, run, 'boom');\n`,
    );
    const res = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /antigravity:boom — kaboom/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not invoke anything on mere import', async () => {
    const mod = await import('../../plugins/antigravity/scripts/lib/cli-entry.mjs');
    assert.equal(typeof mod.runAsMain, 'function');
  });
});
