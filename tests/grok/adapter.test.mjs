// tests/grok/adapter.test.mjs
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProcessAdapter } from "../../plugins/grok/scripts/lib/shared/adapter-api.mjs";
import { makeGrokAdapter } from "../../plugins/grok/scripts/lib/adapter.mjs";

test("adapter satisfies the ProcessAdapter contract", () => {
  assert.deepEqual(validateProcessAdapter(makeGrokAdapter()), []);
});

test("buildInvocation composes the headless streaming-json invocation", () => {
  const a = makeGrokAdapter();
  const { argv, stdinPayload } = a.buildInvocation({
    job: { cwd: "/w", request: { model: "grok-4.5" } },
    prompt: "do the thing",
  });
  assert.equal(stdinPayload, null);
  assert.deepEqual(argv, [
    "grok", "-p", "do the thing",
    "--output-format", "streaming-json",
    "--always-approve", "--no-auto-update", "--no-alt-screen",
    "-m", "grok-4.5", "--cwd", "/w",
  ]);
});

test("buildInvocation adds effort and resume when present, honors binaryArgv", () => {
  const a = makeGrokAdapter();
  const { argv } = a.buildInvocation({
    job: { cwd: "/w", request: { model: "grok-4.5", effort: "high", resumeSessionId: "s9", binaryArgv: ["node", "/fake"] } },
    prompt: "p",
  });
  assert.deepEqual(argv.slice(0, 2), ["node", "/fake"]);
  assert.ok(argv.includes("--reasoning-effort") && argv[argv.indexOf("--reasoning-effort") + 1] === "high");
  assert.deepEqual(argv.slice(-2), ["-r", "s9"]);
});

test("parseEvent maps grok events and tolerates junk", () => {
  const a = makeGrokAdapter();
  assert.equal(a.parseEvent("not json"), null);
  assert.equal(a.parseEvent('{"type":"thought","data":"hmm"}'), null);
  assert.deepEqual(a.parseEvent('{"type":"text","data":"pong"}'), { kind: "text", text: "pong" });
  assert.deepEqual(
    a.parseEvent('{"type":"end","stopReason":"EndTurn","sessionId":"abc","requestId":"r"}'),
    { kind: "end", sessionId: "abc", stopReason: "EndTurn" },
  );
  assert.equal(a.parseEvent("{broken"), null);
});

test("extractResult joins text deltas and gates ok on EndTurn + exit 0", () => {
  const a = makeGrokAdapter();
  const events = [
    { kind: "text", text: "po" },
    { kind: "text", text: "ng" },
    { kind: "end", sessionId: "abc", stopReason: "EndTurn" },
  ];
  assert.deepEqual(a.extractResult(events, 0), { ok: true, resultText: "pong", sessionId: "abc", usage: null });
  // non-EndTurn terminal → not ok
  assert.equal(a.extractResult([{ kind: "end", sessionId: "x", stopReason: "Aborted" }], 0).ok, false);
  // non-zero exit → not ok even with EndTurn
  assert.equal(a.extractResult(events, 1).ok, false);
  // no text at all → null resultText
  assert.equal(a.extractResult([{ kind: "end", sessionId: "x", stopReason: "EndTurn" }], 0).resultText, null);
});

test("classifyError maps auth / endpoint / not-installed / unknown", () => {
  const a = makeGrokAdapter();
  assert.equal(a.classifyError("xai: 401 unauthorized", 1), "auth");
  assert.equal(a.classifyError("not logged in — run grok login", 1), "auth");
  assert.equal(a.classifyError("fetch failed ECONNREFUSED", 1), "endpoint");
  assert.equal(a.classifyError("command not found", 127), "not-installed");
  assert.equal(a.classifyError("boom", 1), "unknown");
});

test("resumeArgs yields -r <id>", () => {
  assert.deepEqual(makeGrokAdapter().resumeArgs("s1"), ["-r", "s1"]);
});
