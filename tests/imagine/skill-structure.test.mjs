import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../skills/imagine");

const SKILL = path.join(ROOT, "SKILL.md");
const REFS = path.join(ROOT, "references");

// The body after the frontmatter, so a description cannot satisfy a body assertion.
function skillBody() {
  return fs.readFileSync(SKILL, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
}

test("one skill is the whole surface — no slash command, no plugin manifest", () => {
  for (const dir of ["skills", "commands", ".claude-plugin"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, dir)), `imagine/${dir} must not come back`);
  }
});

test("the skill is model-invocable — the commander must be able to reach it on its own", () => {
  const fm = fs.readFileSync(SKILL, "utf8").match(/^---\n([\s\S]*?)\n---/)[1];
  assert.doesNotMatch(fm, /disable-model-invocation:\s*true/);
});

test("SKILL.md stays short and every reference it links exists, and vice versa", () => {
  const body = skillBody();
  assert.ok(body.split("\n").length <= 80, "the body loads on every use; detail belongs in references/");
  const linked = [...body.matchAll(/\]\(references\/([\w.-]+\.md)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(linked)].sort(), fs.readdirSync(REFS).sort());
});

test("the skill launches the script from CLAUDE_SKILL_DIR, never a hardcoded install path", () => {
  const body = skillBody();
  const launch = body.split("\n").find((l) => /imagine\.mjs/.test(l) && /--prompt-file/.test(l));
  assert.ok(launch, "SKILL.md must show the actual launch command");
  assert.match(launch, /\$\{CLAUDE_SKILL_DIR\}\/scripts\/imagine\.mjs/);
  assert.doesNotMatch(launch, /cache\//, "the launch command must not hardcode a versioned cache path");
});

test("the command carries the prompt in a file, never through the shell", () => {
  // A quoted heredoc looks safe and is not: a prompt whose own text contains the delimiter
  // line closes the here-document, and the rest of the prompt runs as shell. The prompt is
  // model- and user-authored text, so it must never reach a command line.
  //
  // Three unambiguous invariants, deliberately NOT a shell parser. An earlier version of
  // this test classified each line inside a fence as command-or-prose; it rejected
  // legitimate `export`/`curl`/loop blocks and still missed heredoc spellings it had not
  // thought of. A guard that has to guess at shell syntax is a guard you cannot trust.
  const docs = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) docs.push(full);
    }
  })(ROOT);
  assert.ok(docs.length >= 5, `expected the skill's shipped docs, found ${docs.length}`);

  let invocations = 0;
  for (const file of docs) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    // Fences are matched by their own run of backticks or tildes, so a four-backtick or
    // `~~~` fence counts. Everything below is checked INSIDE fences only: prose that
    // discusses the rule legitimately contains the operator, and a guard that fires on its
    // own documentation is a false positive — the failure direction that makes a guard
    // untrustworthy (this one bit this very file first time out).
    for (const [, , , block] of text.matchAll(/^([`~]{3,})(\w*)\n([\s\S]*?)^\1\s*$/gm)) {
      // 1. No heredoc, in any spelling. The bare `<<` operator is the whole check — there is
      //    no delimiter grammar to get wrong, and no command here has another use for it.
      assert.doesNotMatch(block, /<</, `${rel}: a code block must not use a heredoc (<<) — the prompt goes in a file:\n${block}`);
      // 2. Every shown invocation names --prompt-file and carries no prompt text.
      if (!/imagine\.mjs/.test(block)) continue;
      invocations++;
      assert.match(block, /--prompt-file/, `${rel}: every shown invocation must use --prompt-file:\n${block}`);
      assert.doesNotMatch(block, /<the |<prompt|\$ARGUMENTS/, `${rel}: no prompt text may reach a command line:\n${block}`);
    }
  }
  assert.ok(invocations >= 9, `expected the skill's launch plus the eight worked examples, saw ${invocations}`);
});

test("each worked example keeps its prompt in its own text fence, not in the shell fence", () => {
  // The pasteable hazard this pins: an example once held the command AND the prompt body in
  // one ```bash fence, where only the `# prompt.txt:` marker was a comment — pasted whole,
  // the prose ran as a command. Pairing the counts catches a body drifting back in without
  // any guessing about what a shell line looks like.
  const ex = fs.readFileSync(path.join(REFS, "examples.md"), "utf8");
  const count = (re) => [...ex.matchAll(re)].length;
  const prompts = count(/^```text$/gm);
  const commands = count(/^```bash$/gm);
  assert.equal(prompts, commands, `every example is one prompt fence + one command fence; saw ${prompts} vs ${commands}`);
  assert.ok(commands >= 8, `expected the eight worked examples, saw ${commands}`);
});

test("the skill sends the agent to the prompt recipe before spending quota", () => {
  // No heading grammar to get wrong: the recipe must be named before the script is first
  // launched. The reference table below the launch cannot stand in for it.
  const body = skillBody();
  const recipe = body.indexOf("references/prompt-craft.md");
  const launch = body.indexOf("imagine.mjs"); // any spelling of the path, e.g. scripts/./imagine.mjs
  assert.ok(launch > 0, "SKILL.md must show the launch command");
  assert.ok(recipe >= 0 && recipe < launch, "prompt-craft.md must be named before the script is launched");
});

test("this skill does NOT vendor the shared runtime — it has no job lifecycle", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "scripts/lib/shared")), "imagine has no job lifecycle to share");
});

test("no enumerated runtime catalog in shipped prose — defer to the live authority", () => {
  // Root AGENTS.md: a written-down catalog reads authoritative and rots invisibly.
  // For aspect ratios the authority is the server itself — a bad value returns 422
  // listing every accepted variant, which beats any list we could hold. So the
  // skill must NOT hardcode the enum in its description, and must say who owns it.
  const fm = fs.readFileSync(SKILL, "utf8").match(/^---\n([\s\S]*?)\n---/)[1];
  assert.doesNotMatch(fm, /16:9|9:16|3:2|2:3/, "the aspect enum must not be frozen into the frontmatter");
  assert.match(skillBody(), /422/, "must name the server error that enumerates the legal ratios");
  const craft = fs.readFileSync(path.join(REFS, "prompt-craft.md"), "utf8");
  assert.match(craft, /image-generation-models/, "the prompt recipe must point at the live model catalog");
});

test("the model reference that DOES enumerate the catalog is date-anchored and self-invalidating", () => {
  // grok's shipped catalog rotted twice in 14 days. This file is allowed to compare models —
  // that comparison is the whole point of it — but only behind a date and a re-check recipe,
  // so a reader can tell how old it is and refresh it in one command.
  const ref = fs.readFileSync(path.join(REFS, "model-and-params.md"), "utf8");
  assert.match(ref, /\b20\d\d-\d\d-\d\d\b/, "must state the date it was read");
  assert.match(ref, /image-generation-models/, "must carry the free live-catalog re-check");
  assert.match(ref, /rot|authority/i, "must say out loud that it goes stale");
});

test("the skill declares the frontmatter Claude Code loads it by", () => {
  const skill = fs.readFileSync(SKILL, "utf8");
  const fm = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, "SKILL.md must open with YAML frontmatter");
  assert.match(fm[1], /^name:\s*imagine\s*$/m);
  assert.match(fm[1], /^description:\s*\S/m, "description is what decides whether the skill fires");
});
