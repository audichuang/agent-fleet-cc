import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  DesktopIpcClient,
  DesktopThread,
  METHOD_VERSIONS,
  applyPatch,
  resolveDesktopOpenEnv
} from "../../plugins/codex/scripts/lib/desktop-ipc.mjs";
import { interruptAppServerTurn, runDesktopTurn } from "../../plugins/codex/scripts/lib/codex.mjs";
import { resolveTaskBackend } from "../../plugins/codex/scripts/codex-companion.mjs";

// A stand-in for the Codex desktop app's IPC router + the window that owns a thread.
// It speaks the real framing (u32 LE length + JSON) over a real Unix socket and records
// every message it receives, so the tests assert on what the plugin put on the wire.
async function startFakeDesktop(t, options = {}) {
  const threadId = options.threadId ?? "01a10058-4d2f-7831-80d8-b7fc7c560388";
  const wire = [];
  const sockets = new Set();
  const followers = new Set();
  const fake = {
    threadId,
    wire,
    owned: options.owned ?? true,
    turnScript: options.turnScript ?? "complete",
    mismatch: new Set(options.mismatch ?? []),
    revision: 0,
    state: {
      title: "fake",
      threadRuntimeStatus: { type: "idle" },
      requests: [],
      turnHistory: { history: { entitiesByKey: {} } }
    },
    requests: (method) => wire.filter((m) => m.type === "request" && m.method === method),
    broadcasts: (method) => wire.filter((m) => m.type === "broadcast" && m.method === method)
  };

  const send = (socket, message) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([header, body]));
  };
  const stateBroadcast = (change) => {
    for (const socket of followers) {
      send(socket, { type: "broadcast", method: "thread-stream-state-changed", params: { conversationId: threadId, hostId: "local", change } });
    }
  };
  const snapshot = () => {
    fake.revision += 1;
    stateBroadcast({ type: "snapshot", revision: fake.revision, conversationState: structuredClone(fake.state) });
  };
  fake.patch = (patches, { baseRevision } = {}) => {
    const base = baseRevision ?? fake.revision;
    for (const p of patches) applyPatch(fake.state, structuredClone(p));
    fake.revision += 1;
    stateBroadcast({ type: "patches", baseRevision: base, revision: fake.revision, patches });
  };
  const entitiesPath = ["turnHistory", "history", "entitiesByKey"];

  const answer = (socket, message, result, error = null) =>
    send(socket, {
      type: "response",
      requestId: message.requestId,
      resultType: error ? "error" : "success",
      ...(error ? { error } : { method: message.method, result })
    });

  const handle = (socket, message) => {
    wire.push(message);
    if (message.type === "broadcast" && message.method === "thread-stream-following-changed") {
      if (message.params.following) followers.add(socket);
      return;
    }
    if (message.type !== "request") return;
    if (fake.mismatch.has(message.method)) {
      answer(socket, message, null, "request-version-mismatch");
      return;
    }
    switch (message.method) {
      case "initialize":
        answer(socket, message, { clientId: `client-${wire.length}` });
        return;
      case "thread-owner-discovery":
        // An unowned thread: the real router can sit on this for its 10 s discovery
        // timeout, so say nothing at all.
        if (fake.owned) answer(socket, message, { supportsUntrustedAppInput: true });
        return;
      case "thread-follower-load-complete-history":
        snapshot();
        answer(socket, message, { revision: fake.revision });
        return;
      case "thread-follower-start-turn": {
        const turnId = `turn-${fake.requests("thread-follower-start-turn").length}`;
        answer(socket, message, { result: { turn: { id: turnId, status: "inProgress" } } });
        const key = `tail:${turnId}`;
        setImmediate(() => {
          fake.patch([
            { op: "replace", path: ["threadRuntimeStatus"], value: { type: "active" } },
            { op: "add", path: [...entitiesPath, key], value: { turnId, status: "inProgress", items: [] } }
          ]);
          if (fake.turnScript === "approval") {
            fake.patch([{ op: "add", path: ["requests", "-"], value: { method: "item/commandExecution/requestApproval" } }]);
            return;
          }
          if (fake.turnScript === "gap") {
            // A patch whose base revision skips one: the follower must resync, not apply.
            fake.patch([{ op: "replace", path: ["title"], value: "drifted" }], { baseRevision: fake.revision + 5 });
          }
          fake.patch([
            {
              op: "add",
              path: [...entitiesPath, key, "items", "-"],
              value: { type: "commandExecution", id: "cmd-1", command: "echo hi", status: "completed", exitCode: 0 }
            },
            { op: "add", path: [...entitiesPath, key, "items", "-"], value: { type: "agentMessage", id: "msg-1", text: "DESKTOP-ANSWER" } },
            { op: "replace", path: [...entitiesPath, key, "status"], value: "completed" },
            { op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } }
          ]);
        });
        return;
      }
      case "thread-follower-interrupt-turn":
        answer(socket, message, { interruptedTurnId: message.params.expectedTurnId ?? "turn-x", ok: true });
        return;
      default:
        answer(socket, message, null, "no-handler-for-request");
    }
  };

  const socketPath = path.join(makeTempDir("codex-desktop-ipc-"), "ipc.sock");
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) break;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        handle(socket, message);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      followers.delete(socket);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  fake.socketPath = socketPath;
  fake.attachOptions = { socketPath, ownerDiscoveryTimeoutMs: 100, pollMs: 10, openTimeoutMs: 2_000 };
  return fake;
}

test("a desktop turn puts the prompt on the wire, inherits the thread's settings, and maps the result", async (t) => {
  const fake = await startFakeDesktop(t);
  const progress = [];
  const result = await runDesktopTurn("/ws", {
    resumeThreadId: fake.threadId,
    prompt: "do the thing",
    model: "gpt-6.1-sol",
    effort: "xhigh",
    onProgress: (update) => progress.push(typeof update === "string" ? update : update.message),
    desktopDeps: { attachOptions: fake.attachOptions }
  });

  const [start] = fake.requests("thread-follower-start-turn");
  assert.equal(start.version, METHOD_VERSIONS["thread-follower-start-turn"]);
  assert.equal(start.params.conversationId, fake.threadId);
  assert.deepEqual(start.params.turnStart.context, { inheritThreadSettings: true });
  const request = start.params.turnStart.request;
  assert.equal(request.threadId, fake.threadId);
  assert.deepEqual(request.input, [{ type: "text", text: "do the thing", text_elements: [] }]);
  assert.equal(request.model, "gpt-6.1-sol");
  assert.equal(request.effort, "xhigh");

  assert.equal(result.status, 0);
  assert.equal(result.backend, "desktop");
  assert.equal(result.threadId, fake.threadId);
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.finalMessage, "DESKTOP-ANSWER");
  assert.deepEqual(result.commandExecutions.map((item) => item.command), ["echo hi"]);
  assert.ok(progress.some((line) => /Command completed: echo hi/.test(line)), progress.join("\n"));
  assert.equal(fake.broadcasts("thread-stream-following-changed")[0].params.following, true);
});

test("a fresh desktop task makes its thread with a CLI bootstrap turn off the shared broker", async (t) => {
  const fake = await startFakeDesktop(t);
  const bootstrapCalls = [];
  const result = await runDesktopTurn("/ws", {
    prompt: "real task",
    threadName: "named",
    desktopDeps: {
      attachOptions: fake.attachOptions,
      runBootstrapTurn: async (_cwd, options) => {
        bootstrapCalls.push(options);
        return { status: 0, threadId: fake.threadId };
      }
    }
  });
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].disableBroker, true, "a broker would keep the thread's writer lock and the app could not load it");
  assert.equal(bootstrapCalls[0].persistThread, true);
  assert.equal(fake.requests("thread-follower-start-turn")[0].params.turnStart.request.input[0].text, "real task");
  assert.equal(result.status, 0);
});

test("a thread the app has not loaded is opened by deep link, then followed", async (t) => {
  const fake = await startFakeDesktop(t, { owned: false });
  const opened = [];
  const thread = await DesktopThread.attach(fake.threadId, {
    ...fake.attachOptions,
    openThread: async (threadId) => {
      opened.push(threadId);
      fake.owned = true;
    }
  });
  try {
    assert.deepEqual(opened, [fake.threadId]);
    assert.equal(thread.runtimeStatus(), "idle");
  } finally {
    thread.close();
  }
});

test("attach without permission to open fails instead of opening a tab", async (t) => {
  const fake = await startFakeDesktop(t, { owned: false });
  await assert.rejects(
    DesktopThread.attach(fake.threadId, { ...fake.attachOptions, openIfNeeded: false, openThread: async () => assert.fail("must not open") }),
    (error) => error.code === "NO_OWNER"
  );
});

test("a turn blocked on an approval fails fast and leaves the turn running in the app", async (t) => {
  const fake = await startFakeDesktop(t, { turnScript: "approval" });
  const result = await runDesktopTurn("/ws", {
    resumeThreadId: fake.threadId,
    prompt: "needs approval",
    desktopDeps: { attachOptions: fake.attachOptions }
  });
  assert.equal(result.status, 1);
  assert.match(result.finalMessage, /waiting for item\/commandExecution\/requestApproval/);
  assert.match(result.finalMessage, /--thread 01a10058/);
  assert.equal(fake.requests("thread-follower-interrupt-turn").length, 0, "the user approves in the app; we must not kill the turn");
});

test("a patch that skips a revision triggers a resync instead of being applied", async (t) => {
  const fake = await startFakeDesktop(t, { turnScript: "gap" });
  const result = await runDesktopTurn("/ws", {
    resumeThreadId: fake.threadId,
    prompt: "gap",
    desktopDeps: { attachOptions: fake.attachOptions }
  });
  assert.equal(result.finalMessage, "DESKTOP-ANSWER");
  assert.ok(fake.requests("thread-follower-load-complete-history").length >= 2, "expected a reload after the revision gap");
});

test("a protocol version the installed app rejects is reported as a version mismatch", async (t) => {
  const fake = await startFakeDesktop(t, { mismatch: ["thread-follower-start-turn"] });
  await assert.rejects(
    runDesktopTurn("/ws", { resumeThreadId: fake.threadId, prompt: "x", desktopDeps: { attachOptions: fake.attachOptions } }),
    (error) => error.code === "VERSION_MISMATCH" && /--backend cli/.test(error.message)
  );
});

test("a desktop interrupt goes to the app with the expected turn and never needs a broker", async (t) => {
  const fake = await startFakeDesktop(t);
  process.env.CODEX_DESKTOP_IPC_SOCKET = fake.socketPath;
  t.after(() => delete process.env.CODEX_DESKTOP_IPC_SOCKET);
  // makeTempDir has no broker session: the app-server path would bail out with
  // "no shared Codex broker session" — the desktop path must not even look.
  const outcome = await interruptAppServerTurn(makeTempDir(), { threadId: fake.threadId, turnId: "turn-7", backend: "desktop" });
  assert.equal(outcome.interrupted, true, outcome.detail);
  assert.equal(outcome.transport, "desktop");
  const [interrupt] = fake.requests("thread-follower-interrupt-turn");
  assert.deepEqual(interrupt.params, { conversationId: fake.threadId, mode: "user-stop", expectedTurnId: "turn-7" });
  assert.equal(interrupt.version, METHOD_VERSIONS["thread-follower-interrupt-turn"]);
});

test("the client answers the router's discovery probes so it never stalls other clients", async (t) => {
  const fake = await startFakeDesktop(t);
  const client = await DesktopIpcClient.connect({ socketPath: fake.socketPath });
  t.after(() => client.close());
  const replies = [];
  // Drive the client directly with a router-side probe and a foreign request.
  client.write = ((original) => (message) => {
    replies.push(message);
    return original.call(client, message);
  })(client.write);
  client.handleMessage({ type: "client-discovery-request", requestId: "probe-1", request: { method: "ide-context" } });
  client.handleMessage({ type: "request", requestId: "req-1", method: "ide-context" });
  assert.deepEqual(replies, [
    { type: "client-discovery-response", requestId: "probe-1", response: { canHandle: false } },
    { type: "response", requestId: "req-1", resultType: "error", error: "no-handler-for-request" }
  ]);
});

test("applyPatch follows the desktop's array-path JSON patches", () => {
  const doc = { a: { list: [1, 2] }, gone: true };
  applyPatch(doc, { op: "add", path: ["a", "list", "-"], value: 3 });
  applyPatch(doc, { op: "replace", path: ["a", "list", 0], value: 9 });
  applyPatch(doc, { op: "remove", path: ["a", "list", "1"] });
  applyPatch(doc, { op: "remove", path: ["gone"] });
  applyPatch(doc, { op: "add", path: ["b"], value: { c: 1 } });
  assert.deepEqual(doc, { a: { list: [9, 3] }, b: { c: 1 } });
  assert.throws(() => applyPatch(doc, { op: "add", path: ["missing", "x"], value: 1 }), (error) => error.code === "PATCH");
});

test("over SSH, xdg-open borrows the graphical session's DISPLAY from the user's own processes", () => {
  const procDir = makeTempDir("fake-proc-");
  const uid = process.getuid();
  fs.mkdirSync(path.join(procDir, "100"));
  fs.writeFileSync(path.join(procDir, "100", "environ"), "PATH=/bin\0HOME=/h\0");
  fs.mkdirSync(path.join(procDir, "200"));
  fs.writeFileSync(path.join(procDir, "200", "environ"), "DISPLAY=:1\0XAUTHORITY=/run/user/1000/gdm/Xauthority\0OTHER=x\0");
  fs.mkdirSync(path.join(procDir, "self"));

  const env = resolveDesktopOpenEnv({ PATH: "/usr/bin" }, { procDir, uid });
  assert.equal(env.DISPLAY, ":1");
  assert.equal(env.XAUTHORITY, "/run/user/1000/gdm/Xauthority");
  assert.equal(env.OTHER, undefined, "only the display variables are borrowed");
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${uid}/bus`);

  const local = resolveDesktopOpenEnv({ DISPLAY: ":0" }, { procDir, uid });
  assert.equal(local.DISPLAY, ":0", "a session that already has a display keeps it");
});

test("backend routing: cli stays cli, desktop needs the app, auto follows thread ownership", async () => {
  const unreachable = { probeDesktop: async () => ({ available: false, detail: "Codex desktop app is not running." }) };
  assert.equal(await resolveTaskBackend("cli", "t-1", { probeDesktop: async () => assert.fail("cli must not probe") }), "cli");
  await assert.rejects(resolveTaskBackend("desktop", null, unreachable), /not running\. Start the Codex desktop app, or use --backend cli\./);
  assert.equal(await resolveTaskBackend("desktop", null, { probeDesktop: async () => ({ available: true }) }), "desktop");

  const owned = new Set(["t-desktop"]);
  const deps = { isThreadOwnedByDesktop: async (id) => owned.has(id) };
  assert.equal(await resolveTaskBackend("auto", "t-desktop", deps), "desktop");
  assert.equal(await resolveTaskBackend("auto", "t-cli", deps), "cli");
  assert.equal(
    await resolveTaskBackend(undefined, null, { isThreadOwnedByDesktop: async () => assert.fail("a new task must not probe") }),
    "cli",
    "a new task with no backend named keeps today's CLI path"
  );
  await assert.rejects(resolveTaskBackend("gui", null), /Unknown --backend gui/);
});
