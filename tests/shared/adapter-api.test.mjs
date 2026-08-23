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

// firstEventTimeoutMs 是選填的:不宣告 = 不啟用首事件看門狗,所以既有 adapter
// (cc / antigravity / codex)一個字都不必改。宣告了就必須是正有限數 —— 0 / NaN /
// 字串會讓 runWorker 靜默不武裝那道關,那是「看起來有防護、其實沒有」的最壞形態,
// 所以在合約層擋掉,而不是等執行期沉默失效。
test("firstEventTimeoutMs is optional — absent or null is valid", () => {
  assert.deepEqual(validateProcessAdapter(valid), []);
  assert.deepEqual(validateProcessAdapter({ ...valid, firstEventTimeoutMs: null }), []);
  assert.deepEqual(validateProcessAdapter({ ...valid, firstEventTimeoutMs: 120_000 }), []);
});

test("firstEventTimeoutMs, when declared, must be a positive finite number", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "120000", {}]) {
    const problems = validateProcessAdapter({ ...valid, firstEventTimeoutMs: bad });
    assert.ok(
      problems.some((p) => p.includes("firstEventTimeoutMs")),
      `${String(bad)} must be rejected`,
    );
  }
});
