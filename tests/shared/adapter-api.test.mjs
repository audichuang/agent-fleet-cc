// tests/shared/adapter-api.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProcessAdapter } from "../../shared/lib/adapter-api.mjs";

const valid = {
  name: "fake",
  engine: "fake",
  recursionMarker: "FAKE_ACTIVE",
  wantsWatchdog: false,
  buildInvocation: ({ job, prompt }) => ({ argv: ["true"], env: {}, stdinPayload: prompt }),
  parseEvent: (line) => null,
  extractResult: (events, exitCode) => ({ ok: true, resultText: "", sessionId: null }),
  classifyError: (stderrTail, exitCode) => "unknown",
  resumeArgs: (sessionId) => [],
};

test("a complete adapter validates", () => {
  assert.deepEqual(validateProcessAdapter(valid), []);
});

test("missing members are reported by name", () => {
  const { parseEvent, ...broken } = valid;
  const problems = validateProcessAdapter({ ...broken, recursionMarker: "" });
  assert.ok(problems.some((p) => p.includes("parseEvent")));
  assert.ok(problems.some((p) => p.includes("recursionMarker")));
});
