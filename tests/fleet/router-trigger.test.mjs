// tests/fleet/router-trigger.test.mjs
// Guards the delegating-to-fleet trigger-validation corpus (ticket 06) and the
// sharpened router description. The empirical A/B (does the skill actually fire?)
// is a model eval the maintainer runs with this corpus — see meta.scoring; it
// cannot run inside `node --test`. These tests lock the fixture's shape and the
// description invariants the A/B depends on.
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "tests/fleet/fixtures/router-trigger-corpus.json"), "utf8"),
);
const SKILL = fs.readFileSync(
  path.join(REPO_ROOT, "plugins/fleet/skills/delegating-to-fleet/SKILL.md"),
  "utf8",
);
const description = (SKILL.match(/^description:\s*(.+)$/m) ?? [, ""])[1];

test("corpus is 20 prompts: 12 should-delegate, 8 should-not", () => {
  assert.equal(CORPUS.prompts.length, 20);
  const del = CORPUS.prompts.filter((p) => p.shouldDelegate);
  const not = CORPUS.prompts.filter((p) => !p.shouldDelegate);
  assert.equal(del.length, 12);
  assert.equal(not.length, 8);
});

test("every should-delegate prompt names a valid expectedEngine; every prompt is non-empty with a unique id", () => {
  const engines = new Set(CORPUS.meta.engines);
  const ids = new Set();
  for (const p of CORPUS.prompts) {
    assert.ok(p.prompt && p.prompt.trim().length > 0, `${p.id} needs a prompt`);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    if (p.shouldDelegate) {
      assert.ok(engines.has(p.expectedEngine), `${p.id} expectedEngine invalid: ${p.expectedEngine}`);
      const verbs = CORPUS.meta.verbsByEngine[p.expectedEngine];
      assert.ok(
        verbs.includes(p.expectedVerb),
        `${p.id} expectedVerb "${p.expectedVerb}" not a valid ${p.expectedEngine} entry verb`,
      );
    } else {
      assert.ok(!("expectedEngine" in p), `${p.id} is should-NOT and must not name an engine`);
    }
  }
});

test("corpus locks concrete thresholds (no placeholders)", () => {
  assert.equal(CORPUS.meta.reps, 3);
  assert.equal(CORPUS.meta.passDelegateHitRate, 0.9);
  assert.equal(CORPUS.meta.maxFalseFireRate, 0.1);
  assert.ok(CORPUS.meta.scoring && CORPUS.meta.scoring.length > 40);
});

test("router description fires on the delegation DECISION, not just a verb, and carries concrete cues", () => {
  assert.match(description, /decid/i); // "deciding whether to hand..."
  assert.match(description, /DECISION/); // explicit: fire on the decision itself
  assert.match(description, /before reaching for any engine's verb/i);
  // concrete trigger cues that reduce under-triggering
  assert.match(description, /delegate/i);
  assert.match(description, /hand off|hand a task/i);
  assert.match(description, /second opinion|independent review/i);
  assert.match(description, /parallel/i);
});
