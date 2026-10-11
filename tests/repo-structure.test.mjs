import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", ".generated"]);

function findSkillFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.endsWith("-workspace")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findSkillFiles(full, out);
    else if (e.name === "SKILL.md") out.push(path.relative(ROOT, full));
  }
  return out;
}

function skillName(rel) {
  const fm = fs.readFileSync(path.join(ROOT, rel), "utf8").match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, `${rel}: SKILL.md must open with YAML frontmatter`);
  return fm[1].match(/^name:\s*(\S+)\s*$/m)?.[1];
}

// Skill installers (aghub, npx skills) scan every depth for SKILL.md. A second file with a
// shipped skill's name gets installed over the real one, so the shipped set is pinned here.
test("the shipped skills are exactly skills/codex and skills/imagine", () => {
  const shipped = findSkillFiles(ROOT).filter((rel) => !rel.startsWith(`.claude${path.sep}`));
  assert.deepEqual(shipped.sort(), [path.join("skills", "codex", "SKILL.md"), path.join("skills", "imagine", "SKILL.md")]);
  for (const rel of shipped) {
    assert.equal(skillName(rel), path.basename(path.dirname(rel)), `${rel}: name must match its directory`);
  }
});

test("repo-only skills under .claude/skills never reuse a shipped skill's name", () => {
  const repoOnly = findSkillFiles(path.join(ROOT, ".claude")).map(skillName);
  for (const name of repoOnly) {
    assert.ok(!["codex", "imagine"].includes(name), `.claude/skills/${name} shadows a shipped skill`);
  }
});

test("no agent context file ships inside a skill directory", () => {
  // Installers copy the whole directory; an AGENTS.md / CLAUDE.md there loads into the user's
  // session when the host opens a file under it. Developer notes live in docs/<skill>-dev.md.
  for (const skill of ["codex", "imagine"]) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      assert.ok(!fs.existsSync(path.join(ROOT, "skills", skill, name)), `skills/${skill}/${name} must not ship`);
    }
  }
});

test("no plugin marketplace scaffolding comes back", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, ".claude-plugin")), "the repo ships skills, not a plugin marketplace");
  assert.ok(!fs.existsSync(path.join(ROOT, "plugins")), "skills live under skills/, not plugins/");
});
