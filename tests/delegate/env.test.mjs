import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildDelegateEnv } from "../../plugins/delegate/scripts/lib/env.mjs";

test("strips main-session provider/runtime vars (the polluted-env case)", () => {
  const env = buildDelegateEnv({
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_BASE_URL: "https://expensive.example.com",
      ANTHROPIC_AUTH_TOKEN: "main-secret",
      ANTHROPIC_MODEL: "opus",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_PLUGIN_DATA: "/somewhere",
      CLAUDECODE: "1",
    },
    profileEnv: {},
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/u");
  for (const key of Object.keys(env)) {
    assert.ok(!key.startsWith("ANTHROPIC_"), `leaked ${key}`);
    assert.ok(!key.startsWith("CLAUDECODE"), `leaked ${key}`);
    assert.ok(
      !key.startsWith("CLAUDE_") ||
        key === "CLAUDE_DELEGATE_ACTIVE" ||
        key === "CLAUDE_CONFIG_DIR",
      `leaked ${key}`,
    );
  }
});

test("injects profile env verbatim and wins over base", () => {
  const env = buildDelegateEnv({
    baseEnv: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://expensive" },
    profileEnv: {
      ANTHROPIC_BASE_URL: "https://cheap.example.com",
      ANTHROPIC_AUTH_TOKEN: "kimi-token",
    },
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://cheap.example.com");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "kimi-token");
});

test("always sets the recursion marker", () => {
  const env = buildDelegateEnv({ baseEnv: {}, profileEnv: {} });
  assert.equal(env.CLAUDE_DELEGATE_ACTIVE, "1");
});

test("primitive profile env values are coerced to strings, nullish skipped", () => {
  const env = buildDelegateEnv({
    baseEnv: {},
    profileEnv: { S: "x", N: 42, B: true, NIL: null, U: undefined },
  });
  assert.equal(env.S, "x");
  assert.equal(env.N, "42");
  assert.equal(env.B, "true");
  assert.ok(!("NIL" in env));
  assert.ok(!("U" in env));
});

test("CLAUDE_CONFIG_DIR survives the rebuild (spec §7 deliberate sharing)", () => {
  const env = buildDelegateEnv({
    baseEnv: {
      CLAUDE_CONFIG_DIR: "/custom/claude-home",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      PATH: "/usr/bin",
    },
    profileEnv: {},
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/custom/claude-home");
  assert.ok(!("CLAUDE_CODE_ENTRYPOINT" in env));
});
