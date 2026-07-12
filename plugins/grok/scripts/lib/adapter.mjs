// plugins/grok/scripts/lib/adapter.mjs
// GrokAdapter:grok — all engine knowledge for xAI Grok Build lives here.
// Job runtime (state/worker/cancel) is the vendored shared lib; this file
// touches no I/O lifecycle. Auth is delegated to the grok CLI (XAI_API_KEY or
// a cached token from `grok login`) — no secrets ever land in a job record.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const RECURSION_MARKER = "GROK_FLEET_ACTIVE";

// Fan-out final-report sentinels (see commands/task.md). A multi-agent run
// concatenates every agent's text into one undelimited stream — grok headless
// exposes no agent id, so leaked subagent output cannot be demuxed. If the
// leader fences its final report with these, we keep only that.
export const FINAL_OPEN = "<<<GROK_FINAL>>>";
export const FINAL_CLOSE = "<<<GROK_END>>>";

// First-open → last-close: spans the whole fenced report even when the report
// body itself quotes the sentinel tokens (a report *about* grok will), while
// still dropping the subagent chatter that leaks in *before* the leader opens
// the fence. No fence → return the full text unchanged.
function extractFinalReport(text) {
  const open = text.indexOf(FINAL_OPEN);
  const close = text.lastIndexOf(FINAL_CLOSE);
  return open >= 0 && close > open
    ? text.slice(open + FINAL_OPEN.length, close).trim()
    : text;
}

export function resolveDataRoot(env = process.env) {
  if (env.GROK_PLUGIN_DATA) return env.GROK_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok");
}

export function workspaceStateDir(dataRoot, cwd) {
  const slug =
    path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32) || "ws";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function makeGrokAdapter() {
  return {
    name: "grok",
    engine: "grok",
    recursionMarker: RECURSION_MARKER,
    wantsWatchdog: false,
    buildInvocation({ job, prompt }) {
      const r = job.request ?? {};
      const head = r.binaryArgv ?? [process.env.GROK_BIN ?? "grok"];
      // ponytail: prompt inline via -p; ceiling is ARG_MAX (~2MB, getconf ARG_MAX).
      // Upgrade path if that ever bites: write prompt to a file, pass --prompt-file.
      const argv = [
        ...head,
        "-p", prompt,
        "--output-format", "streaming-json",
        "--always-approve",
        "--no-auto-update",
        "--no-alt-screen",
        "-m", r.model ?? process.env.GROK_DEFAULT_MODEL ?? "grok-4.5",
      ];
      const cwd = job.cwd ?? r.cwd;
      if (cwd) argv.push("--cwd", cwd);
      const effort = r.effort ?? process.env.GROK_DEFAULT_EFFORT;
      if (effort) argv.push("--reasoning-effort", effort);
      if (r.noSubagents) argv.push("--no-subagents"); // disable fan-out (deterministic single agent)
      if (r.resumeSessionId) argv.push("-r", r.resumeSessionId);
      // env: conformance/e2e can inject via request.env; secrets are NOT set here.
      return { argv, env: r.env ?? {}, stdinPayload: null };
    },
    parseEvent(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return null; // junk — tolerate, never fatal
      }
      if (event.type === "text") {
        return { kind: "text", text: typeof event.data === "string" ? event.data : "" };
      }
      if (event.type === "end") {
        return {
          kind: "end",
          sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
          stopReason: event.stopReason ?? null,
        };
      }
      // grok emits {type:"error",message} on stdout for bad model / bad effort /
      // no-auth etc. (verified against 0.2.93). Capture it so the failure message
      // survives even when nothing lands on stderr.
      if (event.type === "error") {
        return { kind: "error", message: typeof event.message === "string" ? event.message : "" };
      }
      return null; // thought / tool / anything else → raw line stays in the log
    },
    extractResult(events, exitCode) {
      const end = events.find((e) => e.kind === "end");
      const errored = events.some((e) => e.kind === "error");
      const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
      // Sentinels present (fan-out with the task.md contract) → keep only the
      // fenced final report, dropping leaked subagent chatter. Absent (single
      // agent, or caller didn't opt in) → full text, unchanged. Either way the
      // full raw stream is still in the job log for `/grok:logs`.
      const clean = extractFinalReport(text);
      return {
        // Trust the exit code + a terminal `end` event; do NOT gate on the exact
        // stopReason. grok exits nonzero on real failures (Cancelled/max-turns,
        // bad model/effort), so exitCode already rejects those — over-constraining
        // on stopReason==="EndTurn" wrongly failed legitimate non-EndTurn ends
        // (e.g. MaxTokens) that still carried a full answer. A stdout error event
        // also fails it.
        ok: exitCode === 0 && Boolean(end) && !errored,
        resultText: clean.length ? clean : null,
        sessionId: end?.sessionId ?? null,
        usage: null, // grok streaming-json emits no token counts
      };
    },
    classifyError(stderrTail, exitCode) {
      const s = String(stderrTail ?? "");
      // Buckets widened against real grok 0.2.93 failure strings (verified by running).
      if (/401|unauthorized|forbidden|not logged in|no cached credentials|waiting for authorization|XAI_API_KEY|authenticate|token expired|grok login|sign in/i.test(s)) return "auth";
      if (/429|too many requests|rate limit|usage limit|quota/i.test(s)) return "quota";
      if (/unknown model id|unknown effort level/i.test(s)) return "config";
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|relay/i.test(s)) return "endpoint";
      if (exitCode === 127 || /command not found|ENOENT/i.test(s)) return "not-installed";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["-r", sessionId];
    },
  };
}
