import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

// The old execute-plan command told the host to wait with Monitor. Monitor's
// timeout_ms defaults to five minutes and the wait dies while a succeeded job
// stays silent. That command is gone. The skill is now the only place that
// tells the host how to background a Codex run, so the pin lives here.
test("the skill backgrounds through the companion's own --background flag", () => {
  const skill = read("skills/codex/SKILL.md");
  assert.match(skill, /companion's own `--background`/);
  assert.match(skill, /ten minutes/i);
  assert.match(skill, /SIGTERM/);
  assert.match(skill, /tracked job/i);
  if (/Monitor/.test(skill)) {
    assert.match(skill, /persistent:\s*true/);
  }
});

test("status still documents the liveness watchdog for operators reading the companion", () => {
  const source = read("scripts/codex-companion.mjs");
  assert.match(source, /watchdog/i);
});
