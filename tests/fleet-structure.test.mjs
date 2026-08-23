import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("marketplace is agent-fleet and every entry is consistent", () => {
  const marketplace = readJson(path.join(ROOT, ".claude-plugin/marketplace.json"));
  assert.equal(marketplace.name, "agent-fleet");
  for (const entry of marketplace.plugins) {
    const dir = path.join(ROOT, entry.source);
    assert.ok(fs.existsSync(dir), `${entry.name}: source dir missing`);
    const plugin = readJson(path.join(dir, ".claude-plugin/plugin.json"));
    assert.equal(plugin.name, entry.name, `${entry.name}: name mismatch`);
    assert.equal(plugin.version, entry.version, `${entry.name}: version mismatch`);
  }
});

test("marketplace lists exactly the engine plugins plus fleet", () => {
  const marketplace = readJson(path.join(ROOT, ".claude-plugin/marketplace.json"));
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name).sort(),
    ["antigravity", "cc", "codex", "fleet", "grok", "imagine"],
  );
});
