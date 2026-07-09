// plugins/grok/scripts/lib/adapter.mjs
// GrokAdapter:grok — all engine knowledge for xAI Grok Build lives here.
// Job runtime (state/worker/cancel) is the vendored shared lib; this file
// touches no I/O lifecycle. Auth is delegated to the grok CLI (XAI_API_KEY or
// a cached token from `grok login`) — no secrets ever land in a job record.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const RECURSION_MARKER = "GROK_FLEET_ACTIVE";

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
      return null; // thought / tool / anything else → raw line stays in the log
    },
    extractResult(events, exitCode) {
      const end = events.find((e) => e.kind === "end");
      const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
      return {
        ok: exitCode === 0 && end?.stopReason === "EndTurn",
        resultText: text.length ? text : null,
        sessionId: end?.sessionId ?? null,
        usage: null, // grok streaming-json emits no token counts
      };
    },
    classifyError(stderrTail, exitCode) {
      const s = String(stderrTail ?? "");
      if (/401|unauthorized|not logged in|forbidden|XAI_API_KEY|authenticate|token expired/i.test(s)) return "auth";
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|relay/i.test(s)) return "endpoint";
      if (exitCode === 127 || /command not found|ENOENT/i.test(s)) return "not-installed";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["-r", sessionId];
    },
  };
}
