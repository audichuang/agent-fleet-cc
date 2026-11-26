import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, ImageError } from "../../skills/imagine/scripts/imagine.mjs";

test("--engine agy is refused, not silently rerouted to xAI", () => {
  assert.throws(() => parseArgs(["--engine", "agy", "a cat"]), (e) => e instanceof ImageError && /removed/.test(e.message));
});

test("an unknown engine is a usage error, not a silent fallback to xAI", () => {
  assert.throws(() => parseArgs(["--engine", "dalle", "a cat"]), (e) => e instanceof ImageError && /unknown engine/.test(e.message));
  assert.equal(parseArgs(["a cat"]).engine, "grok", "the default engine stays grok");
  assert.equal(parseArgs(["--model", "x", "a cat"]).model, "x");
});
