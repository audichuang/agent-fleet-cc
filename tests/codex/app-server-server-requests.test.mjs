import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { AppServerClientBase } from "../../plugins/codex/scripts/lib/app-server.mjs";

// C2: the app-server can send the CLIENT requests (approvals, requestUserInput, MCP
// elicitation, auth-token refresh, …). This plugin cannot fulfil any of them, but a
// blanket `-32601` makes Codex render e.g. a command approval as "failed" and surface
// auth-refresh as a generic IO error. handleServerRequest must instead send the typed
// graceful DECLINE for each known method (so Codex unwinds the turn cleanly), reserve
// `-32601` for genuinely unknown methods, and log every one so a stall is debuggable.
class CapturingClient extends AppServerClientBase {
  constructor() {
    super("/tmp");
    this.sent = [];
  }
  sendMessage(message) {
    this.sent.push(message);
  }
}

function reply(method, params = {}) {
  const client = new CapturingClient();
  client.handleServerRequest({ id: "req-1", method, params });
  assert.equal(client.sent.length, 1, `exactly one reply for ${method}`);
  assert.equal(client.sent[0].id, "req-1", "reply echoes the request id");
  return client.sent[0];
}

test("command/fileChange approvals are declined with a typed decision (rendered 'declined', not 'failed')", () => {
  assert.deepEqual(reply("item/commandExecution/requestApproval").result, { decision: "decline" });
  assert.deepEqual(reply("item/fileChange/requestApproval").result, { decision: "decline" });
});

test("requestUserInput is answered with empty answers so the turn proceeds", () => {
  assert.deepEqual(reply("item/tool/requestUserInput").result, { answers: {} });
});

test("MCP elicitation is declined with the elicitation action shape", () => {
  assert.deepEqual(reply("mcpServer/elicitation/request").result, { action: "decline", content: null, _meta: null });
});

test("permissions request is answered with an empty grant", () => {
  assert.deepEqual(reply("item/permissions/requestApproval").result, {
    permissions: {},
    scope: "turn",
    strictAutoReview: false
  });
});

test("dynamic tool call is declined with an unsupported result, not -32601", () => {
  const r = reply("item/tool/call").result;
  assert.equal(r.success, false);
  assert.ok(Array.isArray(r.contentItems) && r.contentItems.length >= 1);
});

test("auth-token refresh (which this client cannot do) returns a clear -32000 re-login error", () => {
  const r = reply("account/chatgptAuthTokens/refresh");
  assert.equal(r.result, undefined);
  assert.equal(r.error.code, -32000);
  assert.match(r.error.message, /re-login|log ?in|auth/i);
});

test("attestation/generate and currentTime/read (unfulfillable here) return -32000 errors", () => {
  for (const method of ["attestation/generate", "currentTime/read"]) {
    const r = reply(method);
    assert.equal(r.result, undefined, `${method} must not fake a result`);
    assert.equal(r.error.code, -32000, `${method} must be a -32000 error`);
  }
});

test("deprecated v1 approvals use the v1 ReviewDecision value 'denied' (not the v2 'decline')", () => {
  // v1 (applyPatchApproval/execCommandApproval) serialize core ReviewDecision
  // snake_case as "denied"; the v2 approvals use "decline". They must not be crossed.
  assert.deepEqual(reply("applyPatchApproval").result, { decision: "denied" });
  assert.deepEqual(reply("execCommandApproval").result, { decision: "denied" });
});

test("a genuinely unknown server request still gets -32601", () => {
  const r = reply("some/unheard/of/method");
  assert.equal(r.result, undefined);
  assert.equal(r.error.code, -32601);
});

test("every server request is logged (diagnosable) before replying", () => {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const client = new CapturingClient();
    client.handleServerRequest({ id: "req-log", method: "account/chatgptAuthTokens/refresh", params: {} });
  } finally {
    process.stderr.write = original;
  }
  const note = lines.find((l) => /server request/i.test(l) && /account\/chatgptAuthTokens\/refresh/.test(l));
  assert.ok(note, "a server request must be logged with its method so a stall is debuggable");
});
