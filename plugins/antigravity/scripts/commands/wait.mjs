/**
 * /antigravity:wait — wait for a single background job to reach terminal state.
 *
 * Runs on the shared runtime: `waitForJob({stateDir, jobId, timeoutMs,
 * reconcile})` polls to terminal or the wait deadline, reconciling dead pids
 * each poll (so a worker that died terminalizes instead of the wait hanging to
 * the deadline). Returns `{done, job}` — `done:false` means the wait DEADLINE
 * elapsed while the job was still active; `job:null` means the job is
 * missing/pruned.
 *
 * Positional: <job-id> (required).
 * Flags:
 *   --timeout-ms <ms>  override the wait timeout (default 15m)
 *   --json            emit JSON instead of markdown
 *   --cwd <path>      override working directory
 *
 * Exit codes (locked by poll.test.mjs):
 *   0  completed
 *   1  failed / timed-out (terminal) / missing
 *   2  cancelled
 *   10 wait deadline exceeded before terminal state
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { stateDirFor, projectJob } from "../lib/job-runtime.mjs";
import { waitForJob } from "../lib/shared/core/wait.mjs";
import { readJob } from "../lib/shared/core/state-store.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import { outputCommandResult, renderSingleJobStatus } from "../lib/render.mjs";

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

// Relocated from poll.mjs (deleted in Phase 6). Returns the default when the
// flag is absent; throws on a present-but-invalid value.
function parseTimeoutMs(value, defaultMs) {
  if (value === undefined) return defaultMs;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  return parsed;
}

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["timeout-ms", "cwd"],
    booleanOptions: ["json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  if (!reference) {
    process.stderr.write(
      "antigravity:wait — job id required. Run /antigravity:status to inspect active jobs.\n",
    );
    return 1;
  }

  let timeoutMs;
  try {
    timeoutMs = parseTimeoutMs(options["timeout-ms"], DEFAULT_WAIT_TIMEOUT_MS);
  } catch (err) {
    process.stderr.write(`antigravity:wait — ${err?.message ?? err}\n`);
    return 1;
  }

  const stateDir = stateDirFor(cwd, process.env);

  // Pre-check: short-circuit a missing job to exit 1 without spinning the
  // wait loop (mirrors cc-companion). A bare unique-substring/index reference
  // does not resolve here — wait requires the exact job id.
  if (!readJob(stateDir, reference)) {
    process.stderr.write(
      `antigravity:wait — no job found for "${reference}". Run /antigravity:status to inspect known jobs.\n`,
    );
    return 1;
  }

  const { done, job } = await waitForJob({
    stateDir,
    jobId: reference,
    timeoutMs,
    // Never sleep longer than the remaining budget: a tiny --timeout-ms must
    // return promptly instead of parking on the default 500ms poll interval.
    pollMs: Math.min(500, Math.max(1, timeoutMs)),
    reconcile: reconcileDeadPids,
  });

  const projected = projectJob(job);
  const timedOut = !done;
  const payload = buildWaitPayload(projected, { timedOut });
  const rendered = renderWaitOutput(projected, reference, { timedOut });
  outputCommandResult(payload, rendered, json);
  return exitCodeFor({ done, job });
}

// Order matters (spec §4c / R5): missing → 1 FIRST (no null deref), then the
// wait DEADLINE (done:false) → 10 BEFORE status, so a terminal `timed-out`
// job (done:true) falls through to the default 1 rather than being read as a
// deadline-10.
function exitCodeFor({ done, job }) {
  if (!job) return 1; // missing/pruned (waitForJob returns {done:true, job:null})
  if (!done) return 10; // wait deadline exceeded, job still active
  if (job.status === "completed") return 0;
  if (job.status === "cancelled") return 2;
  return 1; // failed OR timed-out (terminal) → 1
}

function buildWaitPayload(job, { timedOut }) {
  if (!job) {
    return {
      engine: "antigravity",
      jobId: null,
      status: "missing",
      timedOut,
    };
  }
  return {
    engine: "antigravity",
    jobId: job.id,
    status: job.status,
    phase: job.phase ?? null,
    title: job.title ?? null,
    summary: job.summary ?? null,
    errorMessage: job.errorMessage ?? null,
    conversationId: job.conversationId ?? null,
    threadId: job.threadId ?? null,
    completedAt: job.completedAt ?? null,
    timedOut,
  };
}

function renderWaitOutput(job, reference, { timedOut }) {
  if (!job) {
    return `antigravity:wait — no job found for "${reference}".\n`;
  }
  const rendered = renderSingleJobStatus(job);
  if (!timedOut) return rendered;
  return `${rendered.trimEnd()}\n\nantigravity:wait timed out before ${job.id} reached a terminal state.\n`;
}

export default run;

runAsMain(import.meta.url, run, "wait");
