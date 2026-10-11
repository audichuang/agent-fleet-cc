import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "skills", "codex", "scripts", "codex-companion.mjs");

// With PATH emptied a call that gets past option parsing fails on the missing codex binary,
// so "no `has no option`" proves the text was accepted as a prompt.
function runCompanion(argv) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8", env: { ...process.env, PATH: "" } });
}

// task and the review verbs read leftover positionals as text, so a typo used to become
// prompt text: `task --backnd desktop …` ran on the CLI, without computer use, exit 0.
for (const [argv, flag, guess] of [
  [["task", "--background", "--backnd", "desktop", "Reply OK"], "--backnd", "--backend"],
  [["task", "Reply OK", "--backnd", "desktop"], "--backnd", "--backend"],
  [["task", "--backnd desktop Reply OK"], "--backnd", "--backend"],
  [["adversarial-review", "--bse", "main", "focus on retries"], "--bse", "--base"],
  [["review", "--jsno"], "--jsno", "--json"],
  [["task", "---backend", "desktop", "Click the page"], "---backend", "--backend"]
]) {
  test(`${argv.join(" ")} names ${flag} instead of sending it as text`, () => {
    const result = runCompanion(argv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, new RegExp(`has no option \`${flag}\``));
    assert.match(result.stderr + result.stdout, new RegExp(`Did you mean \`${guess}\``));
  });
}

// A flag inside one quoted prompt, after prompt text, is text; so is anything after `--`.
for (const argv of [
  ["task", "why does foo --verbose crash"],
  ["task", "--fresh", "--", "--backnd", "is a typo in our docs"],
  ["adversarial-review", "check the --retry path"],
  ["task", "Explain how --prompt differs from trailing text"]
]) {
  test(`${argv.join(" ")} stays text`, () => {
    const result = runCompanion(argv);
    assert.doesNotMatch(result.stderr + result.stdout, /has no option/);
  });
}

// There is no `--prompt`; callers guess it (this repo's own tests did, while it fell through
// as prompt text), so it names --prompt-file.
test("task --prompt <text> names --prompt-file", () => {
  const result = runCompanion(["task", "--prompt", "Reply OK"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /has no option `--prompt`\. Did you mean `--prompt-file`/);
});
