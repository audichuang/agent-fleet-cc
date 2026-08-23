import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/imagine");

test("plugin manifest matches the directory it ships from", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.name, "imagine");
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test("image is model-invocable — the commander must be able to reach it", () => {
  const body = fs.readFileSync(path.join(ROOT, "commands/image.md"), "utf8");
  assert.doesNotMatch(body, /disable-model-invocation/);
});

test("the command launches the script from CLAUDE_PLUGIN_ROOT, never a cache path", () => {
  const body = fs.readFileSync(path.join(ROOT, "commands/image.md"), "utf8");
  const launch = body.split("\n").find((l) => /imagine\.mjs/.test(l) && /--prompt-file/.test(l));
  assert.ok(launch, "image.md must show the actual launch command");
  assert.match(launch, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/imagine\.mjs/);
  assert.doesNotMatch(launch, /cache\//, "the launch command must not hardcode a versioned cache path");
});

test("the command carries the prompt in a file, never through the shell", () => {
  // A quoted heredoc looks safe and is not: a prompt whose own text contains the
  // delimiter line closes the here-document, and the rest of the prompt runs as shell.
  // The prompt is model- and user-authored text, so it must never reach a command line.
  //
  // The lock walks EVERY shipped .md and checks whole fenced blocks, not single lines.
  // The earlier same-line version had two holes a mutation found: a wrapped invocation
  // slipped through, and a doc added later was simply not in the hardcoded list.
  const docs = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) docs.push(full);
    }
  })(ROOT);
  assert.ok(docs.length >= 5, `expected the plugin's shipped docs, found ${docs.length}`);

  let invocations = 0;
  for (const file of docs) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /<<\s*'?[A-Za-z_][A-Za-z0-9_]*'?\s*$/m, `${rel} must not carry the prompt in a heredoc`);
    // whole fenced blocks: a command wrapped over several lines is still one block
    for (const [, lang, block] of text.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
      if (!/imagine\.mjs/.test(block)) continue;
      assert.match(lang, /^(bash|sh|shell|console|typescript)?$/, `${rel}: unexpected fence language ${lang}`);
      invocations++;
      assert.match(block, /--prompt-file/, `${rel}: every shown invocation must use --prompt-file:\n${block}`);
      assert.doesNotMatch(block, /<the |<prompt|\$ARGUMENTS/, `${rel}: no prompt text may reach a command line:\n${block}`);
      // the prompt body must not sit in a shell fence at all — pasted whole, an
      // uncommented prose line is a command. It belongs in its own text fence.
      if (/^(bash|sh|shell|console)$/.test(lang)) {
        for (const line of block.split("\n")) {
          const t = line.trim();
          if (!t || t.startsWith("#") || /^(node|d=|\$)/.test(t) || t.endsWith("\\")) continue;
          assert.fail(`${rel}: a shell fence must hold only the command; found prose: ${t.slice(0, 60)}`);
        }
      }
    }
  }
  assert.ok(invocations >= 9, `expected the command plus the eight worked examples, saw ${invocations}`);
});

test("the command sends the user to the prompt skill before spending quota", () => {
  const body = fs.readFileSync(path.join(ROOT, "commands/image.md"), "utf8");
  assert.match(body, /skills\/imagine-prompts\/SKILL\.md/);
  assert.ok(fs.existsSync(path.join(ROOT, "skills/imagine-prompts/SKILL.md")), "the skill it points at must exist");
});

test("this plugin does NOT vendor the shared runtime — it has no job lifecycle", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "scripts/lib/shared")), "imagine must stay out of sync-shared's target list");
});

test("no enumerated runtime catalog in shipped prose — defer to the live authority", () => {
  // Root AGENTS.md: a written-down catalog reads authoritative and rots invisibly.
  // For aspect ratios the authority is the server itself — a bad value returns 422
  // listing every accepted variant, which beats any list we could hold. So the
  // command must NOT hardcode the enum in its argument-hint, and must say who owns it.
  const body = fs.readFileSync(path.join(ROOT, "commands/image.md"), "utf8");
  const hint = body.match(/^argument-hint:.*$/m)?.[0] ?? "";
  assert.doesNotMatch(hint, /16:9|9:16|3:2|2:3/, "the aspect enum must not be frozen into the hint");
  assert.match(body, /422/, "must name the server error that enumerates the legal ratios");
  const skill = fs.readFileSync(path.join(ROOT, "skills/imagine-prompts/SKILL.md"), "utf8");
  assert.match(skill, /image-generation-models/, "the skill must point at the live model catalog");
});

test("the model reference that DOES enumerate the catalog is date-anchored and self-invalidating", () => {
  // grok's shipped catalog rotted twice in 14 days. This file is allowed to compare models —
  // that comparison is the whole point of it — but only behind a date and a re-check recipe,
  // so a reader can tell how old it is and refresh it in one command.
  const ref = fs.readFileSync(path.join(ROOT, "skills/imagine-prompts/references/model-and-params.md"), "utf8");
  assert.match(ref, /\b20\d\d-\d\d-\d\d\b/, "must state the date it was read");
  assert.match(ref, /image-generation-models/, "must carry the free live-catalog re-check");
  assert.match(ref, /rot|authority/i, "must say out loud that it goes stale");
});

test("the skill declares the frontmatter Claude Code loads it by", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/imagine-prompts/SKILL.md"), "utf8");
  const fm = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, "SKILL.md must open with YAML frontmatter");
  assert.match(fm[1], /^name:\s*imagine-prompts\s*$/m);
  assert.match(fm[1], /^description:\s*\S/m, "description is what decides whether the skill fires");
});
