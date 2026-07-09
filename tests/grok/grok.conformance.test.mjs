// tests/grok/grok.conformance.test.mjs
import "./helpers.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConformanceSuite } from "../shared/conformance/conformance.mjs";
import { makeGrokAdapter } from "../../plugins/grok/scripts/lib/adapter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_GROK = path.join(here, "fake-grok.mjs");

// Map the abstract conformance mode to a fake-grok conf-* mode, and inject the
// fake binary + mode via request.binaryArgv / request.env (no profiles needed).
function makeAdapter({ mode = "ok", resumeSessionId = null } = {}) {
  const base = makeGrokAdapter();
  return {
    ...base,
    buildInvocation({ job, prompt }) {
      return base.buildInvocation({
        job: {
          ...job,
          request: {
            ...job.request,
            resumeSessionId,
            binaryArgv: [process.execPath, FAKE_GROK],
            env: { FAKE_GROK_MODE: `conf-${mode}` },
          },
        },
        prompt,
      });
    },
  };
}

runConformanceSuite({ makeAdapter });
