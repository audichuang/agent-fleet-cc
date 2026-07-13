import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { captureTurn } from "../../plugins/codex/scripts/lib/codex.mjs";

// captureTurn's transport watchdog is the backstop that turns a mid-turn app-server /
// broker death (crash / OOM before turn/completed) into a PROMPT terminal state, so a
// ~20-min background job never sits stuck "running" until the 1-hour hard cap. Every
// OTHER captureTurn test deliberately stubs `exitPromise: new Promise(() => {})` to keep
// this watchdog OUT — so the watchdog itself had no regression test and could silently
// break. These two tests exercise it directly by RESOLVING exitPromise.

function makeFakeClient() {
  let resolveExit;
  const exitPromise = new Promise((r) => (resolveExit = r));
  return {
    notificationHandler: null,
    exitError: null,
    setNotificationHandler(fn) {
      this.notificationHandler = fn;
    },
    exitPromise,
    resolveExit: () => resolveExit(),
    request: async () => ({}) // orphan-interrupt path is not reached in these tests
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("transport watchdog rejects the turn when the app-server disconnects before completion", async () => {
  const client = makeFakeClient();
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), { idleTimeoutMs: 0 });
  promise.catch(() => {});
  await tick();
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();

  // The broker/app-server dies mid-turn: no turn/completed, no final answer.
  client.resolveExit();

  await assert.rejects(promise, /disconnected before the turn completed/);
});

test("transport watchdog infers success when the socket closes right after final_answer", async () => {
  const client = makeFakeClient();
  let resolveAck;
  const progress = [];
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), {
    idleTimeoutMs: 0,
    onProgress: (event) => progress.push(typeof event === "string" ? event : event?.message)
  });
  promise.catch(() => {});
  await tick();
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();

  // A final_answer-phase agentMessage lands...
  client.notificationHandler({
    method: "item/completed",
    params: {
      threadId: "thread1",
      turnId: "turn1",
      item: { type: "agentMessage", phase: "final_answer", text: "done", id: "m1" }
    }
  });
  // ...then the transport closes BEFORE turn/completed arrives.
  client.resolveExit();

  const state = await promise;
  assert.equal(state.finalTurn?.status, "completed");
  assert.equal(state.lastAgentMessage, "done");
});
