import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/grok");

test("plugin exposes the seven fleet commands", () => {
  const cmds = fs.readdirSync(path.join(ROOT, "commands")).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(cmds, ["cancel.md", "logs.md", "result.md", "setup.md", "status.md", "task.md", "wait.md"]);
});

test("every command shells the grok companion", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "commands"))) {
    const body = fs.readFileSync(path.join(ROOT, "commands", f), "utf8");
    assert.match(body, /scripts\/grok-companion\.mjs/, `${f} must invoke the companion`);
  }
});

test("only task is model-invocable; lifecycle/query verbs are user-run", () => {
  // The delegation-entry verb (task) stays model-invocable so the commander can
  // reach for grok itself; the lifecycle/query verbs are gated to user-run so the
  // model cannot auto-fire them (matches codex/antigravity). The watch loop still
  // drives wait/status by shelling the companion, which the flag does not block.
  const gated = ["cancel", "logs", "result", "setup", "status", "wait"];
  const frontmatter = (name) => {
    const body = fs.readFileSync(path.join(ROOT, "commands", `${name}.md`), "utf8");
    const m = body.match(/^---\n([\s\S]*?)\n---/);
    return m ? m[1] : "";
  };
  for (const name of gated) {
    assert.match(
      frontmatter(name),
      /^disable-model-invocation:\s*true\s*$/m,
      `${name} must be user-run (disable-model-invocation: true)`,
    );
  }
  assert.doesNotMatch(
    frontmatter("task"),
    /disable-model-invocation/,
    "task must stay model-invocable",
  );
});

test("bin launcher is executable", () => {
  const st = fs.statSync(path.join(ROOT, "bin", "grok-companion"));
  assert.ok(st.mode & 0o111, "bin/grok-companion must be executable");
});
