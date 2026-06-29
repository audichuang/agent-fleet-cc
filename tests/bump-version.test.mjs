import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { bumpSemver, checkLockstep, setPluginVersion } from "../scripts/bump-version.mjs";

// E1: plugin versions are hand-edited across two files that MUST agree —
// plugins/<name>/.claude-plugin/plugin.json (version) and the per-plugin entry in
// .claude-plugin/marketplace.json (fleet-structure.test.mjs enforces the match). A
// bump/check tool keeps them in lockstep so a release never ships a half-bumped pair.

function makeFixtureRoot({ foo = "1.0.0", bar = "0.2.0", fooManifest = foo, barManifest = bar } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "agent-fleet",
        metadata: { version: "0.2.0" },
        plugins: [
          { name: "foo", source: "./plugins/foo", version: foo },
          { name: "bar", source: "./plugins/bar", version: bar }
        ]
      },
      null,
      2
    )}\n`
  );
  for (const [name, version] of [["foo", fooManifest], ["bar", barManifest]]) {
    const dir = path.join(root, "plugins", name, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), `${JSON.stringify({ name, version }, null, 2)}\n`);
  }
  return root;
}

const readManifest = (root, name) =>
  JSON.parse(fs.readFileSync(path.join(root, "plugins", name, ".claude-plugin", "plugin.json"), "utf8"));
const readMarketplaceEntry = (root, name) =>
  JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8")).plugins.find(
    (p) => p.name === name
  );

test("bumpSemver bumps patch / minor / major", () => {
  assert.equal(bumpSemver("1.0.0", "patch"), "1.0.1");
  assert.equal(bumpSemver("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpSemver("1.2.3", "major"), "2.0.0");
  assert.throws(() => bumpSemver("1.2", "patch"), /semver/i, "rejects non x.y.z versions");
  assert.throws(() => bumpSemver("1.2.3", "nope"), /patch|minor|major/i, "rejects unknown level");
  assert.throws(() => bumpSemver("01.0.0", "patch"), /semver/i, "rejects leading zeros");
  assert.equal(bumpSemver("0.4.1", "patch"), "0.4.2", "a legitimate 0 component is fine");
});

test("checkLockstep passes when every plugin's manifest matches its marketplace entry", () => {
  const root = makeFixtureRoot();
  const result = checkLockstep(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test("checkLockstep reports a plugin whose manifest and marketplace versions disagree", () => {
  const root = makeFixtureRoot({ foo: "1.0.1", fooManifest: "1.0.0" }); // marketplace ahead of manifest
  const result = checkLockstep(root);
  assert.equal(result.ok, false);
  const drift = result.mismatches.find((m) => m.name === "foo");
  assert.ok(drift, "foo flagged");
  assert.equal(drift.marketplace, "1.0.1");
  assert.equal(drift.manifest, "1.0.0");
});

test("setPluginVersion writes BOTH files in lockstep", () => {
  const root = makeFixtureRoot();
  const change = setPluginVersion(root, "foo", "1.2.3");
  assert.deepEqual(change, { name: "foo", from: "1.0.0", to: "1.2.3" });
  assert.equal(readManifest(root, "foo").version, "1.2.3");
  assert.equal(readMarketplaceEntry(root, "foo").version, "1.2.3");
  // the OTHER plugin is untouched
  assert.equal(readMarketplaceEntry(root, "bar").version, "0.2.0");
  assert.equal(checkLockstep(root).ok, true);
});

test("setPluginVersion rejects an unknown plugin and an invalid version", () => {
  const root = makeFixtureRoot();
  assert.throws(() => setPluginVersion(root, "ghost", "1.0.0"), /unknown plugin|not found/i);
  assert.throws(() => setPluginVersion(root, "foo", "abc"), /semver|version/i);
});