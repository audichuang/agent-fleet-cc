import test from "node:test";
import assert from "node:assert/strict";
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

// Judged with the verb's own options: task has no --base (so it is prompt text and
// --help is a request), and -C is task's alias for --cwd (so its value is data).
test("task --fresh --base --help is a help request: --base is not a task option", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "task", "--fresh", "--base", "--help"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/);
});

test("task -C --help names a cwd, not a help request", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "task", "-C", "--help", "--fresh", "hello"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.doesNotMatch(result.stdout, /^Usage:/);
});

// One raw string carries options and prompt together (normalizeArgv splits it).
// Review finding: these used to start a turn / run setup.
for (const raw of ["--fresh --help", "--json --help"]) {
  const verb = raw.startsWith("--json") ? "setup" : "task";
  test(`${verb} "${raw}" prints usage and changes nothing`, () => {
    const result = spawnSync(process.execPath, [SCRIPT, verb, raw], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/);
  });
}
