// tests/delegate/delegate.conformance.test.mjs
import "./helpers.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConformanceSuite } from "../shared/conformance/conformance.mjs";
import { makeClaudeAdapter } from "../../plugins/delegate/scripts/lib/adapter.mjs";
import { makeDataRoot, writeProfile } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, "fake-claude.mjs");

// conformance 的 makeAdapter({mode, resumeSessionId}) 工廠:把抽象 mode 映到
// fake-claude 的 conf-* 模式,profile env 走真實 resolveProfile 路徑。
function makeAdapter({ mode = "ok", resumeSessionId = null } = {}) {
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "conf", {
    env: { FAKE_CLAUDE_MODE: `conf-${mode}` },
  });
  const base = makeClaudeAdapter();
  return {
    ...base,
    buildInvocation({ job, prompt }) {
      return base.buildInvocation({
        job: {
          ...job,
          request: {
            ...job.request,
            settingsPath,
            resumeSessionId,
            binaryArgv: [process.execPath, FAKE_CLAUDE],
          },
        },
        prompt,
      });
    },
  };
}

runConformanceSuite({ makeAdapter });
