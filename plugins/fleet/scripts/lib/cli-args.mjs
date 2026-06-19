import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL = ["codex", "antigravity", "cc"];

export class UsageError extends Error {}

export function normalizeArgv(argv, deps = {}) {
  return argv.flatMap((arg) => {
    if (arg === "--raw-args-stdin") {
      const readStdinImpl = deps.readStdinImpl ?? (() => fs.readFileSync(0, "utf8"));
      return splitRawArgumentString(String(readStdinImpl()));
    }
    if (!arg || typeof arg !== "string") return [];
    const hasRawOptionBoundary = /\s/.test(arg) && /(^|\s)--\S/.test(arg);
    if (argv.length === 1 || hasRawOptionBoundary) return splitRawArgumentString(arg);
    return [arg];
  });
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else current += character;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

export function resolveEngines(only, canonical = CANONICAL) {
  if (only === null) return [...canonical];
  const requested = only.split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw new UsageError("--only requires a comma-separated engine list");
  }
  for (const name of requested) {
    if (!canonical.includes(name)) {
      throw new UsageError(`unknown engine: ${name}; allowed: ${canonical.join(",")}`);
    }
  }
  return canonical.filter((name) => requested.includes(name));
}

function normalizeMainPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = normalizeMainPath(fileURLToPath(importMetaUrl));
  const entryPath = normalizeMainPath(entry);
  return modulePath === entryPath;
}
