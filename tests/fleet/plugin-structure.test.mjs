import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("fleet plugin.json has the minimal shape and agrees with the marketplace", () => {
  const plugin = readJson(
    path.join(REPO_ROOT, "plugins/fleet/.claude-plugin/plugin.json"),
  );
  assert.equal(plugin.name, "fleet");
  assert.equal(typeof plugin.version, "string");
  assert.ok(plugin.description && plugin.description.length > 0);

  const marketplace = readJson(
    path.join(REPO_ROOT, ".claude-plugin/marketplace.json"),
  );
  const entry = marketplace.plugins.find((p) => p.name === "fleet");
  assert.ok(entry, "fleet missing from marketplace");
  assert.equal(entry.source, "./plugins/fleet");
  assert.equal(entry.version, plugin.version);
});

test("fleet plugin ships setup.md and fleet-doctor.mjs", () => {
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, "plugins/fleet/commands/setup.md")),
    "setup.md missing",
  );
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, "plugins/fleet/scripts/fleet-doctor.mjs")),
    "fleet-doctor.mjs missing",
  );
});
