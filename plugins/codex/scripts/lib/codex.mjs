/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   startedSideEffect: boolean,
 *   commandOutputBytes: number,
 *   lastCommandHeartbeatMs: number,
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

// Resolve the sandbox mode for a Codex thread. This fork HARDCODES the default to
// danger-full-access (skip bwrap) because its target hosts cannot start Codex's
// bwrap sandbox: nested sandboxes / restricted network namespaces (`unshare --net`
// -> EPERM) abort with "bwrap: loopback: Failed RTM_NEWADDR" before any command
// runs, and even "read-only" fails there. The per-thread requested mode (e.g.
// review's "read-only") is therefore intentionally IGNORED; isolation comes from
// the outer environment. CODEX_SANDBOX_MODE overrides the default on hosts where
// bwrap works (e.g. set it to "read-only"). An override that is not a known mode
// is rejected (warn + fall back) rather than forwarded verbatim to the app-server,
// which would otherwise fail thread/start with an opaque deserialization error.
export function resolveSandboxMode(_requested, options = {}) {
  const override = process.env.CODEX_SANDBOX_MODE?.trim();
  if (override) {
    if (VALID_SANDBOX_MODES.has(override)) {
      return /** @type {"read-only" | "workspace-write" | "danger-full-access"} */ (override);
    }
    const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
    warn(
      `[codex] Ignoring invalid CODEX_SANDBOX_MODE="${override}"; expected one of ${[...VALID_SANDBOX_MODES].join("|")}. Falling back to danger-full-access.`
    );
  }
  return "danger-full-access";
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: resolveSandboxMode(options.sandbox),
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: resolveSandboxMode(options.sandbox)
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

// Cap free-form notification text (plan explanation, warning/deprecation detail) so a
// verbose server message cannot flood the job log / progress line. Returns null for
// empty/non-string input so callers can fall back cleanly.
const MAX_NOTIFICATION_TEXT = 200;

// Throttle window for the command-output heartbeat (see the
// item/commandExecution/outputDelta handler). A single long command (e.g. a
// 15-min build/test) streams output continuously with no other handled
// notification between item/started and item/completed; we surface at most one
// liveness line per this window so /codex:logs and /codex:status are not dark
// for minutes while the command is actually alive.
const COMMAND_HEARTBEAT_INTERVAL_MS = 20_000;

function boundedNotificationText(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value.length > MAX_NOTIFICATION_TEXT ? `${value.slice(0, MAX_NOTIFICATION_TEXT)}…` : value;
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    // Set as soon as a command/file-change item is even STARTED (fileChanges/
    // commandExecutions only record COMPLETED items). The model-fallback retry guard
    // reads this so a turn that began mutating — but errored before item/completed —
    // is never re-run.
    startedSideEffect: false,
    // Command-output heartbeat throttle state (see the outputDelta handler).
    // -Infinity so the first delta always fires immediately under a monotonic
    // clock (performance.now() starts near 0, unlike Date.now()).
    commandOutputBytes: 0,
    lastCommandHeartbeatMs: -Infinity,
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

// A NARROW match for permanent authentication failures. Deliberately excludes
// transient/server conditions (429, 5xx, rate limit, overloaded, timeouts) so we
// never give up on something the app-server would have retried.
const PERMANENT_AUTH_ERROR = /\b401\b|\b403\b|missing bearer|invalid api key|unauthor|authentication failed|forbidden/i;

// Should an `error` notification terminate the turn? The protocol's willRetry flag
// is authoritative: false means the app-server will NOT retry, so the turn would
// otherwise hang with no turn/completed. When willRetry is absent (older protocol)
// fall back to the narrow permanent-auth regex. willRetry === true is never
// terminal — trust the server's retry.
export function isTerminalTurnError(params) {
  if (params?.willRetry === true) {
    return false;
  }
  if (params?.willRetry === false) {
    return true;
  }
  // willRetry absent (older protocol, or a malformed notification): a structured
  // `unauthorized` code is exact where the regex below only guesses.
  if (codexErrorCode(params?.error) === "unauthorized") {
    return true;
  }
  return PERMANENT_AUTH_ERROR.test(params?.error?.message ?? "");
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  // A command/file-change item existing at all (started OR completed) means the turn
  // began doing work — flag it so the model-fallback retry never re-runs a mutation.
  if (item.type === "commandExecution" || item.type === "fileChange") {
    state.startedSideEffect = true;
  }
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/commandExecution/outputDelta": {
      // A single long command (e.g. a 15-min build/test) emits no other handled
      // notification between item/started and item/completed, so /codex:logs and
      // /codex:status would go dark for minutes even though output is streaming
      // live on the wire. Surface a THROTTLED liveness heartbeat — never the raw
      // chunks (up to ~10KB/call; they would flood the log), only a running byte
      // count, mirroring the turn/diff handler which signals "it changed + size".
      // The emit also advances the job .log mtime, keeping the watchdog's quietMs
      // fresh so a long command cannot drift toward the hang threshold.
      const delta = typeof message.params?.delta === "string" ? message.params.delta : "";
      state.commandOutputBytes += Buffer.byteLength(delta, "utf8");
      // Monotonic clock: elapsed-time throttling must not be fooled by an NTP/VM
      // wall-clock rollback (Date.now() could then suppress heartbeats for the
      // rollback's duration). performance.now() only moves forward.
      const nowMs = performance.now();
      if (nowMs - state.lastCommandHeartbeatMs >= COMMAND_HEARTBEAT_INTERVAL_MS) {
        state.lastCommandHeartbeatMs = nowMs;
        emitProgress(
          state.onProgress,
          `Command output streaming (~${Math.round(state.commandOutputBytes / 1024)} KB so far).`,
          null
        );
      }
      break;
    }
    case "error": {
      // Guard every dereference: a protocol-malformed `error` notification can
      // arrive with params present but no `error` object. The handler runs inside
      // the stream `line`/`data` listener with no try/catch, so a raw
      // params.error.message deref would throw a TypeError that crashes the host
      // process rather than failing the turn.
      const errParams = message.params ?? {};
      const errObject = errParams.error ?? null;
      const errMessage = errObject?.message ?? "unknown error";
      // Only record a REAL error object. Don't fabricate a synthetic "unknown error"
      // for a malformed NON-terminal notification: the turn may still complete
      // normally, and a fabricated state.error would otherwise surface as the
      // failure message on an otherwise-successful no-output turn. The terminal
      // branch below installs a fallback Error only when it actually fails the turn.
      if (errObject) {
        state.error = errObject;
      }
      emitProgress(state.onProgress, `Codex error: ${errMessage}`, "failed");
      // A non-retryable error (e.g. permanent auth failure) may never be followed
      // by turn/completed, leaving the turn hung. Complete it as failed so the
      // companion reaches a terminal state instead of waiting out the hard cap.
      // Only the ROOT thread's error completes the turn — mirror the turn/completed
      // handling, where a subagent thread's terminal event must not fail the parent.
      if (isTerminalTurnError(errParams) && (errParams.threadId ?? null) === state.threadId) {
        // We are failing the turn: ensure a failure reason exists even when the
        // notification carried no error object (the no-output failure path reads
        // state.error?.message).
        if (!state.error) {
          state.error = new Error(errMessage);
        }
        const failedTurnId =
          state.threadTurnIds.get(state.threadId) ?? state.turnId ?? errParams.turnId ?? "error-turn";
        completeTurn(state, { id: failedTurnId, status: "failed" });
      }
      break;
    }
    case "turn/completed": {
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      // A2: schema-guard the terminal notification. A turn/completed for the root
      // thread means the turn ended; if its shape changed so we cannot read `turn`,
      // still CONVERGE (completeTurn synthesizes a completed turn from null) rather
      // than letting an unguarded `params.turn.status` deref throw — which the
      // dispatch guard would now swallow, leaving the turn to hang to the hard cap.
      const completedTurn = message.params.turn ?? null;
      const completedStatus = completedTurn?.status ?? null;
      emitProgress(
        state.onProgress,
        `Turn ${completedStatus && completedStatus !== "completed" ? completedStatus : "completed"}.`,
        "finalizing"
      );
      completeTurn(state, completedTurn);
      break;
    }
    // D: cost- and safety-relevant notifications this client does NOT opt out of (only
    // the high-frequency token deltas are). Surface each as a compact progress line so
    // the user is not blind to a model reroute, a guardian warning, token spend, the
    // plan, the working diff, or rate limits. Every field is read defensively — a
    // malformed notification must never throw out of this dispatch (see the `error` arm).
    case "model/rerouted": {
      const p = message.params ?? {};
      emitProgress(
        state.onProgress,
        `Model rerouted: ${p.fromModel ?? "?"} → ${p.toModel ?? "?"}${p.reason ? ` (${p.reason})` : ""}.`,
        null
      );
      break;
    }
    case "guardianWarning": {
      emitProgress(state.onProgress, `Guardian warning: ${boundedNotificationText(message.params?.message) ?? "(no detail)"}`, null);
      break;
    }
    case "thread/tokenUsage/updated": {
      const total = message.params?.tokenUsage?.total ?? {};
      emitProgress(
        state.onProgress,
        `Token usage: ${total.totalTokens ?? "?"} total (in ${total.inputTokens ?? "?"}, out ${total.outputTokens ?? "?"}).`,
        null
      );
      break;
    }
    case "turn/plan/updated": {
      const plan = Array.isArray(message.params?.plan) ? message.params.plan : [];
      const done = plan.filter((step) => step?.status === "completed").length;
      const explanation = boundedNotificationText(message.params?.explanation);
      emitProgress(
        state.onProgress,
        `Plan updated: ${done}/${plan.length} steps completed${explanation ? `. ${explanation}` : "."}`,
        null
      );
      break;
    }
    case "turn/diff/updated": {
      const diff = typeof message.params?.diff === "string" ? message.params.diff : "";
      // Never dump the raw diff into progress — just signal it changed and its size.
      const lineCount = diff ? diff.split("\n").length : 0;
      emitProgress(state.onProgress, `Working diff updated (${lineCount} lines).`, null);
      break;
    }
    case "account/rateLimits/updated": {
      const primary = message.params?.rateLimits?.primary ?? null;
      emitProgress(
        state.onProgress,
        `Rate limits updated${primary?.usedPercent != null ? `: primary ${primary.usedPercent}% used` : ""}.`,
        null
      );
      break;
    }
    case "warning": {
      emitProgress(state.onProgress, `Warning: ${boundedNotificationText(message.params?.message) ?? "(no detail)"}`, null);
      break;
    }
    case "configWarning": {
      const summary = boundedNotificationText(message.params?.summary) ?? "(no detail)";
      const path = message.params?.path;
      emitProgress(state.onProgress, `Config warning: ${summary}${path ? ` (${path})` : ""}`, null);
      break;
    }
    case "deprecationNotice": {
      emitProgress(state.onProgress, `Deprecation notice: ${boundedNotificationText(message.params?.summary) ?? "(no detail)"}`, null);
      break;
    }
    case "model/safetyBuffering/updated": {
      const p = message.params ?? {};
      const reasons = Array.isArray(p.reasons) ? p.reasons.join(", ") : "";
      emitProgress(
        state.onProgress,
        `Model safety buffering: ${p.model ?? "?"}${p.showBufferingUi ? " (buffering)" : ""}${reasons ? ` — ${reasons}` : ""}.`,
        null
      );
      break;
    }
    case "windows/worldWritableWarning": {
      const p = message.params ?? {};
      const count = Array.isArray(p.samplePaths) ? p.samplePaths.length + (Number(p.extraCount) || 0) : 0;
      emitProgress(
        state.onProgress,
        `World-writable files warning: ${count} path(s)${p.failedScan ? " (scan incomplete)" : ""}.`,
        null
      );
      break;
    }
    default:
      break;
  }
}

export const TURN_IDLE_TIMEOUT_ENV = "CODEX_TURN_IDLE_TIMEOUT_MS";
// Disabled by default. With all delta notifications opted out (DEFAULT_CAPABILITIES),
// a healthy turn can legitimately be silent for minutes inside a single long item,
// so a non-zero default could abort healthy work. Operators bound a wedged turn by
// setting CODEX_TURN_IDLE_TIMEOUT_MS (e.g. 600000); background jobs still have the
// 1-hour hard cap in tracked-jobs (DEFAULT_JOB_TIMEOUT_MS).
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 0;

export function resolveTurnIdleTimeoutMs(options = {}) {
  if (Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs >= 0) {
    return Math.trunc(options.idleTimeoutMs);
  }
  const env = options.env ?? process.env;
  const value = Number(env[TURN_IDLE_TIMEOUT_ENV]);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_TURN_IDLE_TIMEOUT_MS;
  }
  return Math.trunc(value); // 0 disables
}

function createTurnIdleError(threadId, turnId, idleTimeoutMs) {
  const error = /** @type {Error & { code?: string, threadId?: string|null, turnId?: string|null, idleTimeoutMs?: number }} */ (
    new Error(
      `Codex turn stalled: no app-server activity for ${idleTimeoutMs}ms (thread ${threadId ?? "?"}, turn ${turnId ?? "?"}). The turn may be wedged; interrupt the turn and reap the broker if it persists.`
    )
  );
  error.code = "ETURNIDLE";
  error.threadId = threadId ?? null;
  error.turnId = turnId ?? null;
  error.idleTimeoutMs = idleTimeoutMs;
  return error;
}

// Extract the turn id from a turn/start (or review/start) ACK. Current Codex
// returns `{ turn: { id } }` (see app-server-protocol v2 turn.rs); accept a
// top-level `turnId` as a harmless forward-compat fallback. Returns null when no id
// is recoverable, which the caller turns into a fail-fast rather than buffering the
// turn's notifications forever (A1).
export function extractTurnIdFromStartResponse(response) {
  return response?.turn?.id ?? response?.turnId ?? null;
}

export async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  // Attach a handler immediately so an idle/transport rejection that fires BEFORE
  // the final `await state.completion` (e.g. while still awaiting the turn/start
  // ACK) is never surfaced as an unhandled rejection. The real await below still
  // re-observes the rejection and throws it.
  state.completion.catch(() => {});

  // Idle watchdog (#1): Codex exposes no app-server-level per-turn idle abort,
  // and a turn wedged with the socket still open never resolves state.completion
  // (the transport watchdog only fires on disconnect). An idle timer — reset on
  // every inbound notification, fired only after a stretch of total silence —
  // bounds that and rejects with the thread/turn id so a caller can interrupt +
  // reap. It is complementary to (not a replacement for) the 1-hour hard cap.
  const idleTimeoutMs = resolveTurnIdleTimeoutMs(options);
  const timers = options.timers ?? { setTimeout, clearTimeout };
  let idleTimer = null;
  const clearIdleTimer = () => {
    if (idleTimer !== null) {
      timers.clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdleTimer = () => {
    if (!(idleTimeoutMs > 0) || state.completed) {
      return;
    }
    clearIdleTimer();
    idleTimer = timers.setTimeout(() => {
      idleTimer = null;
      if (state.completed) {
        return;
      }
      const turnId = state.threadTurnIds.get(state.threadId) ?? state.turnId ?? null;
      const error = createTurnIdleError(state.threadId, turnId, idleTimeoutMs);
      state.error = state.error ?? error;
      state.rejectCompletion(error);
    }, idleTimeoutMs);
    idleTimer?.unref?.();
  };

  // Shared guarded dispatch for a single notification, used by BOTH the live handler
  // and the buffered-replay loop (A4) so replay is exactly as resilient as live
  // handling. This runs synchronously inside the transport stream listener, with no
  // try/catch above it once it reaches the data callback: a notification whose shape
  // changed across a Codex upgrade (e.g. a `fileChange` item without the `changes`
  // array our renderer dereferences) would throw and crash the worker mid-turn —
  // surfacing only as the cryptic "exited without reporting a terminal status"
  // reconcile. Contain it: skip the notification, log a named diagnostic to the job
  // log (discoverable in all modes, incl. background where stderr is /dev/null), and
  // keep the turn alive. thread/started and thread/name/updated are applied
  // regardless of belongsToTurn — a brand-new subthread is not yet in
  // state.threadIds, so gating them by turn would misroute them to previousHandler.
  const dispatchNotification = (message) => {
    try {
      // D: account-/config-level notifications carry no (or a nullable) threadId, so the
      // belongsToTurn test would route them away — but they carry account-wide cost,
      // limit, and safety/config info worth surfacing through the active capture. A
      // `warning` WITH a threadId is thread-scoped, so let belongsToTurn route it (a
      // foreign-thread warning then reaches previousHandler instead of this capture).
      const threadlessAccountNotice =
        message.method === "account/rateLimits/updated" ||
        message.method === "configWarning" ||
        message.method === "deprecationNotice" ||
        message.method === "windows/worldWritableWarning" ||
        (message.method === "warning" && (message.params?.threadId ?? null) === null);
      if (
        message.method === "thread/started" ||
        message.method === "thread/name/updated" ||
        threadlessAccountNotice
      ) {
        applyTurnNotification(state, message);
        return;
      }

      if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
      }

      applyTurnNotification(state, message);
    } catch (error) {
      emitProgress(
        state.onProgress,
        `Skipped a notification we could not process (method=${message?.method ?? "?"}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        null
      );
    }
  };

  client.setNotificationHandler((message) => {
    armIdleTimer(); // any inbound notification is liveness — reset the idle window
    // Until the turn/start ACK gives us a turn id we cannot gate notifications by
    // turn, so buffer them and replay through the SAME guarded dispatch once the id
    // is known (see below).
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      // A5: even before the ACK sets state.turnId, capture the turn id from a root
      // turn/started so a failed/timed-out ACK can still interrupt the turn Codex
      // actually started (otherwise it is orphaned with no id to interrupt). We only
      // record the id and surface it (for the per-job file / idle watchdog); the ACK
      // still drives full tracking and the buffered replay below.
      if (
        message?.method === "turn/started" &&
        (message.params?.threadId ?? null) === state.threadId &&
        message.params?.turn?.id &&
        !state.threadTurnIds.has(state.threadId)
      ) {
        // Record the id only — no progress emit. The buffered message is replayed in
        // full once the ACK lands (which applies turn/started and emits its progress),
        // so emitting here too would duplicate the "Turn started" log line. This
        // recorded id is what the ACK-failure interrupt below reads.
        state.threadTurnIds.set(state.threadId, message.params.turn.id);
      }
      return;
    }
    dispatchNotification(message);
  });

  // A5: best-effort interrupt the turn Codex started when the ACK does not give us a
  // usable id (rejected/timed-out, OR returned without one). Reads the id captured
  // above from a buffered root turn/started; no-ops if none was seen. Bounded over the
  // still-live connection so a wedged broker cannot hang us.
  const interruptCapturedOrphan = async () => {
    const orphanTurnId = state.threadTurnIds.get(state.threadId) ?? null;
    if (!orphanTurnId) {
      return;
    }
    try {
      await client.request(
        "turn/interrupt",
        { threadId: state.threadId, turnId: orphanTurnId },
        { timeoutMs: 3000 }
      );
    } catch {
      // best effort — the ACK failure is surfaced regardless
    }
  };

  try {
    let response;
    try {
      response = await startRequest();
    } catch (ackError) {
      // The turn/start ACK failed or timed out (the per-RPC wall-clock timeout rejects
      // after CODEX_REQUEST_TIMEOUT_MS, default 120s) — reap any turn Codex started
      // before propagating the failure.
      await interruptCapturedOrphan();
      throw ackError;
    }
    options.onResponse?.(response, state);
    const ackTurnId = extractTurnIdFromStartResponse(response);
    if (!ackTurnId) {
      // A1: the ACK returned no recognizable turn id (neither response.turn.id nor a
      // top-level turnId). We can never gate this turn's notifications — the old code
      // left state.turnId null, so every notification buffered forever and the turn
      // hung silently until the hard cap. Reap any turn Codex started (A5), then fail
      // fast with a clear protocol error.
      await interruptCapturedOrphan();
      const ackError = /** @type {Error & { code?: string }} */ (
        new Error(
          "Codex turn/start did not return a turn id (response.turn.id / response.turnId absent); cannot track the turn."
        )
      );
      ackError.code = "ETURNACK";
      state.error = state.error ?? ackError;
      state.rejectCompletion(ackError);
    } else {
      state.turnId = ackTurnId;
      state.threadTurnIds.set(state.threadId, state.turnId);
      // Arm the idle watchdog only once the turn is actually in flight (after the
      // ACK). The ACK round-trip is separately bounded by the per-RPC wall-clock
      // timeout, so the idle timer should track post-start silence, not the ACK.
      armIdleTimer();
      // Replay buffered notifications through the SAME guarded dispatch as the live
      // handler (A4): per-message skip+log, and correct thread/started routing.
      for (const message of state.bufferedNotifications) {
        dispatchNotification(message);
      }
      state.bufferedNotifications.length = 0;

      if (response.turn?.status && response.turn.status !== "inProgress") {
        completeTurn(state, response.turn);
      }
    }

    // Transport-level watchdog: if the app-server (direct or via broker)
    // disconnects before we see turn/completed or a final_answer-phase
    // agentMessage, state.completion will never resolve on its own. Race
    // against client.exitPromise so the companion always reaches a terminal
    // state. This avoids the "captureTurn hangs indefinitely" failure mode
    // that leaves a job stuck at status:running even though no worker exists.
    const transportWatchdog = client.exitPromise.then(() => {
      if (state.completed) return;
      if (state.finalAnswerSeen) {
        // final_answer was seen; the 250ms inferred-completion timer may or
        // may not have fired, and the transport closed before turn/completed.
        // Treat as inferred success — this is the same fallback the existing
        // scheduleInferredCompletion path uses.
        completeTurn(state, null, { inferred: true });
        return;
      }
      const exitError =
        client.exitError ?? state.error ??
        new Error("Codex app-server disconnected before the turn completed (no turn/completed or final_answer received).");
      state.error = state.error ?? exitError;
      state.rejectCompletion(exitError);
    });
    // Swallow unhandled-rejection noise; we only care that the watchdog fires.
    transportWatchdog.catch?.(() => {});

    return await state.completion;
  } finally {
    clearIdleTimer();
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

// Resolve the turn's final message text. `lastAgentMessage` is the answer source —
// it is accumulated from agentMessage item notifications REGARDLESS of phase, so a
// reshaped final_answer phase does not lose it. A3: when it is empty (the turn FAILED
// before producing an agent message), fall back to the completed turn's
// `error.message` so the result surfaces *why* instead of an empty string.
//
// NOTE: turn/completed carries an EMPTY item list in the live app-server
// (items_view: NotLoaded — ../codex bespoke_event_handling.rs), so turn.items is NOT
// a usable backfill for the answer text; the agentMessage notification is the only
// source, and lastAgentMessage already captures it independent of phase.
export function resolveFinalMessage(turnState) {
  if (turnState?.lastAgentMessage) {
    return turnState.lastAgentMessage;
  }
  const turnError = turnState?.finalTurn?.error;
  if (turnError && typeof turnError.message === "string" && turnError.message.trim()) {
    return turnError.message;
  }
  return turnState?.lastAgentMessage ?? "";
}

// Best-effort human-readable failure reason for a FAILED turn — the value that
// becomes the job's structured `errorMessage` so /codex:status, /codex:wait, and
// the --json projection show WHY it died instead of a bare "failed". The
// app-server delivers a turn error in a few shapes: a nested envelope
// `{ error: { message } }`, a plain `{ message }`, OR a `{ message }` whose value
// is itself a JSON-encoded envelope (the observed HTTP-400 model-unavailable
// case). Dig one level so the user reads "The 'X' model requires a newer version
// of Codex" rather than a raw `{"type":"error",...}` blob. Falls back to the raw
// message, then stderr, then null. Never throws — a malformed error must not mask
// the failure it describes.
export function describeTurnError(error, stderr = "") {
  // Bounds at a trust boundary: the error is external content. Never JSON.parse an
  // unbounded string, and cap what we persist so a pathological error can't bloat
  // the job record.
  const cap = (text) => (text.length > MAX_TURN_ERROR_LEN ? `${text.slice(0, MAX_TURN_ERROR_LEN)}…` : text);
  const dig = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 3) {
      return null;
    }
    const nested = value.error;
    if (nested && typeof nested === "object" && typeof nested.message === "string" && nested.message.trim()) {
      return nested.message.trim();
    }
    if (typeof value.message === "string" && value.message.trim()) {
      const message = value.message.trim();
      if (message.startsWith("{") && message.length <= MAX_TURN_ERROR_PARSE_LEN) {
        try {
          const inner = dig(JSON.parse(message), depth + 1);
          if (inner) {
            return inner;
          }
        } catch {
          // .message is not JSON — use it verbatim below.
        }
      }
      return message;
    }
    return null;
  };

  const fromError = dig(error);
  const fromStderr = typeof stderr === "string" ? stderr.trim() : "";
  const message = fromError || fromStderr;
  if (!message) {
    return null;
  }
  // `message` has two structured companions on the wire that were being dropped:
  // `additionalDetails` (often the upstream HTTP body — the actionable half) and
  // `codexErrorInfo` (a machine-readable code). Both belong in the persisted
  // `errorMessage`: the details so a human sees WHY, the code so a delegating
  // commander can branch on a failed --json payload without parsing prose.
  const details = typeof error?.additionalDetails === "string" ? error.additionalDetails.trim() : "";
  const prose = details && !message.includes(details) ? `${message} — ${details}` : message;
  const code = codexErrorCode(error);
  // Cap the prose, never the code: the tag is the machine-readable half and costs ~20 chars.
  return code ? `${cap(prose)} [${code}]` : cap(prose);
}

// `codexErrorInfo` (v2 `TurnError`) is either a bare string tag ("unauthorized",
// "usageLimitExceeded", "badRequest", …) or a single-key object carrying data
// (`{ httpConnectionFailed: { httpStatusCode } }`). Return the tag either way; null
// when the CLI omitted it (older protocol) or it arrived malformed.
export function codexErrorCode(error) {
  const info = error?.codexErrorInfo;
  if (typeof info === "string" && info.trim()) {
    return info.trim();
  }
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const [tag] = Object.keys(info);
    return typeof tag === "string" && tag ? tag : null;
  }
  return null;
}

const MAX_TURN_ERROR_LEN = 2000;
const MAX_TURN_ERROR_PARSE_LEN = 32_000;

// The frontier tier (gpt-5.6-sol) is intermittently gated on ChatGPT-account Codex —
// a turn is rejected with HTTP 400 "The 'X' model requires a newer version of Codex"
// (or a model not-found / unavailable variant). The companion falls back to this
// executor tier once when that happens, so an intermittent gate reads as "retried on
// terra", not "the plugin died". Kept as an explicit slug — the `gpt-5.6` family alias
// is not resolvable on ChatGPT-account Codex.
export const MODEL_FALLBACK_SLUG = "gpt-5.6-terra";

// Match ONLY the one CONFIRMED model-gate signal: HTTP 400 "The '<slug>' model
// requires a newer version of Codex." Requires BOTH the exact gate phrase AND the word
// "model" (in any order) so unrelated "requires a newer version of Codex" notices — e.g.
// an MCP integration notice — never trigger a model switch. We deliberately do NOT match
// speculative "unsupported/unknown/not-found model" phrasings: there is no evidence Codex
// emits them, and broad model+keyword matching false-fires on real turn errors like
// "unsupported model output format" / "model failed with an unknown transport error".
// Add a phrase here only with a real captured sample. A genuine bug (auth, rate limit,
// a real turn error) must be surfaced, never model-switched.
const MODEL_UNAVAILABLE_RE = /(?=[\s\S]*\bmodel\b)[\s\S]*requires a newer version of codex/i;

// The codes a model gate can actually arrive under. `badRequest` is the obvious one,
// but `other` is REQUIRED and verified live: Codex maps an error to a code by error
// VARIANT, not HTTP status, and an upstream 400 is `CodexErrorDetails::UnexpectedStatus`,
// which falls into the `_ => CodexErrorInfo::Other` catch-all
// (codex-rs/protocol/src/error.rs `to_codex_protocol_error`, codex-cli 0.146.0). A real
// rejected turn on 0.146.0 returned `[other]` — so allowing only `badRequest` would
// silently disable the fallback. Anything NOT in this set is a genuine failure.
const MODEL_GATE_CODES = new Set(["badRequest", "other"]);

// True when a FAILED turn/review result failed specifically because its model was
// unavailable. Checks BOTH error sources (turn.error AND the error notification)
// independently — a `??` would let a generic message on one source mask the
// model-unavailable message on the other.
export function isModelUnavailableFailure(result) {
  if (!result || result.status === 0) {
    return false;
  }
  const sources = [
    { error: result.turn?.error ?? null, message: describeTurnError(result.turn?.error) },
    { error: result.error ?? null, message: describeTurnError(result.error, result.stderr) }
  ];
  return sources.some(({ error, message }) => {
    // A structured `codexErrorInfo` narrows the regex: a code that can never be a
    // model gate — `unauthorized`, `usageLimitExceeded`, `contextWindowExceeded`, … —
    // is a genuine failure and must not be model-switched however its prose reads.
    // No code (older CLI, or a message recovered from stderr) → the regex decides
    // alone, as before. Unknown future code → no fallback, i.e. the safe direction.
    const code = codexErrorCode(error);
    if (code && !MODEL_GATE_CODES.has(code)) {
      return false;
    }
    return typeof message === "string" && MODEL_UNAVAILABLE_RE.test(message);
  });
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);

  // The v2 `config/read` Config struct exposes only `model_provider` (a single
  // id string) — there is NO `model_providers` map of per-provider settings, so
  // a custom provider's friendly `name` is not available here. formatProviderLabel
  // falls back to a built-in label or the raw id. (Previously this read a
  // `config.model_providers` map that never exists, so providerConfig was always
  // null — removed as dead code.)
  return {
    providerId,
    providerConfig: null
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  // Amazon Bedrock managed login (account/read `Account::AmazonBedrock`, added
  // to the v2 protocol upstream). Without this branch a Bedrock-authenticated
  // account falls through to the generic requiresOpenaiAuth===false message
  // below with authMethod:null — loggedIn is still correct, but the status text
  // is mislabeled. codex-cli 0.144.6 (protocol/src/account.rs) replaced the
  // `credentialSource` string enum ("awsManaged"|"codexManaged") with a
  // `usesCodexManagedCredentials` bool; read the new bool, fall back to the
  // legacy string for older CLIs.
  if (account?.type === "amazonBedrock") {
    const credentialSource =
      typeof account.usesCodexManagedCredentials === "boolean"
        ? (account.usesCodexManagedCredentials ? "codexManaged" : "awsManaged")
        : typeof account.credentialSource === "string" && account.credentialSource.trim()
          ? account.credentialSource.trim()
          : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: credentialSource ? `Amazon Bedrock login active (${credentialSource})` : "Amazon Bedrock login active",
      source: "app-server",
      authMethod: "amazonBedrock",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

// Ask the app-server which models THIS account/CLI can actually use, so setup can
// warn when the configured default model isn't available (an older Codex that
// predates gpt-5.6, or an account not yet gated into it). Best-effort: returns
// checked:false on any failure so setup never breaks on a model probe. Needs an
// authenticated session — callers should gate on login before calling.
export async function listSupportedModels(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return { checked: false, models: [], detail: availability.detail };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    const models = [];
    let cursor = null;
    // Catalogs are tiny (a handful of models). Cap the page loop so a server that
    // ignores the cursor can never spin forever. ponytail: 10 pages is far past
    // any real catalog.
    for (let page = 0; page < 10; page += 1) {
      const params = { includeHidden: true };
      if (cursor) {
        params.cursor = cursor;
      }
      const response = await client.request("model/list", params);
      for (const model of response?.data ?? []) {
        models.push(model);
      }
      cursor = response?.nextCursor ?? null;
      if (!cursor) {
        break;
      }
    }
    return { checked: true, models, detail: null };
  } catch (error) {
    return {
      checked: false,
      models: [],
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null
        }),
      { onProgress: options.onProgress }
    );

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: resolveFinalMessage(turnState),
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions,
      startedSideEffect: turnState.startedSideEffect
    };
  });
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
