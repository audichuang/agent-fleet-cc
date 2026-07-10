#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { clearBrokerSession, loadBrokerSession } from "./lib/broker-lifecycle.mjs";
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
  let shuttingDown = false;
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

  async function shutdown(server) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    // Clear our own session record so `reuseExistingBroker` and status reads
    // don't resolve to a dead endpoint. Match-guarded on the endpoint so a newer
    // broker that already claimed this workspace's slot is never clobbered.
    try {
      if (loadBrokerSession(cwd)?.endpoint === endpoint) {
        clearBrokerSession(cwd);
      }
    } catch {
      // best-effort — a missing/again-racing record must not crash teardown
    }
  }

  appClient.setNotificationHandler(routeNotification);

  // If the upstream codex app-server dies on its own, drop every client socket
  // so streaming turns fail fast instead of hanging, then tear down and exit.
  attachUpstreamExitHandler({
    exitPromise: appClient.exitPromise,
    sockets,
    shutdown: () => shutdown(server),
    isShuttingDown: () => shuttingDown,
    onExit: () => process.exit(1),
    log: () => {
      const reason = appClient.exitError?.message ?? "(no error detail)";
      const stderrTail = (appClient.stderr ?? "").trim().slice(-500);
      process.stderr.write(
        `[codex-broker] upstream app-server exited; failing active clients. reason=${reason}${
          stderrTail ? ` stderr=${stderrTail}` : ""
        }\n`
      );
    },
    emitTerminal: () => {
      // Only a client mid-stream is waiting on a turn/completed that will never
      // arrive; a plain request socket already got (or will get) its rejection.
      if (!activeStreamSocket || !activeStreamThreadIds) {
        return;
      }
      const reason = appClient.exitError?.message ?? "the codex app-server exited before the turn completed";
      for (const threadId of activeStreamThreadIds) {
        // Shape mirrors codex's ErrorNotification: willRetry:false is what
        // captureTurn treats as a terminal, thread-scoped failure. turnId is
        // omitted — the client falls back to its own tracked turn id.
        send(activeStreamSocket, {
          method: "error",
          params: { error: { message: `Codex app-server disconnected: ${reason}` }, willRetry: false, threadId }
        });
      }
    }
  });

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

// Propagate an upstream death to connected clients. The broker relays a turn's
// completion as NOTIFICATIONS streamed from the app-server; a client that
// already received its turn/start ACK is not waiting on any request the
// appClient exit could reject. So if the upstream codex app-server dies on its
// own (crash, panic, daemon idle-shutdown, self-update restart), the client
// socket stays open and turn/completed never arrives — the turn hangs silently
// (client transport watchdog only fires on ITS socket closing; the per-turn idle
// watchdog is off by default). Dropping every client socket makes each client's
// transport watchdog fire a terminal error instead. A dead upstream makes the
// broker useless, so we then tear down and exit; the next run spawns a fresh
// broker + app-server. Guarded by isShuttingDown so our OWN close() (idle /
// SIGTERM / broker/shutdown) does not re-enter this teardown.
export function attachUpstreamExitHandler({ exitPromise, sockets, shutdown, isShuttingDown, onExit, log, emitTerminal }) {
  return exitPromise.then(async () => {
    if (isShuttingDown()) {
      return;
    }
    // Log the reason BEFORE teardown — "the broker exited 1" with no cause is
    // exactly the blind spot this whole fix is about. Best-effort.
    try {
      log?.();
    } catch {
      // never let diagnostics block the teardown that unblocks the client
    }
    // Best-effort: hand the streaming client a clean, attributable `failed`
    // terminal (a willRetry:false error) so its turn resolves as failed with a
    // real reason instead of only a generic transport disconnect. Purely an
    // upgrade to the message — the guaranteed unblock is the destroy below, so
    // if this write races the teardown the client still terminates via its
    // transport watchdog. Never let it block that guarantee.
    try {
      emitTerminal?.();
    } catch {
      // best-effort — the destroy below is the real terminal guarantee
    }
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // best-effort — one wedged socket must not block dropping the rest
      }
    }
    await shutdown().catch(() => {});
    onExit();
  });
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
