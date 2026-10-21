import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../../skills/codex/scripts/lib/args.mjs";

test("splitRawArgumentString keeps backslashes literal inside single quotes (POSIX)", () => {
  // Single quotes preserve everything literally, including backslashes.
  assert.deepEqual(splitRawArgumentString("'a\\b'"), ["a\\b"]);
  assert.deepEqual(splitRawArgumentString("'C:\\Users\\me'"), ["C:\\Users\\me"]);
});

test("splitRawArgumentString treats single-quoted whitespace as part of one token", () => {
  assert.deepEqual(splitRawArgumentString("'a b c'"), ["a b c"]);
});

test("splitRawArgumentString splits on unquoted whitespace and strips the matching quotes", () => {
  assert.deepEqual(splitRawArgumentString("--base main 'focus text'"), ["--base", "main", "focus text"]);
});

test("splitRawArgumentString still honours backslash escapes outside single quotes", () => {
  // An escaped space stays in the token rather than splitting it.
  assert.deepEqual(splitRawArgumentString("a\\ b"), ["a b"]);
});

// `--prompt-file=/tmp/a=b.md` used to read `/tmp/a`: the inline value was cut at its second
// "=". A file option then silently read a different file (Codex review, 2026-10-22).
test("parseArgs keeps every '=' after the first in an inline value", () => {
  const { options } = parseArgs(["--focus-file=/tmp/focus=security.md", "--base=a=b"], {
    valueOptions: ["focus-file", "base"]
  });
  assert.equal(options["focus-file"], "/tmp/focus=security.md");
  assert.equal(options.base, "a=b");
});
