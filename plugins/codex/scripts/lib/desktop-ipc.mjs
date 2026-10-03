// Drives a thread inside the Codex desktop app (ChatGPT.app on macOS, /usr/lib/chatgpt on
// Linux) through the app's private IPC router at $CODEX_HOME/ipc/ipc.sock.
//
// This is NOT the app-server JSON-RPC that lib/app-server.mjs speaks. The router relays
// requests between registered clients; the desktop window that has a thread loaded is
// that thread's "owner" and answers `thread-follower-*` requests for it. A follower gets a
// snapshot of the conversation state and then JSON-patch updates as the turn streams.
//
// Source anchor for the wire shapes and versions below: the desktop bundle's IPC client
// (app.asar — `class IpcClient`, `requestThreadFollower`, the per-method version map that
// starts `{"thread-stream-state-changed":…`) and ../codex codex-rs/tui/src/ide_context/ipc.rs
// (framing). The versions are a contract with one desktop build, not a catalog: a request
// the installed app no longer accepts comes back `request-version-mismatch`, which
// DesktopIpcError surfaces as such instead of as a generic failure.
//
// Windows uses a named pipe and is not supported here.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const DESKTOP_SOCKET_ENV = "CODEX_DESKTOP_IPC_SOCKET";

export const METHOD_VERSIONS = Object.freeze({
  initialize: 0,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-load-complete-history": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-stream-following-changed": 1,
  "thread-stream-state-changed": 11
});

// A thread with no owner can take the router's full client-discovery timeout (10 s,
// measured on macOS) to come back negative, while a loaded thread answers in
// milliseconds. Treat silence past this as "not loaded".
export const OWNER_DISCOVERY_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const START_TURN_TIMEOUT_MS = 60_000;
const OPEN_THREAD_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export class DesktopIpcError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = "DesktopIpcError";
    this.code = code;
  }
}

function describeRouterError(method, error) {
  if (error === "request-version-mismatch") {
    return new DesktopIpcError(
      `The Codex desktop app rejected '${method}' as a protocol version mismatch. The installed app speaks a different IPC version than this plugin; use --backend cli.`,
      "VERSION_MISMATCH"
    );
  }
  if (typeof error === "string" && error.startsWith("no-client-found")) {
    return new DesktopIpcError(`The Codex desktop app has no window that owns this thread (${error}).`, "NO_OWNER");
  }
  return new DesktopIpcError(`Codex desktop '${method}' failed: ${error ?? "unknown error"}`, "REQUEST_FAILED");
}

export function resolveDesktopSocketPath(env = process.env) {
  if (env[DESKTOP_SOCKET_ENV]) {
    return env[DESKTOP_SOCKET_ENV];
  }
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "ipc", "ipc.sock");
}

export function isDesktopSupportedPlatform(platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

export class DesktopIpcClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.clientId = "initializing-client";
    this.pending = new Map();
    this.broadcastHandlers = new Set();
    this.closed = false;
    this.closeError = null;
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.handleClose(error));
    socket.on("close", () => this.handleClose(null));
  }

  /** @param {{ socketPath?: string, env?: NodeJS.ProcessEnv, clientType?: string }} [options] */
  static async connect({ socketPath, env = process.env, clientType = "codex-companion" } = {}) {
    const target = socketPath ?? resolveDesktopSocketPath(env);
    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection({ path: target });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    }).catch((error) => {
      throw new DesktopIpcError(`Codex desktop app is not reachable at ${target} (${error.code ?? error.message}).`, "UNAVAILABLE");
    });
    const client = new DesktopIpcClient(socket);
    const response = await client.request("initialize", { clientType });
    client.clientId = response.result?.clientId ?? client.clientId;
    return client;
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.socket.destroy(new DesktopIpcError(`Codex desktop IPC frame of ${length} bytes exceeds the limit.`, "PROTOCOL"));
        return;
      }
      if (this.buffer.length < 4 + length) {
        return;
      }
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case "response": {
        const entry = this.pending.get(message.requestId);
        if (entry) {
          this.pending.delete(message.requestId);
          clearTimeout(entry.timer);
          entry.resolve(message);
        }
        return;
      }
      case "broadcast":
        for (const handler of this.broadcastHandlers) {
          handler(message);
        }
        return;
      // The router asks every client whether it can serve other clients' requests.
      // We serve none; answering promptly keeps the router from waiting on us.
      case "client-discovery-request":
        this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
        return;
      case "request":
        this.write({ type: "response", requestId: message.requestId, resultType: "error", error: "no-handler-for-request" });
        return;
      default:
    }
  }

  handleClose(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    const reason = new DesktopIpcError(
      `Codex desktop IPC connection closed${error ? `: ${error.message}` : ""}.`,
      "DISCONNECTED"
    );
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.pending.delete(id);
    }
    for (const handler of this.broadcastHandlers) {
      handler({ type: "connection-closed", error: reason });
    }
  }

  write(message) {
    if (this.closed) {
      throw new DesktopIpcError("Codex desktop IPC connection is closed.", "DISCONNECTED");
    }
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    this.socket.write(Buffer.concat([header, payload]));
  }

  request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new DesktopIpcError(`Codex desktop '${method}' got no answer within ${timeoutMs} ms.`, "TIMEOUT");
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.write({
          type: "request",
          requestId,
          sourceClientId: this.clientId,
          version: METHOD_VERSIONS[method] ?? 0,
          method,
          params,
          timeoutMs
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async call(method, params, options) {
    const response = await this.request(method, params, options);
    if (response.resultType !== "success") {
      throw describeRouterError(method, response.error);
    }
    return response;
  }

  broadcast(method, params) {
    this.write({ type: "broadcast", method, sourceClientId: this.clientId, version: METHOD_VERSIONS[method] ?? 0, params });
  }

  onBroadcast(handler) {
    this.broadcastHandlers.add(handler);
    return () => this.broadcastHandlers.delete(handler);
  }

  close() {
    if (!this.closed) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

// RFC 6902 subset, with the path already split into segments (that is how the desktop
// sends it). Only add/replace/remove appear on the wire.
export function applyPatch(document, patch) {
  const segments = patch.path;
  if (!Array.isArray(segments) || segments.length === 0) {
    return patch.op === "remove" ? undefined : patch.value;
  }
  let cursor = document;
  for (const segment of segments.slice(0, -1)) {
    cursor = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment];
    if (cursor == null) {
      throw new DesktopIpcError(`Patch path ${JSON.stringify(segments)} does not exist in the snapshot.`, "PATCH");
    }
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) {
    const index = last === "-" ? cursor.length : Number(last);
    if (patch.op === "add") cursor.splice(index, 0, patch.value);
    else if (patch.op === "replace") cursor[index] = patch.value;
    else if (patch.op === "remove") cursor.splice(index, 1);
  } else if (patch.op === "add" || patch.op === "replace") {
    cursor[last] = patch.value;
  } else if (patch.op === "remove") {
    delete cursor[last];
  }
  return document;
}

// Over SSH a Linux shell has no DISPLAY; xdg-open then cannot reach the running app.
// Borrow the graphical session's variables from one of this user's own processes.
export function resolveDesktopOpenEnv(env = process.env, { procDir = "/proc", uid = process.getuid?.() } = {}) {
  const result = { ...env };
  if (!result.DISPLAY && !result.WAYLAND_DISPLAY) {
    let entries = [];
    try {
      entries = fs.readdirSync(procDir).filter((name) => /^\d+$/.test(name));
    } catch {
      entries = [];
    }
    for (const pid of entries) {
      let environ;
      try {
        if (uid != null && fs.statSync(path.join(procDir, pid)).uid !== uid) continue;
        environ = fs.readFileSync(path.join(procDir, pid, "environ"), "utf8");
      } catch {
        continue;
      }
      const vars = Object.fromEntries(
        environ.split("\0").filter((kv) => kv.includes("=")).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])
      );
      if (vars.DISPLAY || vars.WAYLAND_DISPLAY) {
        for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"]) {
          if (vars[key]) result[key] = vars[key];
        }
        break;
      }
    }
  }
  if (!result.DBUS_SESSION_BUS_ADDRESS && uid != null) {
    result.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  }
  return result;
}

export function openDesktopThread(threadId, { platform = process.platform, env = process.env, spawnImpl = spawn } = {}) {
  const url = `codex://threads/${encodeURIComponent(threadId)}`;
  const [command, childEnv] =
    platform === "darwin" ? ["open", env] : platform === "linux" ? ["xdg-open", resolveDesktopOpenEnv(env)] : [null, env];
  if (!command) {
    throw new DesktopIpcError(`Opening a Codex desktop thread is not supported on ${platform}.`, "UNSUPPORTED");
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [url], { env: childEnv, stdio: "ignore" });
    child.once("error", (error) => reject(new DesktopIpcError(`${command} ${url} failed: ${error.message}`, "OPEN_FAILED")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new DesktopIpcError(`${command} ${url} exited with ${code}.`, "OPEN_FAILED"))
    );
  });
}

export function summarizeTurn(entity) {
  const items = entity?.items ?? [];
  const agentMessages = items.filter((item) => item.type === "agentMessage").map((item) => item.text ?? "");
  return {
    turnId: entity?.turnId ?? null,
    status: entity?.status ?? null,
    error: entity?.error ?? null,
    userText: items
      .filter((item) => item.type === "userMessage")
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
    agentMessages,
    finalMessage: agentMessages.length ? agentMessages[agentMessages.length - 1] : "",
    items
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A follower view of one conversation: the desktop's snapshot plus every patch since.
export class DesktopThread {
  constructor(client, threadId, { ownerDiscoveryTimeoutMs = OWNER_DISCOVERY_TIMEOUT_MS } = {}) {
    this.client = client;
    this.threadId = threadId;
    this.ownerDiscoveryTimeoutMs = ownerDiscoveryTimeoutMs;
    this.state = null;
    this.revision = null;
    this.waiters = new Set();
    this.disconnect = null;
    this.unsubscribe = client.onBroadcast((message) => this.handleBroadcast(message));
  }

  static async attach(threadId, options = {}) {
    const client = options.client ?? (await DesktopIpcClient.connect(options));
    const thread = new DesktopThread(client, threadId, options);
    try {
      if (!(await thread.isOwned())) {
        if (options.openIfNeeded === false) {
          throw new DesktopIpcError(`Thread ${threadId} is not open in the Codex desktop app.`, "NO_OWNER");
        }
        options.onOpen?.(threadId);
        await (options.openThread ?? openDesktopThread)(threadId, options);
        const deadline = Date.now() + (options.openTimeoutMs ?? OPEN_THREAD_TIMEOUT_MS);
        while (!(await thread.isOwned())) {
          if (Date.now() > deadline) {
            throw new DesktopIpcError(
              `The Codex desktop app did not load thread ${threadId}. If a Codex CLI process still has it open (an "active writer"), wait for that run to end and retry.`,
              "OPEN_TIMEOUT"
            );
          }
          await (options.sleep ?? sleep)(options.pollMs ?? 500);
        }
      }
      client.broadcast("thread-stream-following-changed", { conversationId: threadId, hostId: "local", following: true });
      await thread.reload(options);
      return thread;
    } catch (error) {
      thread.close();
      throw error;
    }
  }

  async isOwned() {
    try {
      const response = await this.client.request(
        "thread-owner-discovery",
        { hostId: "local", conversationId: this.threadId },
        { timeoutMs: this.ownerDiscoveryTimeoutMs }
      );
      return response.resultType === "success";
    } catch (error) {
      if (error.code === "TIMEOUT") return false;
      throw error;
    }
  }

  async reload(options = {}) {
    const response = await this.client.call("thread-follower-load-complete-history", { conversationId: this.threadId });
    const revision = response.result?.revision ?? 0;
    await this.waitFor(() => this.state != null && this.revision >= revision, options.snapshotTimeoutMs ?? 10_000, "snapshot");
  }

  handleBroadcast(message) {
    if (message.type === "connection-closed") {
      this.disconnect = message.error;
    } else if (message.method === "thread-stream-state-changed" && message.params?.conversationId === this.threadId) {
      const change = message.params.change ?? {};
      if (change.type === "snapshot") {
        this.state = change.conversationState;
        this.revision = change.revision;
      } else if (change.type === "patches" && this.state != null) {
        if (change.baseRevision !== this.revision) {
          // We missed an update; ask for a fresh snapshot rather than apply onto drift.
          this.state = null;
          this.client.call("thread-follower-load-complete-history", { conversationId: this.threadId }).catch(() => {});
        } else {
          for (const patch of change.patches ?? []) {
            this.state = applyPatch(this.state, patch);
          }
          this.revision = change.revision;
        }
      }
    }
    for (const waiter of this.waiters) {
      waiter();
    }
  }

  waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.disconnect) {
          finish(this.disconnect);
          return;
        }
        let ok = false;
        try {
          ok = predicate();
        } catch (error) {
          finish(error);
          return;
        }
        if (ok) finish(null);
      };
      const timer =
        timeoutMs > 0
          ? setTimeout(
              () => finish(new DesktopIpcError(`Timed out after ${timeoutMs} ms waiting for the Codex desktop ${label}.`, "TIMEOUT")),
              timeoutMs
            )
          : null;
      timer?.unref?.();
      const finish = (error) => {
        this.waiters.delete(check);
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      this.waiters.add(check);
      check();
    });
  }

  turns() {
    const entities = this.state?.turnHistory?.history?.entitiesByKey ?? {};
    return Object.values(entities).map(summarizeTurn);
  }

  turn(turnId) {
    return this.turns().find((turn) => turn.turnId === turnId) ?? null;
  }

  runtimeStatus() {
    return this.state?.threadRuntimeStatus?.type ?? null;
  }

  pendingRequests() {
    return Array.isArray(this.state?.requests) ? this.state.requests : [];
  }

  async startTurn(prompt, { model = null, effort = null } = {}) {
    const request = {
      threadId: this.threadId,
      turnTrigger: "composer",
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: prompt, text_elements: [] }]
    };
    if (model) request.model = model;
    if (effort) request.effort = effort;
    const response = await this.client.call(
      "thread-follower-start-turn",
      { conversationId: this.threadId, turnStart: { request, context: { inheritThreadSettings: true } } },
      { timeoutMs: START_TURN_TIMEOUT_MS }
    );
    const turnId = response.result?.result?.turn?.id;
    if (!turnId) {
      throw new DesktopIpcError("Codex desktop accepted the turn but returned no turn id.", "PROTOCOL");
    }
    return turnId;
  }

  async interrupt(turnId = null) {
    const params = { conversationId: this.threadId, mode: "user-stop" };
    if (turnId) params.expectedTurnId = turnId;
    const response = await this.client.call("thread-follower-interrupt-turn", params);
    return response.result ?? {};
  }

  close() {
    this.unsubscribe?.();
    this.client.close();
  }
}

/** @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, socketPath?: string }} [options] */
export async function probeDesktop({ env = process.env, platform = process.platform, socketPath } = {}) {
  if (!isDesktopSupportedPlatform(platform)) {
    return { available: false, detail: `Codex desktop backend is not supported on ${platform}.` };
  }
  const target = socketPath ?? resolveDesktopSocketPath(env);
  if (!fs.existsSync(target)) {
    return { available: false, detail: `Codex desktop app is not running (no IPC socket at ${target}).` };
  }
  try {
    const client = await DesktopIpcClient.connect({ socketPath: target, clientType: "codex-companion-probe" });
    client.close();
    return { available: true, detail: `Codex desktop app reachable at ${target}.` };
  } catch (error) {
    return { available: false, detail: error.message };
  }
}

// Does the desktop app currently own (have loaded) this thread? Never opens anything.
export async function isThreadOwnedByDesktop(threadId, options = {}) {
  if (!threadId) return false;
  let client = null;
  try {
    client = await DesktopIpcClient.connect(options);
    const thread = new DesktopThread(client, threadId, options);
    return await thread.isOwned();
  } catch {
    return false;
  } finally {
    client?.close();
  }
}
