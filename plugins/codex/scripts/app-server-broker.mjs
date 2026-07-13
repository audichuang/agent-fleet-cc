#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { createIdleTracker } from "./lib/idle-shutdown.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 5000;

function resolveBrokerIdleTimeoutMs(env = process.env) {
  const value = Number(env.CODEX_BROKER_IDLE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_BROKER_IDLE_TIMEOUT_MS;
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  let shuttingDown = false;
  let shutdownPromise = null;
  // Idempotent AND shared: the app-server-death, idle-reaper, SIGTERM and
  // broker/shutdown paths can race. Return ONE cached teardown promise so every
  // caller awaits the SAME teardown to completion — a second caller must not
  // return early and let its process.exit() preempt the first caller's
  // server.close()/unlink (leaking the endpoint/pid files). Sockets are
  // destroyed (not end()) so a backpressured / non-reading peer cannot make
  // server.close() hang; the worker's client sees the reset as a socket close.
  function shutdown(server) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await appClient.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
        fs.unlinkSync(listenTarget.path);
      }
      if (pidFile && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    })();
    return shutdownPromise;
  }

  appClient.setNotificationHandler(routeNotification);

  let idleTracker = null;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    idleTracker?.connect();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          if (shouldRefuseBrokerShutdown(activeStreamSocket, activeRequestSocket, socket)) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(
                BROKER_BUSY_RPC_CODE,
                "Shared Codex broker is busy serving another client; shutdown refused."
              )
            });
            continue;
          }
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      // 'close' is emitted after 'error' too, so counting it here (and not in
      // the error handler) avoids double-decrementing the idle tracker.
      idleTracker?.disconnect();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  // If the underlying codex app-server process dies (crash / OOM / panic) while
  // the broker Node parent survives, the broker can no longer serve any turn —
  // yet its listen socket and every client socket stay open and silent. An
  // in-flight worker blocked on `await state.completion` would then hang until
  // the 1-hour job hard cap, because its transport watchdog only fires on a
  // socket close (a live-but-silent socket triggers neither 'error' nor
  // 'close'). Tear the broker down the moment the app-server exits: shutdown()
  // ends every client socket, so each worker's BrokerCodexAppServerClient sees
  // 'close' -> its exitPromise resolves -> captureTurn's transportWatchdog
  // reaches a terminal state in seconds instead of ~48 minutes. Exit nonzero to
  // mark the abnormal death.
  wireAppServerDeathTeardown(appClient, async () => {
    // An INTENTIONAL shutdown (idle reaper / SIGTERM / broker/shutdown) closes
    // appClient itself, which ALSO resolves appClient.exitPromise — that is not an
    // app-server *death*, and that path already owns teardown + exit. Only act when
    // no shutdown is already in progress, i.e. the app-server exited on its own.
    if (shuttingDown) {
      return;
    }
    await shutdown(server).catch(() => {});
    process.exit(1);
  });

  // Auto-exit when no client has been connected for the idle window, so stale
  // brokers (and the Codex app-server they own, killed by appClient.close in
  // shutdown) do not accumulate across sessions.
  idleTracker = createIdleTracker({
    timeoutMs: resolveBrokerIdleTimeoutMs(),
    onIdle: async () => {
      await shutdown(server);
      process.exit(0);
    }
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path, () => {
    // Arm immediately so a broker that is spawned but never used (orphaned
    // launch) also exits instead of lingering forever.
    idleTracker.idleStart();
  });
}

// Decide whether a broker/shutdown request must be refused. The shared broker
// is per-workspace, so an unconditional shutdown from one client would tear
// down a turn another client is still streaming. Refuse while a DIFFERENT
// socket owns the active stream or request; allow when idle or when the
// requester itself is the active owner.
export function shouldRefuseBrokerShutdown(activeStreamSocket, activeRequestSocket, requestingSocket) {
  return Boolean(
    (activeStreamSocket && activeStreamSocket !== requestingSocket) ||
      (activeRequestSocket && activeRequestSocket !== requestingSocket)
  );
}

// Run `onDeath` when the broker's underlying codex app-server exits. Extracted as
// a seam so the "app-server death -> broker teardown" wiring (which unblocks any
// worker wedged on an in-flight turn) has a regression test — the broker main()
// loop is otherwise only reachable by spawning a real app-server. Returns the
// promise so tests can await it.
export function wireAppServerDeathTeardown(appClient, onDeath) {
  return appClient.exitPromise.then(onDeath);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
