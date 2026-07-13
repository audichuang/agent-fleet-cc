import test from "node:test";
import assert from "node:assert/strict";

import { shouldRefuseBrokerShutdown, wireAppServerDeathTeardown } from "../../plugins/codex/scripts/app-server-broker.mjs";

const me = Symbol("me");
const other = Symbol("other");

// When the underlying codex app-server dies but the broker Node parent survives,
// the broker must tear down its client sockets so a worker blocked on an in-flight
// turn unblocks (its transport watchdog only fires on a socket close) instead of
// hanging to the 1-hour job hard cap.
test("app-server death triggers exactly one broker teardown; a live app-server triggers none", async () => {
  let resolveExit;
  const appClient = { exitPromise: new Promise((r) => (resolveExit = r)) };
  const calls = [];
  const wired = wireAppServerDeathTeardown(appClient, async () => {
    calls.push("teardown");
  });

  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [], "must not tear down while the app-server is alive");

  resolveExit();
  await wired;
  assert.deepEqual(calls, ["teardown"], "app-server death must trigger exactly one teardown");
});

test("broker refuses shutdown while another client owns the active stream", () => {
  assert.equal(shouldRefuseBrokerShutdown(other, null, me), true);
});

test("broker refuses shutdown while another client owns the active request", () => {
  assert.equal(shouldRefuseBrokerShutdown(null, other, me), true);
});

test("broker allows shutdown when idle (no active stream or request)", () => {
  assert.equal(shouldRefuseBrokerShutdown(null, null, me), false);
});

test("broker allows shutdown when the requester itself owns the active stream/request", () => {
  assert.equal(shouldRefuseBrokerShutdown(me, me, me), false);
});
