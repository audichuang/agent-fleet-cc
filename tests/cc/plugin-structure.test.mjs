import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMMANDS = ["task", "status", "result", "cancel", "setup", "wait", "logs"];
const COMMAND_FORWARDS = new Map(
  COMMANDS.map((name) => [
    name,
    `node "\${CLAUDE_PLUGIN_ROOT}/scripts/cc-companion.mjs" ${name}${
      name === "setup" ? "" : " $ARGUMENTS"
    }`,
  ]),
);

test("every command md exists, has frontmatter, forwards to the companion", () => {
  for (const name of COMMANDS) {
    const file = path.join(REPO_ROOT, "plugins/cc/commands", `${name}.md`);
    assert.ok(fs.existsSync(file), `${name}.md missing`);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith("---"), `${name}.md missing frontmatter`);
    assert.match(text, /description:/);
    assert.match(text, /cc-companion\.mjs/);
    assert.ok(text.includes(COMMAND_FORWARDS.get(name)), `${name}.md wrong forward`);
  }
});

test("task documents the no-profile selection flow", () => {
  const text = fs.readFileSync(
    path.join(REPO_ROOT, "plugins/cc/commands", "task.md"),
    "utf8",
  );
  assert.match(text, /AskUserQuestion/, "task.md: missing profile picker");
  assert.match(text, /CC_DEFAULT_PROFILE/, "task.md: missing default hint");
  assert.match(
    text,
    /never re-run a failed job on a\s+different profile/i,
    "task.md: missing no-failover rule",
  );
});

test("task.md documents the machine-contract flags and drops execute-plan/--resume-id", () => {
  const text = fs.readFileSync(
    path.join(REPO_ROOT, "plugins/cc/commands", "task.md"),
    "utf8",
  );
  assert.match(text, /--prompt-file/, "task.md: missing --prompt-file flag");
  assert.match(text, /--json/, "task.md: missing --json flag");
  assert.match(text, /--resume-job/, "task.md: missing --resume-job flag");
  assert.match(text, /--read-only/, "task.md: missing --read-only flag");
  assert.ok(!text.includes("execute-plan"), "task.md: must not mention execute-plan");
  assert.ok(!text.includes("--resume-id"), "task.md: must not mention --resume-id");
});

test("marketplace entry and plugin.json agree for cc", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"),
  );
  const entry = marketplace.plugins.find((p) => p.name === "cc");
  assert.ok(entry, "cc missing from marketplace");
  assert.equal(entry.source, "./plugins/cc");
  const plugin = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "plugins/cc/.claude-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(plugin.name, "cc");
  assert.equal(entry.version, plugin.version);

  // Phase 2: cc 是雙宿主 plugin —— .codex-plugin 必須存在且三方 name/version 一致
  const codexManifest = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "plugins/cc/.codex-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(codexManifest.name, "cc", ".codex-plugin name must be cc");
  assert.equal(
    codexManifest.version,
    plugin.version,
    ".codex-plugin version must match .claude-plugin",
  );
  assert.equal(
    codexManifest.skills,
    "./skills/",
    ".codex-plugin must declare skills: ./skills/",
  );
});
