import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { BROKER_ENDPOINT_ENV } from "../../skills/codex/scripts/lib/app-server.mjs";
import { interruptAppServerTurn } from "../../skills/codex/scripts/lib/codex.mjs";
import { saveBrokerSession } from "../../skills/codex/scripts/lib/broker-lifecycle.mjs";

test("interruptAppServerTurn no-ops instead of spawning a throwaway app-server when no broker session is recorded", async () => {
  // The turn lives on the SHARED broker. Without a recorded session, connect's
  // reuseExistingBroker fallback would spawn a fresh app-server that cannot own the
  // turn — the RPC then errors and the cancel path logs "interrupt failed" as if a
  // live turn had resisted. Assert the no-op, and that nothing was spawned.
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const previousPath = process.env.PATH;
  const previousEndpoint = process.env[BROKER_ENDPOINT_ENV];
  // helpers.mjs already strips CODEX_* from the test process; be explicit anyway so
  // the assertion cannot pass merely because an endpoint leaked in from a dev shell.
  delete process.env[BROKER_ENDPOINT_ENV];
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await interruptAppServerTurn(repo, { threadId: "thr_1", turnId: "turn_1" });

    assert.equal(result.attempted, false, "no broker session means there is nothing to interrupt");
    assert.equal(result.interrupted, false);
    assert.match(result.detail, /no shared Codex broker session/);
  } finally {
    process.env.PATH = previousPath;
    if (previousEndpoint !== undefined) {
      process.env[BROKER_ENDPOINT_ENV] = previousEndpoint;
    }
  }

  // The availability probe only runs `--version` / `app-server --help`, neither of
  // which boots the fake server, so any app-server start here would be the spawn we
  // are guarding against.
  const fakeState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  assert.ok(!fakeState?.appServerStarts, "the guard must return before any app-server is spawned");
});

// A fake broker: answers initialize, and turn/interrupt only for the thread it holds;
// any other thread gets the app-server's "thread not found" (turn_processor.rs).
async function startFakeBroker(heldThreadId) {
  const net = await import("node:net");
  const sock = path.join(makeTempDir(), "b.sock");
  const interrupts = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === undefined) continue;
        let reply;
        if (message.method === "initialize") {
          reply = { id: message.id, result: { userAgent: "fake-broker" } };
        } else if (message.method === "turn/interrupt" && message.params.threadId === heldThreadId) {
          interrupts.push(message.params);
          reply = { id: message.id, result: {} };
        } else {
          reply = { id: message.id, error: { code: -32600, message: `thread not found: ${message.params?.threadId}` } };
        }
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  return { endpoint: `unix:${sock}`, interrupts, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withEnv(binDir, endpoint, fn) {
  const previousPath = process.env.PATH;
  const previousEndpoint = process.env[BROKER_ENDPOINT_ENV];
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  if (endpoint) process.env[BROKER_ENDPOINT_ENV] = endpoint;
  else delete process.env[BROKER_ENDPOINT_ENV];
  try {
    return await fn();
  } finally {
    process.env.PATH = previousPath;
    if (previousEndpoint === undefined) delete process.env[BROKER_ENDPOINT_ENV];
    else process.env[BROKER_ENDPOINT_ENV] = previousEndpoint;
  }
}

test("interruptAppServerTurn uses the recorded broker endpoint over the caller's own broker", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const callerBroker = await startFakeBroker("someone-else");
  const recordedBroker = await startFakeBroker("thr_job");
  saveBrokerSession(repo, { endpoint: callerBroker.endpoint, pid: process.pid });
  try {
    const result = await withEnv(binDir, callerBroker.endpoint, () =>
      interruptAppServerTurn(repo, { threadId: "thr_job", turnId: "turn_1", brokerEndpoint: recordedBroker.endpoint })
    );
    assert.equal(result.interrupted, true, result.detail);
    assert.equal(recordedBroker.interrupts.length, 1);
    assert.equal(callerBroker.interrupts.length, 0);
  } finally {
    await callerBroker.close();
    await recordedBroker.close();
  }
});

test("interruptAppServerTurn without a recorded endpoint keeps using the session's broker", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const sessionBroker = await startFakeBroker("thr_job");
  try {
    const result = await withEnv(binDir, sessionBroker.endpoint, () =>
      interruptAppServerTurn(repo, { threadId: "thr_job", turnId: "turn_1" })
    );
    assert.equal(result.interrupted, true, result.detail);
    assert.equal(sessionBroker.interrupts.length, 1);
  } finally {
    await sessionBroker.close();
  }
});
