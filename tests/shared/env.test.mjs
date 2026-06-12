// tests/shared/env.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngineEnv,
  DENY_PREFIXES,
} from "../../shared/lib/core/env.mjs";

test("strips inherited provider/runtime vars by deny prefix", () => {
  const env = buildEngineEnv({
    baseEnv: {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "leak",
      CLAUDE_PROJECT_DIR: "/x",
      CLAUDECODE: "1",
      HOME: "/home/u",
    },
    recursionMarker: "FLEET_TEST_ACTIVE",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("CLAUDE_PROJECT_DIR" in env, false);
  assert.equal("CLAUDECODE" in env, false);
});

test("CLAUDE_CONFIG_DIR survives by default (ecosystem reuse)", () => {
  const env = buildEngineEnv({
    baseEnv: { CLAUDE_CONFIG_DIR: "/custom" },
    recursionMarker: "M",
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/custom");
});

test("engineEnv injects after strip and coerces primitives; recursion marker set", () => {
  const env = buildEngineEnv({
    baseEnv: { ANTHROPIC_BASE_URL: "inherited-evil" },
    engineEnv: {
      ANTHROPIC_BASE_URL: "https://profile-endpoint",
      RETRIES: 3,
      SKIP_ME: null,
      ALSO_SKIP: { nested: true },
    },
    recursionMarker: "CLAUDE_DELEGATE_ACTIVE",
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://profile-endpoint");
  assert.equal(env.RETRIES, "3");
  assert.equal("SKIP_ME" in env, false);
  assert.equal("ALSO_SKIP" in env, false);
  assert.equal(env.CLAUDE_DELEGATE_ACTIVE, "1");
});

test("recursionMarker is required — adapters cannot opt out", () => {
  assert.throws(() => buildEngineEnv({ baseEnv: {} }), /recursionMarker/);
  assert.deepEqual(DENY_PREFIXES, ["ANTHROPIC_", "CLAUDE_", "CLAUDECODE"]);
});
