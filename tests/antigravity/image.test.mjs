/**
 * Tests for the /antigravity:image feature.
 *
 * Pure-logic units (extractImagePath, buildImagePrompt) are exercised directly;
 * no real `agy` binary is spawned. The command module's argv guard is driven
 * through its run() entry the same way the other commands.test.mjs cases are.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractImagePath } from '../../plugins/antigravity/scripts/lib/image.mjs';
import { buildImagePrompt } from '../../plugins/antigravity/scripts/lib/prompt-templates.mjs';

const IMAGE_MJS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../plugins/antigravity/scripts/commands/image.mjs',
);

describe('extractImagePath', () => {
  it('returns the path from an IMAGE_PATH: marker line', () => {
    const stdout = [
      'Sure, here is your image.',
      'IMAGE_PATH: /tmp/coffee_cup.png',
    ].join('\n');
    const result = extractImagePath(stdout);
    assert.equal(result.imagePath, '/tmp/coffee_cup.png');
    assert.equal(result.source, 'marker');
  });

  it('returns the LAST marker when several are present (agy echoes the prompt contract line)', () => {
    const stdout = [
      'IMAGE_PATH: <absolute filesystem path to the saved image>', // echoed from the prompt
      'Generating...',
      'IMAGE_PATH: /var/folders/xy/real_output.webp', // the real one
    ].join('\n');
    const result = extractImagePath(stdout);
    assert.equal(result.imagePath, '/var/folders/xy/real_output.webp');
    assert.equal(result.source, 'marker');
  });

  it('falls back to scraping the first image path when no marker is present', () => {
    const stdout = 'I saved it to /home/u/pics/sunset.jpeg for you. Enjoy!';
    const result = extractImagePath(stdout);
    assert.equal(result.imagePath, '/home/u/pics/sunset.jpeg');
    assert.equal(result.source, 'scrape');
  });

  it('returns null when the reply contains no recoverable image path', () => {
    const result = extractImagePath('I was unable to generate that image, sorry.');
    assert.equal(result.imagePath, null);
    assert.equal(result.source, null);
  });

  it('tolerates non-string input', () => {
    assert.equal(extractImagePath(undefined).imagePath, null);
    assert.equal(extractImagePath(null).imagePath, null);
  });
});

describe('buildImagePrompt', () => {
  it('instructs agy to use generate_image and emit the IMAGE_PATH contract', () => {
    const prompt = buildImagePrompt('a red bicycle in the rain');
    assert.match(prompt, /generate_image/);
    assert.match(prompt, /a red bicycle in the rain/);
    // The marker contract must be present verbatim so extractImagePath can find it.
    assert.match(prompt, /^IMAGE_PATH: /m);
  });

  it('adds a save-with-name clause when a name is given', () => {
    const prompt = buildImagePrompt('a logo', { name: 'brand_logo' });
    assert.match(prompt, /brand_logo/);
    assert.match(prompt, /name/i);
  });

  it('omits the name clause when no name is given', () => {
    const prompt = buildImagePrompt('a logo');
    assert.doesNotMatch(prompt, /Save the image with name/i);
  });
});

describe('/antigravity:image argv guard', () => {
  it('returns 1 with a friendly error when no description is given', async () => {
    const { run } = await import('../../plugins/antigravity/scripts/commands/image.mjs');
    const err = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
    let exit;
    try {
      exit = await run([], { cwd: process.cwd() });
    } finally {
      process.stderr.write = origErr;
    }
    assert.equal(exit, 1);
    assert.match(err.join(''), /antigravity:image/);
    assert.match(err.join(''), /description/i);
  });

  it('self-invokes run() when executed directly (the slash-command path)', () => {
    // The commands/image.md runs `node scripts/commands/image.mjs $ARGUMENTS`,
    // so the module MUST call run() when executed as the main script — not just
    // export it. With no description it should hit the guard and exit 1.
    const res = spawnSync(process.execPath, [IMAGE_MJS], { encoding: 'utf8' });
    assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /antigravity:image/);
    assert.match(res.stderr, /description/i);
  });
});
