// plugins/cc/scripts/lib/adapter.mjs
// ClaudeAdapter:cc 的全部引擎知識住這裡(spec §2/§5)。
// job runtime(state/worker/cancel)在 vendored shared,本檔不碰 I/O 生命週期。
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveProfile } from "./profiles.mjs";

export const RECURSION_MARKER = "CLAUDE_CC_ACTIVE";

// cc 特有路徑邏輯(自舊 state.mjs 遷入,行為不變)
export function resolveDataRoot(env = process.env) {
  if (env.CC_PLUGIN_DATA) return env.CC_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), ".claude", "plugins", "data", "cc");
}

export function workspaceStateDir(dataRoot, cwd) {
  const slug =
    path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32) || "ws";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function buildClaudeArgs({
  settingsPath,
  permissionMode = "bypassPermissions",
  resumeSessionId,
  model,
} = {}) {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--settings", settingsPath,
    "--permission-mode", permissionMode,
  ];
  if (model) args.push("--model", model);
  if (resumeSessionId) args.push("-r", resumeSessionId);
  return args;
}

export function makeClaudeAdapter() {
  return {
    name: "claude",
    engine: "cc",
    recursionMarker: RECURSION_MARKER,
    wantsWatchdog: false,
    // request 只存 settingsPath/旗標 — profile env(含 AUTH_TOKEN)在 spawn
    // 時才從 profile 檔讀,秘密永不落進 job.json。
    buildInvocation({ job, prompt }) {
      const request = job.request ?? {};
      const profile = resolveProfile({ settingsPath: request.settingsPath });
      const head =
        request.binaryArgv ??
        [process.env.CC_CLAUDE_BIN ?? "claude"];
      const argv = [
        ...head,
        ...buildClaudeArgs({
          settingsPath: request.settingsPath,
          permissionMode: request.permissionMode,
          resumeSessionId: request.resumeSessionId,
          model: request.model,
        }),
      ];
      return { argv, env: profile.env, stdinPayload: prompt };
    },
    parseEvent(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return null; // junk — 容錯跳行,永不 fatal
      }
      if (typeof event.session_id === "string" && event.type !== "result") {
        return { kind: "session", sessionId: event.session_id };
      }
      if (event.type === "result") {
        const usage = event.usage
          ? {
              inputTokens: event.usage.input_tokens ?? null,
              outputTokens: event.usage.output_tokens ?? null,
            }
          : null;
        return {
          kind: "result",
          text:
            typeof event.result === "string"
              ? event.result
              : event.result == null
                ? ""
                : JSON.stringify(event.result),
          isError: Boolean(event.is_error),
          usage,
        };
      }
      return null; // assistant/tool 事件不進 events(log 檔有完整行)
    },
    extractResult(events) {
      const session = events.find((e) => e.kind === "session");
      const result = events.find((e) => e.kind === "result");
      return {
        ok: Boolean(result) && !result.isError,
        resultText: result?.text ?? null,
        sessionId: session?.sessionId ?? null,
        usage: result?.usage ?? null,
      };
    },
    classifyError(stderrTail, exitCode) {
      const s = String(stderrTail ?? "");
      if (/401|unauthorized|invalid.*key|token expired/i.test(s)) return "auth";
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(s)) return "endpoint";
      if (exitCode === 127 || /command not found|ENOENT/i.test(s)) return "not-installed";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["-r", sessionId];
    },
  };
}
