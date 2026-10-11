import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_ROOT = path.join(ROOT, "skills", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("slash commands are gone; the skill is how the host calls Codex", () => {
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "commands")), false, "codex/commands must not come back");

  const skill = read("SKILL.md");
  assert.match(skill, /codex-companion\.mjs/);
  assert.match(skill, /`review`/);
  assert.match(skill, /`adversarial-review`/);
  assert.match(skill, /`task`/);
  assert.match(skill, /task --resume-last/);
  assert.match(skill, /Return the companion stdout verbatim/i);
  assert.match(skill, /Do not pass `gpt-6-sol` or `gpt-6-luna`/);
  assert.match(skill, /Do not pass a service tier/);
  assert.match(skill, /gpt-6-astra/);
  assert.match(skill, /imageGenerations\[\]\.savedPath/);
  assert.match(skill, /Images:/);
  assert.match(skill, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(skill, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
  assert.match(skill, /Auto-applying fixes from a review is strictly forbidden/i);
  assert.doesNotMatch(skill, /^context:\s*fork\b/m);
});

test("the skill backgrounds long runs on the companion and names the ten-minute ceiling", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /--background/);
  assert.match(skill, /ten minutes/i);
  assert.match(skill, /SIGTERM/);
  assert.match(skill, /run `status`/i);
  // A Monitor wait left at its five-minute default dies while the job succeeds.
  // The skill must not grow that recipe unless it also requires persistent: true.
  if (/Monitor/.test(skill)) {
    assert.match(skill, /persistent:\s*true/);
  }
});

test("app-server is spawned with image generation enabled", () => {
  const source = read("scripts/lib/app-server.mjs");
  assert.match(source, /spawn\("codex", \["app-server", "--enable", "image_generation"\]/);
});

test("model guidance keeps the workhorse and does not route to sol or luna", () => {
  const promptingSkill = read("references/prompting.md");

  assert.match(promptingSkill, /\|\s*\*\*gpt-6\.1-sol\*\*\s*\|/);
  assert.match(promptingSkill, /\|\s*\*\*gpt-6-astra\*\*\s*\|/);
  assert.doesNotMatch(promptingSkill, /\|\s*\*\*gpt-6-luna\*\*\s*\|/);
  assert.doesNotMatch(promptingSkill, /\|\s*\*\*gpt-6-sol\*\*\s*\|/);
  assert.match(promptingSkill, /Do not pass `--model gpt-6-sol` or `--model gpt-6-luna`/);
  assert.match(promptingSkill, /does not retry on a weaker slug/);
  assert.match(promptingSkill, /no Fast path/);
  assert.doesNotMatch(promptingSkill, /\$\d[\d.]*\s*\/\s*\$\d/);
  assert.match(promptingSkill, /route by which job it is, not by price/i);
});

test("delivery-path reference is reachable and the host runs the companion", () => {
  const promptingSkill = read("references/prompting.md");
  const deliveryPaths = read("references/delivery-paths.md");

  assert.match(promptingSkill, /\(delivery-paths\.md\)/);
  assert.match(deliveryPaths, /`--resume-last`/);
  assert.doesNotMatch(deliveryPaths, /codex:codex-rescue`? subagent \|/);
  assert.match(deliveryPaths, /context: fork/);
  assert.match(deliveryPaths, /no `Agent` tool/i);
  assert.match(deliveryPaths, /There is no `\/codex:\*` slash command/);
  assert.match(deliveryPaths, /The host runs the companion/);
});

test("internal docs use task terminology for delegated runs", () => {
  const promptingSkill = read("references/prompting.md");
  const promptRecipes = read("references/codex-prompt-recipes.md");

  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("the skill is the whole surface: no subagent, no hooks, no plugin manifest", () => {
  // Discovery is a directory scan, so any of these coming back is a mkdir; pin all of them.
  for (const dir of ["agents", "hooks", "commands", "skills", ".claude-plugin"]) {
    assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, dir)), false, `codex/${dir} must not come back`);
  }
});

test("status surfaces render the status report, not the stored result", () => {
  function companionHandler(name) {
    const companion = read("scripts/codex-companion.mjs");
    const signature = new RegExp(`^(?:async )?function ${name}\\(`, "m");
    const opening = signature.exec(companion);
    assert.ok(opening, `${name} not found in codex-companion.mjs`);
    const rest = companion.slice(opening.index + opening[0].length);
    const next = /^(?:async )?function \w+\(/m.exec(rest);
    return rest.slice(0, next ? next.index : undefined);
  }

  for (const name of ["handleWait", "handleStatus"]) {
    const body = companionHandler(name);
    assert.match(body, /renderJobStatusReport|renderStatusPayload/, `${name} no longer renders a status report`);
    assert.doesNotMatch(body, /renderStoredJobResult/, `${name} now renders the stored result`);
  }

  assert.match(companionHandler("handleResult"), /renderStoredJobResult/);
});

test("the skill's references are all one hop from SKILL.md", () => {
  // The whole SKILL.md loads every time the skill fires. Prompting detail stays in references.
  const body = read("SKILL.md");
  assert.ok(body.split("\n").length < 80, "SKILL.md loads in full on every trigger — keep detail in references/");

  const linked = [...body.matchAll(/\]\(references\/([^)]+)\)/g)].map((m) => m[1]).sort();
  const onDisk = fs.readdirSync(path.join(PLUGIN_ROOT, "references")).sort();
  assert.deepEqual(linked, onDisk, "SKILL.md's reference table must match references/ exactly");
});

test("every markdown link in the skill resolves from the file that contains it", () => {
  const skillDir = PLUGIN_ROOT;
  const files = [
    path.join(skillDir, "SKILL.md"),
    ...fs.readdirSync(path.join(skillDir, "references")).map((name) => path.join(skillDir, "references", name))
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\]\(([^)#][^)]*)\)/g)) {
      const target = match[1];
      if (/^https?:/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      assert.ok(fs.existsSync(resolved), `${path.relative(PLUGIN_ROOT, file)} links to missing ${target}`);
    }
  }
});

test("no script points the user at a /codex:* slash command (removed in 1.6.4)", () => {
  // Messages name the companion verb (`status`, `cancel <id>`); a slash command that
  // does not exist sends the user and the host after nothing.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) {
        fs.readFileSync(full, "utf8").split("\n").forEach((line, index) => {
          if (/\/codex:[a-z]/.test(line)) offenders.push(`${path.relative(PLUGIN_ROOT, full)}:${index + 1}`);
        });
      }
    }
  };
  walk(path.join(PLUGIN_ROOT, "scripts"));
  assert.deepEqual(offenders, []);
});
