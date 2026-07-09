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

test("bin launcher is executable", () => {
  const st = fs.statSync(path.join(ROOT, "bin", "grok-companion"));
  assert.ok(st.mode & 0o111, "bin/grok-companion must be executable");
});
