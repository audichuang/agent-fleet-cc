import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	// A terminal turn error whose .message is a JSON-ENCODED error envelope — the
	// real HTTP-400 model-unavailable shape the silent-death fix must surface.
	const TERMINAL_ERROR_ENVELOPE = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-5.6-sol' model requires a newer version of Codex." } });
	// Real 0.146.0 sends the structured code alongside the message, and an upstream 400 is
	// CodexErrorDetails::UnexpectedStatus, which maps to the "other" catch-all (verified
	// against a live rejected turn). The error notifications below mirror that, or the
	// hermetic tests would model a shape the real engine never produces. The turn.error
	// path deliberately stays code-less, covering the older-CLI / no-code branch.
	// A failure that arrives ONLY via a terminal turn/completed carrying turn.error,
	// with NO preceding standalone error notification — the second failure shape.
	const TURN_COMPLETED_ERROR = "Codex turn failed: 401 Unauthorized (upstream auth rejected).";
	// The real app-server puts a BARE reason in TurnError.message — "401 Unauthorized",
	// "Usage limit reached". TURN_COMPLETED_ERROR above carries the plugin's own
	// "Codex turn failed: " prefix baked in, so any test driven by it sees a failure
	// marker the render never produced. This one carries no marker: if the render stops
	// adding one, the assertion has nothing else to fall back on.
	const BARE_TURN_ERROR = "401 Unauthorized";
	// NOTE: this whole body lives in a template literal — no backticks in comments.
	// Every turn/completed error in this fixture is UNDECORATED, while every standalone
	// error notification carries codexErrorInfo. The real protocol has no such asymmetry:
	// v2 TurnError declares codexErrorInfo as a required nullable key, and
	// isModelUnavailableFailure reads it straight off turn.error. That asymmetry is
	// load-bearing for the "reason stated once" assertions, because describeTurnError
	// appends a bracketed code, making the decorated reason a strict superset of the bare
	// body so the render containment check cannot match. This shape drives that on purpose.
	const DECORATED_TURN_ERROR = { message: "401 Unauthorized", codexErrorInfo: "unauthorized" };
	const interruptibleTurns = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    case "bedrock-account":
      return { account: { type: "amazonBedrock", usesCodexManagedCredentials: false }, requiresOpenaiAuth: false };
    case "bedrock-account-legacy":
      return { account: { type: "amazonBedrock", credentialSource: "codexManaged" }, requiresOpenaiAuth: false };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function buildModelListResult() {
  if (BEHAVIOR === "model-list-fails") {
    throw new Error("model/list failed");
  }
  // Shapes mirror a real model/list includeHidden:true call (see
  // docs/codex-protocol-sync-audit.md): the 5.6 family is all hidden:false, and the
  // one genuinely hidden entry is codex-auto-review. The unsupported branch carries
  // that hidden entry so setup's !hidden filter is actually exercised — without it the
  // "suggest alternatives" assertion passes whether or not the filter works.
  const models = BEHAVIOR === "model-unsupported"
    ? [{ id: "gpt-5.4", hidden: false }, { id: "gpt-5.5", hidden: false }, { id: "gpt-5.6-terra", hidden: false }, { id: "codex-auto-review", hidden: true }]
    : [{ id: "gpt-5.6-sol", hidden: false }, { id: "gpt-5.6-terra", hidden: false }, { id: "gpt-5.4", hidden: false }, { id: "gpt-5.6-luna", hidden: false }];
  return { data: models, nextCursor: null };
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only" || BEHAVIOR === "bedrock-account" || BEHAVIOR === "bedrock-account-legacy") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "model/list":
        send({ id: message.id, result: buildModelListResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        thread.model = message.params.model ?? null; // remember the requested model so review/start can gate on it
        // Record the isolation fields exactly as they arrived. The result below reports a
        // readOnly sandbox regardless of what was sent, so a test that trusts the reply
        // learns nothing about what the plugin actually put on the wire.
        thread.wireStart = { sandbox: message.params.sandbox ?? null, approvalPolicy: message.params.approvalPolicy ?? null };
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        thread.wireResume = { sandbox: message.params.sandbox ?? null, approvalPolicy: message.params.approvalPolicy ?? null };
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        if (BEHAVIOR === "terminal-error") {
          send({ method: "turn/started", params: { threadId: reviewThread.id, turn: buildTurn(turnId) } });
          send({ method: "error", params: { threadId: reviewThread.id, turnId, willRetry: false, error: { message: TERMINAL_ERROR_ENVELOPE, codexErrorInfo: "other" } } });
          break;
        }
        if (BEHAVIOR === "turn-completed-error") {
          send({ method: "turn/started", params: { threadId: reviewThread.id, turn: buildTurn(turnId) } });
          send({ method: "turn/completed", params: { threadId: reviewThread.id, turn: buildTurn(turnId, "failed", { message: TURN_COMPLETED_ERROR }) } });
          break;
        }
        // Native review runs on the thread's model (set at thread/start); reject any
        // non-terra so the review fallback path can be proven end-to-end.
        if (BEHAVIOR === "model-fallback" && thread.model !== "gpt-5.6-terra") {
          send({ method: "turn/started", params: { threadId: reviewThread.id, turn: buildTurn(turnId) } });
          send({ method: "error", params: { threadId: reviewThread.id, turnId, willRetry: false, error: { message: TERMINAL_ERROR_ENVELOPE, codexErrorInfo: "other" } } });
          break;
        }
        // Full review text captured (exitedReviewMode), THEN a terminal
        // turn/completed carrying turn.error — the upstream-real sequence where the
        // review body exists and the turn still failed. No standalone error
        // notification precedes it, so the client's terminal-error arm never fires and
        // the render is what has to surface the failure.
        if (BEHAVIOR === "output-then-turn-error") {
          send({ method: "turn/started", params: { threadId: reviewThread.id, turn: buildTurn(turnId) } });
          send({ method: "item/completed", params: { threadId: reviewThread.id, turnId, item: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) } } });
          send({ method: "turn/completed", params: { threadId: reviewThread.id, turn: buildTurn(turnId, "failed", { message: TURN_COMPLETED_ERROR }) } });
          break;
        }
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          prompt
	        };
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        if (BEHAVIOR === "terminal-error") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "error", params: { threadId: thread.id, turnId, willRetry: false, error: { message: TERMINAL_ERROR_ENVELOPE, codexErrorInfo: "other" } } });
          break;
        }
        // A turn that produces a real agentMessage (a PARTIAL answer) and THEN dies —
        // the only shape where the failure reason is distinct from the final message,
        // i.e. where the companion must prefix the reason onto the output.
        if (BEHAVIOR === "partial-then-error") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: "Here is what I found so far.", phase: "final_answer" } } });
          send({ method: "error", params: { threadId: thread.id, turnId, willRetry: false, error: { message: TERMINAL_ERROR_ENVELOPE, codexErrorInfo: "other" } } });
          break;
        }
        if (BEHAVIOR === "turn-completed-error") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed", { message: TURN_COMPLETED_ERROR }) } });
          break;
        }
        // Same shape, realistic message: a bare reason with no "Codex turn failed: "
        // prefix of its own. The render is the only thing that can mark this a failure.
        if (BEHAVIOR === "bare-turn-error") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed", { message: BARE_TURN_ERROR }) } });
          break;
        }
        // The same bare reason, decorated the way the real wire decorates it. The render
        // cannot collapse this to one statement (see the ponytail: note in render.mjs),
        // so this is the executable record of that accepted ceiling.
        if (BEHAVIOR === "decorated-turn-error") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed", DECORATED_TURN_ERROR) } });
          break;
        }
        // The third failure shape, absent from the plugin's AGENTS.md list: a terminal
        // turn that is neither "completed" nor carrying an error at all. buildResultStatus
        // counts any non-"completed" status as a failure, so this IS a failed turn — with
        // no agent message and no error text anywhere. Everything the user could be told
        // has to come from failureReasonFor's own fallback.
        if (BEHAVIOR === "interrupted-no-error") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "interrupted") } });
          break;
        }
        // Model fallback: sol (or any non-terra) is rejected as unavailable; the
        // executor tier succeeds — so the companion's retry-on-terra path can be proven.
        if (BEHAVIOR === "model-fallback" && message.params.model !== "gpt-5.6-terra") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "error", params: { threadId: thread.id, turnId, willRetry: false, error: { message: TERMINAL_ERROR_ENVELOPE, codexErrorInfo: "other" } } });
          break;
        }
        // A command STARTS (side effect), then the model-gate error arrives before
        // item/completed — the retry guard must NOT re-run this (would double the effect).
        if (BEHAVIOR === "model-error-after-command") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "item/started", params: { threadId: thread.id, turnId, item: { type: "commandExecution", id: "cmd_" + turnId, command: "echo side-effect", status: "inProgress" } } });
          send({ method: "error", params: { threadId: thread.id, turnId, willRetry: false, error: { message: TERMINAL_ERROR_ENVELOPE, codexErrorInfo: "other" } } });
          break;
        }

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        // The structured-review twin of the review/start branch above: a VALID review
        // JSON lands as the final agent message, then the turn dies. It parses cleanly,
        // so only the render can show that the verdict came from a failed turn.
        if (BEHAVIOR === "output-then-turn-error") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" } } });
          send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed", { message: TURN_COMPLETED_ERROR }) } });
          break;
        }

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
  // Keep runtime tests deterministic across developer machines: drop ambient
  // CODEX_* tuning knobs (e.g. a tiny CODEX_JOB_TIMEOUT_MS or a custom watchdog
  // interval) so the spawned companion always uses its documented defaults.
  // CLAUDE_PLUGIN_DATA is inherited from process.env on purpose — helpers.mjs has
  // already redirected it to a throwaway dir, so the test process and the spawned
  // companion resolve the SAME isolated per-workspace state directory (never the
  // developer's real plugin data).
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_")) {
      delete env[key];
    }
  }
  return env;
}
