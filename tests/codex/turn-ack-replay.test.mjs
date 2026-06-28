import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { captureTurn, extractTurnIdFromStartResponse } from "../../plugins/codex/scripts/lib/codex.mjs";

function makeFakeClient() {
  return {
    notificationHandler: null,
    exitError: null,
    setNotificationHandler(fn) {
      this.notificationHandler = fn;
    },
    // Never resolves: keep the transport watchdog out of these tests.
    exitPromise: new Promise(() => {})
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- A4: buffered-notification replay must be as resilient as the live handler ---

test("captureTurn contains a malformed BUFFERED notification on replay instead of crashing the turn", async () => {
  const client = makeFakeClient();
  const progress = [];
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), {
    idleTimeoutMs: 0,
    onProgress: (event) => progress.push(event)
  });
  let settled = null;
  promise.then((s) => (settled = { ok: s }), (e) => (settled = { err: e }));
  await tick();

  // Before the ACK, state.turnId is null, so this notification is BUFFERED. Its
  // shape (a fileChange item with no `changes`) makes the item renderer throw — the
  // same case the LIVE handler already contains; replay must contain it too.
  assert.doesNotThrow(() => {
    client.notificationHandler({
      method: "item/started",
      params: { threadId: "thread1", item: { type: "fileChange" } }
    });
  });

  resolveAck({ turn: { id: "turn1", status: "inProgress" } }); // ACK -> turnId set -> replay
  await tick();

  const skipNote = progress
    .map((event) => (typeof event === "string" ? event : event?.message))
    .find((message) => typeof message === "string" && /skip|could not process|notification/i.test(message));
  assert.ok(skipNote, "a malformed buffered notification must be skipped+logged on replay, not thrown");
  assert.match(skipNote, /method=item\/started/, "the diagnostic should name the offending method");

  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  await tick();
  assert.ok(settled && settled.ok, "the turn must complete, not reject, after a malformed buffered replay");
  assert.equal(settled.ok.completed, true);
});

test("captureTurn applies a buffered thread/started on replay instead of misrouting it to the previous handler", async () => {
  const client = makeFakeClient();
  const prevCalls = [];
  client.notificationHandler = (message) => prevCalls.push(message); // captured as previousHandler
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), { idleTimeoutMs: 0 });
  await tick();

  // Buffered before the ACK; a NEW subthread's thread/started. The live handler
  // special-cases thread/started (applies it regardless of belongsToTurn); replay
  // must do the same instead of routing it to previousHandler.
  client.notificationHandler({ method: "thread/started", params: { thread: { id: "subthread-1", name: "sub" } } });
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();

  assert.equal(
    prevCalls.filter((m) => m.method === "thread/started").length,
    0,
    "a buffered thread/started must be applied on replay, not misrouted to the previous handler"
  );

  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  await promise;
});

// --- A1: turn-id extraction from the ACK + fail-fast (never buffer forever) ---

test("extractTurnIdFromStartResponse prefers turn.id and falls back to a top-level turnId", () => {
  assert.equal(extractTurnIdFromStartResponse({ turn: { id: "t1" } }), "t1");
  assert.equal(extractTurnIdFromStartResponse({ turnId: "t2" }), "t2");
  assert.equal(extractTurnIdFromStartResponse({ turn: { id: "t1" }, turnId: "t2" }), "t1");
  assert.equal(extractTurnIdFromStartResponse({ turn: { status: "inProgress" } }), null);
  assert.equal(extractTurnIdFromStartResponse({}), null);
});

test("captureTurn fails fast when the turn/start ACK carries no turn id", { timeout: 4000 }, async () => {
  const client = makeFakeClient();
  // ACK has a turn object but no id and no top-level turnId: we can never gate this
  // turn's notifications, so the old code buffered them forever (silent hang). The
  // fix rejects fast with a protocol error instead.
  const promise = captureTurn(client, "thread1", async () => ({ turn: { status: "inProgress" } }), {
    idleTimeoutMs: 0
  });
  await assert.rejects(promise, (error) => {
    assert.match(error.message, /turn id|ack|track/i);
    return true;
  });
});

test("captureTurn tracks the turn when the ACK carries only a top-level turnId", { timeout: 4000 }, async () => {
  const client = makeFakeClient();
  const promise = captureTurn(client, "thread1", async () => ({ turnId: "turn1", turn: { status: "inProgress" } }), {
    idleTimeoutMs: 0
  });
  await tick();

  // With turnId extracted from the fallback, a turn/completed is dispatched (not
  // buffered forever) and the turn completes.
  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  const state = await promise;
  assert.equal(state.completed, true);
});
