import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL,
  UsageError,
  isMainModule,
  normalizeArgv,
  resolveEngines,
  splitRawArgumentString,
} from "../../plugins/fleet/scripts/lib/cli-args.mjs";

test("splitRawArgumentString tokenizes quote and escape cases", () => {
  assert.deepEqual(splitRawArgumentString("foo bar"), ["foo", "bar"]);
  assert.deepEqual(splitRawArgumentString("'hello world'"), ["hello world"]);
  assert.deepEqual(splitRawArgumentString("\"hello world\""), ["hello world"]);
  assert.deepEqual(splitRawArgumentString("foo\\ bar"), ["foo bar"]);
  assert.deepEqual(splitRawArgumentString(""), []);
  assert.deepEqual(splitRawArgumentString("--cwd \"/some path\" --json"), [
    "--cwd",
    "/some path",
    "--json",
  ]);
  assert.deepEqual(splitRawArgumentString("foo\\"), ["foo\\"]);
});

test("normalizeArgv passes through already split argv", () => {
  assert.deepEqual(normalizeArgv(["--json"]), ["--json"]);
});

test("normalizeArgv splits a single raw argv string", () => {
  assert.deepEqual(normalizeArgv(["--cwd /tmp --json"]), ["--cwd", "/tmp", "--json"]);
});

test("resolveEngines defaults to canonical order", () => {
  assert.deepEqual(resolveEngines(null), ["codex", "antigravity", "cc", "grok"]);
  assert.deepEqual(resolveEngines(null), CANONICAL);
});

test("resolveEngines filters and canonicalizes requested engines", () => {
  assert.deepEqual(resolveEngines("codex"), ["codex"]);
  assert.deepEqual(resolveEngines("cc,codex"), ["codex", "cc"]);
});

test("resolveEngines rejects empty or unknown requests", () => {
  assert.throws(() => resolveEngines(""), UsageError);
  assert.throws(() => resolveEngines("unknown"), UsageError);
});

test("isMainModule returns false for a non-entry module URL", () => {
  const result = isMainModule(new URL("../../plugins/fleet/scripts/lib/cli-args.mjs", import.meta.url).href);
  assert.equal(typeof result, "boolean");
  assert.equal(result, false);
});
