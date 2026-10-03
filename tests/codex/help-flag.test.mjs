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
