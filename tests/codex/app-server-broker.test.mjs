import test from "node:test";
import assert from "node:assert/strict";

import {
  attachUpstreamExitHandler,
  shouldRefuseBrokerShutdown
} from "../../plugins/codex/scripts/app-server-broker.mjs";

const me = Symbol("me");
const other = Symbol("other");

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

// When the upstream codex app-server dies on its own (crash, panic, daemon
// idle-shutdown, self-update restart), turn completion — which streams as
// NOTIFICATIONS, not as a reply the appClient exit could reject — never
// reaches a client that already got its turn/start ACK. The broker must
// propagate the death by dropping every client socket (so the client's
// transport watchdog fires a terminal error) and then tear itself down, or
// the turn hangs silently until the 1-hour hard cap.
test("broker drops all client sockets and exits when the upstream app-server dies", async () => {
  const destroyed = [];
  const sockets = new Set([
    { destroy: () => destroyed.push("a") },
    { destroy: () => destroyed.push("b") }
  ]);
  let shutdownCalls = 0;
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const order = [];
  const sockA = { destroy: () => { destroyed.push("a"); order.push("destroy"); } };
  const sockB = { destroy: () => { destroyed.push("b"); order.push("destroy"); } };
  sockets.clear();
  sockets.add(sockA);
  sockets.add(sockB);
  const handled = attachUpstreamExitHandler({
    exitPromise,
    sockets,
    shutdown: async () => {
      shutdownCalls += 1;
      order.push("shutdown");
    },
    isShuttingDown: () => false,
    onExit: () => {
      exited = true;
      order.push("exit");
    },
    log: () => order.push("log"),
    emitTerminal: () => order.push("emitTerminal")
  });

  resolveExit();
  await handled;

  assert.deepEqual(destroyed.sort(), ["a", "b"], "every connected client socket must be dropped");
  assert.equal(shutdownCalls, 1, "the broker must tear itself down after the upstream dies");
  assert.equal(exited, true, "the broker must exit — a dead upstream makes it useless");
  // Order matters: log the reason, hand the streaming client a clean terminal,
  // THEN drop sockets / tear down. A synthetic terminal after destroy is useless.
  assert.equal(order[0], "log", "the death must be logged first so the reason is diagnosable");
  assert.equal(order[1], "emitTerminal", "the clean terminal must be emitted before sockets are dropped");
  assert.ok(order.indexOf("emitTerminal") < order.indexOf("destroy"), "emitTerminal must precede socket destroy");
  assert.ok(order.indexOf("destroy") < order.indexOf("shutdown"), "sockets drop before shutdown");
  assert.equal(order[order.length - 1], "exit", "exit is last");
});

test("broker still tears down when the synthetic terminal emit throws", async () => {
  const destroyed = [];
  const sockets = new Set([{ destroy: () => destroyed.push("a") }]);
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const handled = attachUpstreamExitHandler({
    exitPromise,
    sockets,
    shutdown: async () => {},
    isShuttingDown: () => false,
    onExit: () => {
      exited = true;
    },
    emitTerminal: () => {
      throw new Error("active socket already gone");
    }
  });

  resolveExit();
  await handled;

  assert.deepEqual(destroyed, ["a"], "a throwing emitTerminal must not block the guaranteed socket drop");
  assert.equal(exited, true, "teardown must still complete after emitTerminal throws");
});

test("broker does not re-tear-down when the upstream exit was our own shutdown", async () => {
  const destroyed = [];
  const sockets = new Set([{ destroy: () => destroyed.push("a") }]);
  let shutdownCalls = 0;
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  let logged = false;
  const handled = attachUpstreamExitHandler({
    exitPromise,
    sockets,
    shutdown: async () => {
      shutdownCalls += 1;
    },
    isShuttingDown: () => true, // our own shutdown() already closed the appClient
    onExit: () => {
      exited = true;
    },
    log: () => {
      logged = true;
    }
  });

  resolveExit();
  await handled;

  assert.deepEqual(destroyed, [], "an intentional shutdown must not re-destroy sockets");
  assert.equal(shutdownCalls, 0, "an intentional shutdown must not re-enter teardown");
  assert.equal(exited, false, "an intentional shutdown must not force a second exit");
  assert.equal(logged, false, "an intentional shutdown must not log a spurious upstream-death line");
});

test("broker swallows a socket.destroy() error while propagating an upstream death", async () => {
  const destroyed = [];
  const sockets = new Set([
    {
      destroy: () => {
        throw new Error("socket already gone");
      }
    },
    { destroy: () => destroyed.push("b") }
  ]);
  let exited = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const handled = attachUpstreamExitHandler({
    exitPromise,
    sockets,
    shutdown: async () => {},
    isShuttingDown: () => false,
    onExit: () => {
      exited = true;
    }
  });

  resolveExit();
  await handled;

  assert.deepEqual(destroyed, ["b"], "a throwing socket must not stop the others from being dropped");
  assert.equal(exited, true, "teardown must still complete after a socket destroy throws");
});
