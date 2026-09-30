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

test("slash commands are gone; the skill is how the host calls Codex", () => {
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "commands")), false, "plugins/codex/commands must not come back");

  const skill = read("skills/codex/SKILL.md");
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
  const skill = read("skills/codex/SKILL.md");
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
  const promptingSkill = read("skills/codex/references/prompting.md");
  const agent = read("agents/codex-rescue.md");

  assert.match(promptingSkill, /\|\s*\*\*gpt-6\.1-sol\*\*\s*\|/);
  assert.match(promptingSkill, /\|\s*\*\*gpt-6-astra\*\*\s*\|/);
  assert.doesNotMatch(promptingSkill, /\|\s*\*\*gpt-6-luna\*\*\s*\|/);
  assert.doesNotMatch(promptingSkill, /\|\s*\*\*gpt-6-sol\*\*\s*\|/);
  assert.match(promptingSkill, /Do not pass `--model gpt-6-sol` or `--model gpt-6-luna`/);
  assert.match(promptingSkill, /does not retry on a weaker slug/);
  assert.match(promptingSkill, /no Fast path/);
  assert.doesNotMatch(promptingSkill, /\$\d[\d.]*\s*\/\s*\$\d/);
  assert.match(promptingSkill, /route by which job it is, not by price/i);

  assert.doesNotMatch(agent, /--model gpt-6-luna --effort max/);
  assert.doesNotMatch(agent, /Ticket lane/);
  assert.match(agent, /Never choose `gpt-6-sol` or `gpt-6-luna`/);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/);
  assert.match(agent, /Leave model unset by default/);
  assert.doesNotMatch(agent, /spark/i);
});

test("delivery-path reference is reachable and the host runs the companion", () => {
  const promptingSkill = read("skills/codex/references/prompting.md");
  const deliveryPaths = read("skills/codex/references/delivery-paths.md");

  assert.match(promptingSkill, /\(delivery-paths\.md\)/);
  assert.match(deliveryPaths, /`--resume-last`/);
  assert.match(deliveryPaths, /subagent_tokens: 20732/);
  assert.match(deliveryPaths, /context: fork/);
  assert.match(deliveryPaths, /no `Agent` tool/i);
  assert.match(deliveryPaths, /There is no `\/codex:\*` slash command/);
  assert.match(deliveryPaths, /The host runs the companion/);
});

test("internal docs use task terminology for rescue runs", () => {
  const agent = read("agents/codex-rescue.md");
  const promptingSkill = read("skills/codex/references/prompting.md");
  const promptRecipes = read("skills/codex/references/codex-prompt-recipes.md");

  assert.match(agent, /codex-companion\.mjs" task \.\.\./);
  assert.match(agent, /This subagent only forwards to `task`/i);
  assert.match(agent, /--resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
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

test("the rescue agent names the ten-minute ceiling and where the record can be read", () => {
  const agent = read("agents/codex-rescue.md");
  assert.match(agent, /ten minutes/i);
  assert.match(agent, /SIGTERM/);
  assert.match(agent, /status <jobId>/);
  assert.match(agent, /no stdout at all AND the call was not killed by a timeout/i);
  assert.doesNotMatch(agent, /^context:\s*fork\b/m);
});

test("codex-rescue keeps a quoted description and the forwarding contract", () => {
  const agent = read("agents/codex-rescue.md");
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(agent);
  assert.ok(parts, "agents/codex-rescue.md has no frontmatter");
  const [, frontmatter, body] = parts;

  const description = /^description: (.+)$/m.exec(frontmatter);
  assert.ok(description, "agents/codex-rescue.md has no description");
  assert.match(description[1], /^".*"$/);

  assert.match(body, /`codex:codex` skill/);
  assert.match(body, /thin forwarding wrapper/i);
  assert.match(body, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(body, /one `task` run per rescue handoff/i);
  assert.match(body, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(body, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/);
  assert.match(body, /Pass any explicit `--model` value through verbatim/);
  assert.match(body, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/);
  assert.match(body, /Return the stdout of the `codex-companion` command exactly as-is/);
  assert.match(body, /On failure the companion exits non-zero and prints a structured.*envelope on stdout\. Return that stdout as-is/i);
  assert.match(body, /references\/prompting\.md/);
  assert.match(body, /to tighten the user's request into a better Codex prompt/);
  assert.match(body, /Do not use that reference to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/);
  assert.match(body, /Never hardcode a cache\/versioned path/i);
  assert.match(body, /pass `--prompt-file <path>`/i);
  assert.match(body, /Treat `--background` and `--wait` as Claude-side execution control only/);
  assert.match(body, /Strip them before calling `task`/);
  assert.match(body, /Treat a user-typed `--write` as a runtime control/i);
  assert.match(body, /--resume/);
  assert.match(body, /--fresh/);
});

test("codex ships exactly one skill, whose references are all one hop from SKILL.md", () => {
  const skillsDir = path.join(PLUGIN_ROOT, "skills");
  const skills = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(skills, ["codex"], "codex is meant to expose exactly one skill");

  // codex-rescue preloads this file in full. Prompting detail stays in references.
  const body = read("skills/codex/SKILL.md");
  assert.ok(body.split("\n").length < 80, "skills/codex/SKILL.md is preloaded by codex-rescue — keep detail in references/");

  const linked = [...body.matchAll(/\]\(references\/([^)]+)\)/g)].map((m) => m[1]).sort();
  const onDisk = fs.readdirSync(path.join(skillsDir, "codex", "references")).sort();
  assert.deepEqual(linked, onDisk, "SKILL.md's reference table must match references/ exactly");
});

test("every markdown link in the skill resolves from the file that contains it", () => {
  const skillDir = path.join(PLUGIN_ROOT, "skills", "codex");
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
