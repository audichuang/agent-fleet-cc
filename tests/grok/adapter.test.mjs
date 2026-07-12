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

test("buildInvocation adds --no-subagents only when requested", () => {
  const a = makeGrokAdapter();
  const on = a.buildInvocation({ job: { cwd: "/w", request: { noSubagents: true } }, prompt: "p" });
  assert.ok(on.argv.includes("--no-subagents"));
  const off = a.buildInvocation({ job: { cwd: "/w", request: {} }, prompt: "p" });
  assert.ok(!off.argv.includes("--no-subagents"));
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
  // grok emits {type:error,message} on stdout for bad model / bad effort / no-auth
  assert.deepEqual(a.parseEvent('{"type":"error","message":"unknown model id"}'), { kind: "error", message: "unknown model id" });
  assert.equal(a.parseEvent("{broken"), null);
});

test("extractResult joins text deltas; ok = exit 0 + terminal end (not a specific stopReason)", () => {
  const a = makeGrokAdapter();
  const events = [
    { kind: "text", text: "po" },
    { kind: "text", text: "ng" },
    { kind: "end", sessionId: "abc", stopReason: "EndTurn" },
  ];
  assert.deepEqual(a.extractResult(events, 0), { ok: true, resultText: "pong", sessionId: "abc", usage: null });
  // exit 0 + end present with a NON-EndTurn stopReason (e.g. MaxTokens) → still ok:
  // the answer is usable; the old EndTurn-only gate wrongly failed these.
  assert.equal(
    a.extractResult([{ kind: "text", text: "partial" }, { kind: "end", sessionId: "x", stopReason: "MaxTokens" }], 0).ok,
    true,
  );
  // non-zero exit → not ok even with a clean end
  assert.equal(a.extractResult(events, 1).ok, false);
  // no terminal end event → not ok (engine died mid-stream even if exit 0)
  assert.equal(a.extractResult([{ kind: "text", text: "hi" }], 0).ok, false);
  // a stdout error event → not ok even on exit 0 + end
  assert.equal(
    a.extractResult([{ kind: "error", message: "boom" }, { kind: "end", sessionId: "x", stopReason: "EndTurn" }], 0).ok,
    false,
  );
  // no text at all → null resultText
  assert.equal(a.extractResult([{ kind: "end", sessionId: "x", stopReason: "EndTurn" }], 0).resultText, null);
});

test("extractResult fences the final report on the sentinels (fan-out cleanup)", () => {
  const a = makeGrokAdapter();
  const end = { kind: "end", sessionId: "s", stopReason: "EndTurn" };
  // subagent chatter leaks before the fence (real grok multi-agent behavior);
  // only the fenced report survives, trimmed.
  const leaked = [
    { kind: "text", text: "Spawning subagents.Paris4" },
    { kind: "text", text: "<<<GROK_FINAL>>>\nCapital=Paris Sum=4\n<<<GROK_END>>>" },
    end,
  ];
  assert.equal(a.extractResult(leaked, 0).resultText, "Capital=Paris Sum=4");
  // no sentinels → unchanged full text (single-agent / caller didn't opt in)
  assert.equal(
    a.extractResult([{ kind: "text", text: "plain answer" }, end], 0).resultText,
    "plain answer",
  );
  // first-open → last-close: spans the whole fenced region even when the report
  // body quotes the sentinel tokens (as an audit report about grok would), while
  // still dropping the pre-fence leak.
  assert.equal(
    a.extractResult([{ kind: "text", text: "leak <<<GROK_FINAL>>>report mentions <<<GROK_END>>> and <<<GROK_FINAL>>> inline<<<GROK_END>>>" }, end], 0).resultText,
    "report mentions <<<GROK_END>>> and <<<GROK_FINAL>>> inline",
  );
});

test("classifyError maps auth / quota / config / endpoint / not-installed / unknown", () => {
  const a = makeGrokAdapter();
  assert.equal(a.classifyError("xai: 401 unauthorized", 1), "auth");
  assert.equal(a.classifyError("not logged in — run grok login", 1), "auth");
  // real 0.2.93 failure strings (verified by running)
  assert.equal(a.classifyError("Waiting for authorization...", 124), "auth");
  assert.equal(a.classifyError("No cached credentials found. Run `grok login` first.", 1), "auth");
  assert.equal(a.classifyError("You've reached your free Grok Build usage limit", 1), "quota");
  assert.equal(a.classifyError("429 Too Many Requests", 1), "quota");
  assert.equal(a.classifyError('Couldn\'t set model: Invalid params: "unknown model id"', 1), "config");
  assert.equal(a.classifyError("unknown effort level 'superduper'", 1), "config");
  assert.equal(a.classifyError("fetch failed ECONNREFUSED", 1), "endpoint");
  assert.equal(a.classifyError("command not found", 127), "not-installed");
  assert.equal(a.classifyError("boom", 1), "unknown");
});

test("resumeArgs yields -r <id>", () => {
  assert.deepEqual(makeGrokAdapter().resumeArgs("s1"), ["-r", "s1"]);
});
