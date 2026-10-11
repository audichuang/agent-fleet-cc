import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

// Importing helpers triggers the CODEX_COMPANION_DATA isolation side-effect.
import "./helpers.mjs";

test("the test harness isolates CODEX_COMPANION_DATA to a throwaway dir (never the real plugin data)", () => {
  const dir = process.env.CODEX_COMPANION_DATA;
  assert.ok(dir, "CODEX_COMPANION_DATA must be set by the harness");
  assert.ok(dir.startsWith(os.tmpdir()), `expected a tmp dir, got: ${dir}`);
  assert.doesNotMatch(
    dir,
    /\.claude[\\/]plugins[\\/]data/,
    "must not point at the developer's real plugin data dir — tests would collide with real broker/job state"
  );
});
