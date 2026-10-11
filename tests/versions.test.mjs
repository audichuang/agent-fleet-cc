import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A skill's version is metadata.version in its SKILL.md, and its CHANGELOG's newest heading must
// name the same version: a content change without a bump leaves every installed copy stale with
// nothing to show it.
for (const skill of ["codex", "imagine"]) {
  test(`${skill}: SKILL.md metadata.version matches the newest CHANGELOG entry`, () => {
    const fm = fs.readFileSync(path.join(ROOT, "skills", skill, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/)[1];
    const version = fm.match(/^metadata:\n(?:\s+.*\n)*?\s+version:\s*"?(\d+\.\d+\.\d+)"?\s*$/m)?.[1];
    assert.ok(version, `${skill}/SKILL.md needs metadata.version`);
    const newest = fs.readFileSync(path.join(ROOT, "skills", skill, "CHANGELOG.md"), "utf8").match(/^## (\d+\.\d+\.\d+)/m)?.[1];
    assert.equal(newest, version, `${skill}/CHANGELOG.md newest entry`);
  });
}
