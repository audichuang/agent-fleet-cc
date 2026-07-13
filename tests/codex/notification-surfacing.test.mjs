import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { captureTurn } from "../../plugins/codex/scripts/lib/codex.mjs";

// D: the app-server sends cost- and safety-relevant notifications that this client does
// NOT opt out of (only the high-frequency token deltas are opted out) — yet
// applyTurnNotification dropped them in its `default` arm, so a model reroute (a safety
// signal), a guardian warning, token usage, the plan, the working diff, and rate-limit
// updates were all invisible to the user. They must surface as progress/log lines.

function makeFakeClient() {
  return {
    notificationHandler: null,
    setNotificationHandler(fn) {
      this.notificationHandler = fn;
    },
    exitPromise: new Promise(() => {}) // never resolves; keep the transport watchdog out
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Start a turn, ACK it (so notifications dispatch live), feed one notification, then
// finalize. Returns the collected progress strings.
async function progressFor(method, params) {
  const client = makeFakeClient();
  const progress = [];
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), {
    idleTimeoutMs: 0,
    onProgress: (event) => progress.push(typeof event === "string" ? event : event?.message)
  });
  promise.catch(() => {});
  await tick();
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();

  client.notificationHandler({ method, params });

  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  await promise;
  return progress.filter((m) => typeof m === "string");
}

test("model/rerouted surfaces a safety-visible line (from → to + reason)", async () => {
  const lines = await progressFor("model/rerouted", {
    threadId: "thread1",
    turnId: "turn1",
    fromModel: "gpt-5",
    toModel: "gpt-5-codex",
    reason: "highRiskCyberActivity"
  });
  assert.ok(
    lines.some((m) => /rerout/i.test(m) && /gpt-5-codex/.test(m) && /highRiskCyberActivity/.test(m)),
    `expected a reroute line, got ${JSON.stringify(lines)}`
  );
});

test("guardianWarning surfaces the warning message", async () => {
  const lines = await progressFor("guardianWarning", { threadId: "thread1", message: "potential credential exfiltration" });
  assert.ok(
    lines.some((m) => /guardian/i.test(m) && /potential credential exfiltration/.test(m)),
    `expected a guardian line, got ${JSON.stringify(lines)}`
  );
});

test("thread/tokenUsage/updated surfaces a token-cost line", async () => {
  const lines = await progressFor("thread/tokenUsage/updated", {
    threadId: "thread1",
    turnId: "turn1",
    tokenUsage: {
      total: { totalTokens: 12345, inputTokens: 10000, cachedInputTokens: 0, outputTokens: 2345, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 272000
    }
  });
  assert.ok(
    lines.some((m) => /token/i.test(m) && /12345/.test(m)),
    `expected a token-usage line, got ${JSON.stringify(lines)}`
  );
});

test("turn/plan/updated surfaces plan progress", async () => {
  const lines = await progressFor("turn/plan/updated", {
    threadId: "thread1",
    turnId: "turn1",
    explanation: null,
    plan: [
      { step: "a", status: "completed" },
      { step: "b", status: "completed" },
      { step: "c", status: "inProgress" }
    ]
  });
  assert.ok(
    lines.some((m) => /plan/i.test(m) && /2\/3/.test(m)),
    `expected a plan line, got ${JSON.stringify(lines)}`
  );
});

test("turn/diff/updated surfaces a compact diff-changed line (not the whole diff)", async () => {
  const diff = "diff --git a/x b/x\n+added\n-removed\n";
  const lines = await progressFor("turn/diff/updated", { threadId: "thread1", turnId: "turn1", diff });
  assert.ok(
    lines.some((m) => /diff/i.test(m)),
    `expected a diff line, got ${JSON.stringify(lines)}`
  );
  assert.ok(!lines.some((m) => m.includes("diff --git")), "must not dump the raw diff into progress");
});

test("account/rateLimits/updated surfaces a rate-limit line", async () => {
  const lines = await progressFor("account/rateLimits/updated", {
    rateLimits: { limitId: null, limitName: null, primary: { usedPercent: 73, windowDurationMins: 300, resetsAt: null }, secondary: null, credits: null, individualLimit: null, planType: null, rateLimitReachedType: null }
  });
  assert.ok(
    lines.some((m) => /rate limit/i.test(m) && /73/.test(m)),
    `expected a rate-limit line, got ${JSON.stringify(lines)}`
  );
});

test("warning / configWarning / deprecationNotice (thread-less) all surface", async () => {
  const warn = await progressFor("warning", { threadId: null, message: "low disk space" });
  assert.ok(warn.some((m) => /warning/i.test(m) && /low disk space/.test(m)), JSON.stringify(warn));

  const cfg = await progressFor("configWarning", { summary: "unknown key 'foo'", details: null, path: "~/.codex/config.toml" });
  assert.ok(cfg.some((m) => /config warning/i.test(m) && /unknown key/.test(m)), JSON.stringify(cfg));

  const dep = await progressFor("deprecationNotice", { summary: "model gpt-4 is deprecated", details: null });
  assert.ok(dep.some((m) => /deprecation/i.test(m) && /gpt-4/.test(m)), JSON.stringify(dep));
});

test("windows/worldWritableWarning surfaces a warning line", async () => {
  const lines = await progressFor("windows/worldWritableWarning", { samplePaths: ["/a", "/b"], extraCount: 3, failedScan: false });
  assert.ok(lines.some((m) => /world-writable/i.test(m) && /5 path/.test(m)), JSON.stringify(lines));
});

test("a thread-scoped warning for a FOREIGN thread is routed away, not surfaced on this capture", async () => {
  // A `warning` carrying a threadId that isn't this turn's thread must NOT be hijacked onto
  // the active capture — it falls through to belongsToTurn (→ previousHandler).
  const client = makeFakeClient();
  const progress = [];
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), {
    idleTimeoutMs: 0,
    onProgress: (event) => progress.push(typeof event === "string" ? event : event?.message)
  });
  promise.catch(() => {});
  await tick();
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();

  client.notificationHandler({ method: "warning", params: { threadId: "other-thread", message: "foreign warning" } });

  client.notificationHandler({ method: "turn/completed", params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } } });
  await promise;

  assert.ok(!progress.some((m) => typeof m === "string" && /foreign warning/.test(m)), "a foreign-thread warning must not surface on this capture");
});

test("model/safetyBuffering/updated surfaces a safety line", async () => {
  const lines = await progressFor("model/safetyBuffering/updated", {
    threadId: "thread1",
    turnId: "turn1",
    model: "gpt-5",
    useCases: ["coding"],
    reasons: ["high-risk"],
    showBufferingUi: true,
    fasterModel: null
  });
  assert.ok(lines.some((m) => /safety buffering/i.test(m) && /gpt-5/.test(m)), JSON.stringify(lines));
});

test("turn/plan/updated bounds a very long explanation (no flooding the log)", async () => {
  const huge = "x".repeat(5000);
  const lines = await progressFor("turn/plan/updated", {
    threadId: "thread1",
    turnId: "turn1",
    explanation: huge,
    plan: [{ step: "a", status: "completed" }]
  });
  const planLine = lines.find((m) => /plan/i.test(m));
  assert.ok(planLine, JSON.stringify(lines));
  assert.ok(planLine.length < 400, `plan explanation must be bounded, got length ${planLine.length}`);
});

// Observability for a single long command (e.g. a 15-min build/test): the app-server
// streams item/commandExecution/outputDelta continuously, but there is no other handled
// notification between item/started and item/completed. The plugin surfaces a THROTTLED
// byte-count heartbeat so /codex:logs and /codex:status are not dark for minutes — without
// dumping the raw output (which can be ~10KB per call).
test("item/commandExecution/outputDelta surfaces a throttled byte-count heartbeat (not raw output)", async () => {
  const lines = await progressFor("item/commandExecution/outputDelta", {
    threadId: "thread1",
    turnId: "turn1",
    itemId: "item1",
    delta: "A".repeat(2048)
  });
  assert.ok(
    lines.some((m) => /output streaming/i.test(m) && /2 KB/.test(m)),
    `expected a command-output heartbeat, got ${JSON.stringify(lines)}`
  );
  assert.ok(!lines.some((m) => m.includes("AAAA")), "must not dump the raw command output into progress");
});

test("rapid command-output deltas within the throttle window collapse to a single heartbeat", async () => {
  const client = makeFakeClient();
  const progress = [];
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), {
    idleTimeoutMs: 0,
    onProgress: (event) => progress.push(typeof event === "string" ? event : event?.message)
  });
  promise.catch(() => {});
  await tick();
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();

  for (let i = 0; i < 5; i += 1) {
    client.notificationHandler({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread1", turnId: "turn1", itemId: "item1", delta: "x".repeat(1024) }
    });
  }

  client.notificationHandler({ method: "turn/completed", params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } } });
  await promise;

  const heartbeats = progress.filter((m) => typeof m === "string" && /output streaming/i.test(m));
  assert.equal(heartbeats.length, 1, `5 deltas inside the 20s window should yield exactly one heartbeat, got ${JSON.stringify(heartbeats)}`);
});
