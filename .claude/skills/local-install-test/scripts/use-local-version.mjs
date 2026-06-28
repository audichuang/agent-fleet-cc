#!/usr/bin/env node
// Repoint Claude Code's active install of an agent-fleet plugin at a freshly-built
// versioned cache — the "direct replace" step that is fiddly and easy to corrupt by
// hand. It refreshes the marketplace clone (so the target version's cache is
// materialized), verifies that cache exists, backs up installed_plugins.json, then
// updates the plugin's pin (installPath / version / gitCommitSha). Restart Claude
// Code afterwards to load it.
//
// Usage:
//   node use-local-version.mjs <plugin> [version] [--no-refresh] [--marketplace <name>]
//   node use-local-version.mjs codex            # version = whatever the marketplace clone offers
//   node use-local-version.mjs codex 1.0.19     # pin an explicit version
//
// Zero-dependency, pure ESM. Edits only ~/.claude/plugins/installed_plugins.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const out = { positionals: [], refresh: true, marketplace: "agent-fleet" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--no-refresh") out.refresh = false;
    else if (a === "--marketplace") out.marketplace = argv[++i];
    else out.positionals.push(a);
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
}

const { positionals, refresh, marketplace } = parseArgs(process.argv.slice(2));
const plugin = positionals[0];
let version = positionals[1] ?? null;
if (!plugin) {
  fail("usage: use-local-version.mjs <plugin> [version] [--no-refresh] [--marketplace <name>]");
}

const home = os.homedir();
const pluginsDir = path.join(home, ".claude", "plugins");
const cloneDir = path.join(pluginsDir, "marketplaces", marketplace);
const cacheRoot = path.join(pluginsDir, "cache", marketplace, plugin);
const installedFile = path.join(pluginsDir, "installed_plugins.json");
const pinKey = `${plugin}@${marketplace}`;

if (!fs.existsSync(cloneDir)) {
  fail(`marketplace clone not found: ${cloneDir} (is the '${marketplace}' marketplace added?)`);
}

// 1) Refresh the marketplace so the target version's cache is materialized. Best
//    effort: if the `claude` CLI isn't on PATH, the user may have refreshed already.
if (refresh) {
  try {
    process.stdout.write(`• refreshing marketplace '${marketplace}'…\n`);
    execFileSync("claude", ["plugin", "marketplace", "update", marketplace], { stdio: "inherit" });
  } catch {
    process.stderr.write(
      `! could not run 'claude plugin marketplace update ${marketplace}' — continuing; ` +
      `pass --no-refresh if you already refreshed.\n`
    );
  }
}

// 2) Resolve the target version. Default to whatever the refreshed clone offers for
//    this plugin (its marketplace.json entry), so "use-local-version codex" just works.
if (!version) {
  try {
    const mkt = JSON.parse(fs.readFileSync(path.join(cloneDir, ".claude-plugin", "marketplace.json"), "utf8"));
    const entry = (mkt.plugins ?? []).find((p) => p.name === plugin);
    version = entry?.version ?? null;
  } catch {
    /* fall through to the explicit-version error below */
  }
  if (!version) {
    fail(`could not read the ${plugin} version from ${cloneDir}/.claude-plugin/marketplace.json; pass it explicitly`);
  }
}

// 3) Verify the versioned cache actually exists — the #1 mistake is forgetting to
//    bump the version, so this dir is never created and the old copy is still served.
const cacheDir = path.join(cacheRoot, version);
if (!fs.existsSync(cacheDir)) {
  fail(
    `cache dir missing: ${cacheDir}\n` +
    `  Did you (a) bump ${plugin}'s version in BOTH plugin.json and marketplace.json, ` +
    `and (b) run 'claude plugin marketplace update ${marketplace}'?`
  );
}

// 4) Resolve the marketplace clone's HEAD for gitCommitSha (informational; best effort).
let sha = null;
try {
  sha = execFileSync("git", ["-C", cloneDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* local-path marketplaces may not be a git repo; leave sha as-is below */
}

// 5) Repoint the pin in installed_plugins.json — atomically, after a backup.
if (!fs.existsSync(installedFile)) {
  fail(`not found: ${installedFile}`);
}
let doc;
try {
  doc = JSON.parse(fs.readFileSync(installedFile, "utf8"));
} catch (e) {
  fail(`installed_plugins.json is not valid JSON, refusing to touch it: ${e.message}`);
}
const entries = doc.plugins?.[pinKey];
if (!Array.isArray(entries) || entries.length === 0) {
  fail(
    `'${pinKey}' is not installed yet. Install it once via the /plugin UI ` +
    `(or 'claude plugin install ${pinKey}'), then re-run this to flip the version.`
  );
}

const pin = entries[0];
const before = { version: pin.version, installPath: pin.installPath };
pin.installPath = cacheDir;
pin.version = version;
if (sha) pin.gitCommitSha = sha;
pin.lastUpdated = new Date().toISOString();

fs.copyFileSync(installedFile, `${installedFile}.bak`);
const tmp = `${installedFile}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
fs.renameSync(tmp, installedFile);

process.stdout.write(
  `✓ ${pinKey}: ${before.version} → ${version}\n` +
  `  installPath: ${cacheDir}\n` +
  `  backup: ${installedFile}.bak\n` +
  `\nNow RESTART Claude Code to load ${plugin} ${version}. ` +
  `Don't run /plugin actions in the current (stale) session — they can rewrite the pin.\n`
);
