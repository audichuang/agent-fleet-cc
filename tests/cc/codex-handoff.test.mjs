import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = path.join(REPO_ROOT, "plugins/cc/bin/cc-companion");

test("bin/cc-companion 存在、可執行、有 shebang、forward 到 cc-companion.mjs", () => {
  assert.ok(fs.existsSync(LAUNCHER), "bin/cc-companion missing");
  const text = fs.readFileSync(LAUNCHER, "utf8");
  assert.match(text, /^#!.*\b(bash|sh)\b/, "missing shebang");
  assert.match(text, /scripts\/cc-companion\.mjs/, "must exec the runtime");
  const mode = fs.statSync(LAUNCHER).mode;
  assert.ok(mode & 0o111, "launcher must be executable");
});

test("bin/cc-companion 無參數時 forward 到 runtime 並 exit 0（印 usage）", () => {
  const res = spawnSync(LAUNCHER, [], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: cc-companion/, "should print companion usage");
});

test("透過 symlink 入口呼叫 launcher 仍能 resolve 到 runtime（PATH 安裝多為 symlink）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symlink-"));
  const link = path.join(dir, "cc-companion");
  fs.symlinkSync(LAUNCHER, link);
  const res = spawnSync(link, [], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: cc-companion/, "symlinked launcher must resolve runtime");
  fs.rmSync(dir, { recursive: true, force: true });
});

const SKILL = path.join(REPO_ROOT, "plugins/cc/skills/cc-handoff/SKILL.md");

test("cc-handoff skill 存在、frontmatter 正確、含關鍵操作指令", () => {
  assert.ok(fs.existsSync(SKILL), "cc-handoff/SKILL.md missing");
  const text = fs.readFileSync(SKILL, "utf8");
  assert.ok(text.startsWith("---"), "missing frontmatter");
  const fm = text.slice(3, text.indexOf("---", 3));
  assert.match(fm, /name:\s*cc-handoff/, "name must be cc-handoff");
  assert.match(fm, /description:/, "missing description");
  // description 三要素關鍵字(spec §2 Q3 判據)
  assert.match(fm, /claude/i, "description must mention claude");
  assert.match(fm, /hand|delegate/i, "description must mention hand/delegate");
  assert.match(fm, /subtask|task/i, "description must mention subtask/task");
  // body 必含 spec v2 釘死的操作:CC_PLUGIN_DATA、PROJECT_ROOT、git status、--json、不自動外包
  assert.match(text, /CC_PLUGIN_DATA/, "body must set CC_PLUGIN_DATA (V-2)");
  assert.match(text, /git rev-parse --show-toplevel/, "body must pin PROJECT_ROOT (V-3)");
  assert.match(text, /git status --porcelain/, "body must list changed files (V-5)");
  assert.match(text, /--json/, "body must use --json");
  assert.match(text, /明確指派|explicit/i, "body must state explicit-assignment-only");
});
