// tests/shared/conformance/reference-adapter.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_ENGINE = path.join(here, "fake-engine.mjs");

export function makeReferenceAdapter({ mode = "ok", resumeSessionId = null } = {}) {
  return {
    name: "reference",
    engine: "reference",
    recursionMarker: "FAKE_ENGINE_ACTIVE",
    wantsWatchdog: false,
    buildInvocation({ job, prompt }) {
      const argv = [process.execPath, FAKE_ENGINE];
      if (resumeSessionId) argv.push(...this.resumeArgs(resumeSessionId));
      return { argv, env: { FAKE_ENGINE_MODE: mode }, stdinPayload: prompt };
    },
    parseEvent(line) {
      try {
        const e = JSON.parse(line);
        return e && e.kind ? e : null;
      } catch {
        return null;
      }
    },
    extractResult(events) {
      const session = events.find((e) => e.kind === "session");
      const result = events.find((e) => e.kind === "result");
      return {
        ok: Boolean(result?.ok),
        resultText: result?.text ?? null,
        sessionId: session?.id ?? null,
        usage: null,
      };
    },
    classifyError(stderrTail) {
      if (/401|expired/.test(stderrTail)) return "auth";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["--resume", sessionId];
    },
  };
}
