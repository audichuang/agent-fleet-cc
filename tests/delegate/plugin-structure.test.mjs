import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMMANDS = ["task", "status", "result", "cancel", "setup"];

test("every command md exists, has frontmatter, forwards to the companion", () => {
  for (const name of COMMANDS) {
    const file = path.join(REPO_ROOT, "plugins/delegate/commands", `${name}.md`);
    assert.ok(fs.existsSync(file), `${name}.md missing`);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith("---"), `${name}.md missing frontmatter`);
    assert.match(text, /description:/);
    assert.match(text, /delegate-companion\.mjs/);
  }
});

test("task documents the no-profile selection flow", () => {
  const text = fs.readFileSync(
    path.join(REPO_ROOT, "plugins/delegate/commands", "task.md"),
    "utf8",
  );
  assert.match(text, /AskUserQuestion/, "task.md: missing profile picker");
  assert.match(text, /DELEGATE_DEFAULT_PROFILE/, "task.md: missing default hint");
  assert.match(
    text,
    /never re-run a failed job on a\s+different profile/i,
    "task.md: missing no-failover rule",
  );
});

test("marketplace entry and plugin.json agree for delegate", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"),
  );
  const entry = marketplace.plugins.find((p) => p.name === "delegate");
  assert.ok(entry, "delegate missing from marketplace");
  assert.equal(entry.source, "./plugins/delegate");
  const plugin = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "plugins/delegate/.claude-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(plugin.name, "delegate");
  assert.equal(entry.version, plugin.version);
});
