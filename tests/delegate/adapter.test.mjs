// tests/delegate/adapter.test.mjs
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { validateProcessAdapter } from "../../plugins/delegate/scripts/lib/shared/adapter-api.mjs";
import {
  makeClaudeAdapter,
  buildClaudeArgs,
  resolveDataRoot,
  workspaceStateDir,
} from "../../plugins/delegate/scripts/lib/adapter.mjs";
import { writeProfile, makeDataRoot } from "./helpers.mjs";

test("adapter satisfies the ProcessAdapter contract", () => {
  assert.deepEqual(validateProcessAdapter(makeClaudeAdapter()), []);
});

test("buildClaudeArgs composes the headless invocation", () => {
  const args = buildClaudeArgs({ settingsPath: "/p/s.json" });
  assert.deepEqual(args, [
    "-p", "--output-format", "stream-json", "--verbose",
    "--settings", "/p/s.json", "--permission-mode", "bypassPermissions",
  ]);
  assert.deepEqual(
    buildClaudeArgs({ settingsPath: "/p/s.json", permissionMode: "default", resumeSessionId: "s9", model: "deepseek-chat" }).slice(-4),
    ["--model", "deepseek-chat", "-r", "s9"],
  );
});

test("buildInvocation resolves profile env at spawn time (secrets stay out of job.json)", () => {
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "p1", {
    env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "tok" },
  });
  const adapter = makeClaudeAdapter();
  const inv = adapter.buildInvocation({
    job: { request: { settingsPath, permissionMode: "bypassPermissions" } },
    prompt: "do it",
  });
  assert.equal(inv.argv[0], "claude");
  assert.ok(inv.argv.includes("--settings"));
  assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(inv.stdinPayload, "do it");
});

test("binaryArgv override (conformance/test seam) replaces the claude binary", () => {
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "p1", { env: {} });
  const inv = makeClaudeAdapter().buildInvocation({
    job: { request: { settingsPath, binaryArgv: ["/usr/bin/node", "/tmp/fake.mjs"] } },
    prompt: "x",
  });
  assert.deepEqual(inv.argv.slice(0, 2), ["/usr/bin/node", "/tmp/fake.mjs"]);
});

test("parseEvent: session + result mapped, junk and irrelevant events → null", () => {
  const a = makeClaudeAdapter();
  assert.deepEqual(a.parseEvent('{"type":"system","session_id":"s1"}'), { kind: "session", sessionId: "s1" });
  const r = a.parseEvent('{"type":"result","result":"done","is_error":false,"usage":{"input_tokens":10,"output_tokens":5}}');
  assert.deepEqual(r, { kind: "result", text: "done", isError: false, usage: { inputTokens: 10, outputTokens: 5 } });
  assert.equal(a.parseEvent("not json"), null);
  assert.equal(a.parseEvent('{"type":"assistant","message":"..."}'), null);
});

test("extractResult: ok requires result event, non-string result is stringified", () => {
  const a = makeClaudeAdapter();
  const events = [
    { type: "engine-event", kind: "session", sessionId: "s1" },
    { type: "engine-event", kind: "result", text: "hi", isError: false, usage: { inputTokens: 1, outputTokens: 2 } },
  ];
  assert.deepEqual(a.extractResult(events, 0), {
    ok: true, resultText: "hi", sessionId: "s1", usage: { inputTokens: 1, outputTokens: 2 },
  });
  assert.equal(a.extractResult([], 0).ok, false);
  assert.equal(a.extractResult([{ type: "engine-event", kind: "result", text: "x", isError: true }], 0).ok, false);
});

test("classifyError buckets", () => {
  const a = makeClaudeAdapter();
  assert.equal(a.classifyError("401 unauthorized invalid x-api-key", 1), "auth");
  assert.equal(a.classifyError("getaddrinfo ENOTFOUND my.endpoint", 1), "endpoint");
  assert.equal(a.classifyError("claude: command not found", 127), "not-installed");
  assert.equal(a.classifyError("boom", 1), "unknown");
});

test("resumeArgs + recursion marker + paths", () => {
  const a = makeClaudeAdapter();
  assert.deepEqual(a.resumeArgs("s1"), ["-r", "s1"]);
  assert.equal(a.recursionMarker, "CLAUDE_DELEGATE_ACTIVE");
  assert.equal(a.engine, "delegate");
  assert.equal(a.wantsWatchdog, false);
  assert.equal(resolveDataRoot({ DELEGATE_PLUGIN_DATA: "/d" }), "/d");
  const dir = workspaceStateDir("/root", "/home/u/proj");
  assert.ok(dir.startsWith(path.join("/root", "state", "proj-")));
  assert.equal(workspaceStateDir("/root", "/home/u/proj"), dir); // 穩定
});
