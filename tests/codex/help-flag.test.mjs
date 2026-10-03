import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/codex/scripts/codex-companion.mjs");

// `adversarial-review --help` used to take "--help" as focus text and launch a real
// review (and `task --help` a real task). With PATH emptied, a verb that tried to run
// would fail on the missing codex binary instead of printing usage.
for (const argv of [["adversarial-review", "--help"], ["task", "--help"], ["review", "-h"], ["status", "--help"]]) {
  test(`${argv.join(" ")} prints usage and starts nothing`, () => {
    const result = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/);
    assert.doesNotMatch(result.stdout + result.stderr, /not installed|Starting|started in the background/);
  });
}

test("--help inside a quoted prompt is prompt text, not a help request", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "task", "why does foo --help crash"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.doesNotMatch(result.stdout, /^Usage:/);
});

// A help token that is data, not a request: after `--`, or the value of an option.
// With PATH emptied the run fails on the missing codex binary, which proves it ran.
for (const argv of [["task", "--fresh", "--", "--help"], ["task", "--prompt-file", "--help"], ["adversarial-review", "--base", "-h"]]) {
  test(`${argv.join(" ")} is data, not a help request`, () => {
    const result = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    assert.doesNotMatch(result.stdout, /^Usage:/);
  });
}

test("the help check knows every value option a verb declares", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const declared = new Set([...source.matchAll(/valueOptions: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((v) => v[1])));
  const known = new Set([...source.match(/const ALL_VALUE_OPTIONS = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((v) => v[1]));
  assert.deepEqual([...declared].filter((option) => !known.has(option)), []);
});
