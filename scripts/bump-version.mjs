#!/usr/bin/env node
// Multi-plugin version bump / lockstep check.
//
// Each plugin declares its version in TWO places that must agree:
//   - plugins/<name>/.claude-plugin/plugin.json   ("version")
//   - .claude-plugin/marketplace.json             (the plugin's entry "version")
// tests/fleet-structure.test.mjs enforces the match; this tool keeps them in lockstep so
// a release never ships a half-bumped pair, and `--check` is a fast pre-commit gate.
//
// Usage:
//   node scripts/bump-version.mjs <plugin> <x.y.z|patch|minor|major>
//   node scripts/bump-version.mjs --check
// Zero-dependency, pure ESM.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Strict x.y.z: each component is 0 or a leading-zero-free non-negative integer.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LEVELS = new Set(["patch", "minor", "major"]);

function isValidVersion(version) {
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    return false;
  }
  // Guard against components beyond safe-integer range (would lose precision when bumped).
  return version.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

function marketplacePath(root) {
  return path.join(root, ".claude-plugin", "marketplace.json");
}

function manifestPath(root, name) {
  return path.join(root, "plugins", name, ".claude-plugin", "plugin.json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Match the existing files: 2-space indent + trailing newline.
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function bumpSemver(version, level) {
  if (!isValidVersion(version)) {
    throw new Error(`Cannot bump "${version}": expected a semver x.y.z version.`);
  }
  if (!LEVELS.has(level)) {
    throw new Error(`Unknown bump level "${level}": expected one of patch|minor|major.`);
  }
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Compare every marketplace plugin entry's version to its plugin.json manifest version.
export function checkLockstep(root = REPO_ROOT) {
  const marketplace = readJson(marketplacePath(root));
  const plugins = [];
  const mismatches = [];
  for (const entry of marketplace.plugins ?? []) {
    let manifestVersion = null;
    try {
      manifestVersion = readJson(manifestPath(root, entry.name)).version ?? null;
    } catch {
      manifestVersion = null; // missing/unreadable manifest is a mismatch
    }
    plugins.push({ name: entry.name, version: entry.version ?? null });
    if (manifestVersion !== entry.version) {
      mismatches.push({ name: entry.name, marketplace: entry.version ?? null, manifest: manifestVersion });
    }
  }
  return { ok: mismatches.length === 0, mismatches, plugins };
}

// Resolve a target version from an explicit x.y.z or a bump level against the current one.
export function resolveTargetVersion(current, arg) {
  if (LEVELS.has(arg)) {
    return bumpSemver(current, arg);
  }
  if (!isValidVersion(arg)) {
    throw new Error(`Invalid version "${arg}": expected x.y.z or one of patch|minor|major.`);
  }
  return arg;
}

// Set a plugin's version in BOTH the manifest and the marketplace entry.
export function setPluginVersion(root, name, version) {
  if (!isValidVersion(version)) {
    throw new Error(`Invalid version "${version}": expected a semver x.y.z version.`);
  }
  const mpPath = marketplacePath(root);
  const marketplace = readJson(mpPath);
  const entry = (marketplace.plugins ?? []).find((p) => p.name === name);
  if (!entry) {
    throw new Error(`Unknown plugin "${name}": not found in marketplace.json.`);
  }
  const mfPath = manifestPath(root, name);
  const manifest = readJson(mfPath); // throws if the manifest is missing — both must exist
  const from = entry.version ?? manifest.version ?? null;

  entry.version = version;
  manifest.version = version;
  writeJson(mpPath, marketplace);
  writeJson(mfPath, manifest);
  return { name, from, to: version };
}

function runCli(argv) {
  if (argv.includes("--check")) {
    const result = checkLockstep(REPO_ROOT);
    if (result.ok) {
      process.stdout.write(`✓ versions in lockstep (${result.plugins.map((p) => `${p.name}@${p.version}`).join(", ")})\n`);
      return 0;
    }
    process.stderr.write("✗ version lockstep mismatch:\n");
    for (const m of result.mismatches) {
      process.stderr.write(`  ${m.name}: marketplace=${m.marketplace} manifest=${m.manifest}\n`);
    }
    return 1;
  }

  const [name, versionArg] = argv;
  if (!name || !versionArg) {
    process.stderr.write(
      "usage: node scripts/bump-version.mjs <plugin> <x.y.z|patch|minor|major>\n       node scripts/bump-version.mjs --check\n"
    );
    return 2;
  }

  const entry = (readJson(marketplacePath(REPO_ROOT)).plugins ?? []).find((p) => p.name === name);
  if (!entry) {
    process.stderr.write(`Unknown plugin "${name}".\n`);
    return 1;
  }
  const target = resolveTargetVersion(entry.version, versionArg);
  const change = setPluginVersion(REPO_ROOT, name, target);
  process.stdout.write(`bumped ${change.name}: ${change.from} → ${change.to} (plugin.json + marketplace.json)\n`);
  process.stdout.write("Remember to add a CHANGELOG entry for this version.\n");
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(runCli(process.argv.slice(2)));
}
