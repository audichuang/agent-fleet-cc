import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { captureTurn } from "../../skills/codex/scripts/lib/codex.mjs";

// Codex's send_message_to_user_async / request_user_input_async tools emit an
// agentMessage with phase "final_answer" AND delivery "async" while the turn keeps
// running (codex-rs/core/src/tools/handlers/send_message_to_user_async.rs). Only a
// non-async final_answer may start the inferred-completion timer.

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClient() {
  return {
    notificationHandler: null,
    exitError: null,
    setNotificationHandler(fn) {
      this.notificationHandler = fn;
    },
    exitPromise: new Promise(() => {}),
    request: async () => ({})
  };
}

function agentMessage(client, text, extra = {}) {
  client.notificationHandler({
    method: "item/completed",
    params: { threadId: "thread1", turnId: "turn1", item: { type: "agentMessage", id: text, phase: "final_answer", text, ...extra } }
  });
}

async function startTurn(client) {
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), { idleTimeoutMs: 0 });
  promise.catch(() => {});
  await tick();
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();
  return { promise }; // wrapped: an async function returning the turn promise would await it
}

test("an async final_answer message does not end the turn; the real final answer does", async () => {
  const client = fakeClient();
  const { promise } = await startTurn(client);
  let settled = false;
  promise.then(() => (settled = true), () => (settled = true));

  agentMessage(client, "Still working: checked the first half.", { delivery: "async" });
  await tick(600);
  assert.equal(settled, false, "an async message mid-turn must not be taken as the end of the turn");

  agentMessage(client, "All done.");
  const state = await promise;
  assert.equal(state.lastAgentMessage, "All done.");
});

test("a final_answer without delivery still infers completion when turn/completed never arrives", async () => {
  const client = fakeClient();
  const { promise } = await startTurn(client);
  agentMessage(client, "done");
  const state = await promise;
  assert.equal(state.lastAgentMessage, "done");
});
