/**
 * /antigravity:wait — wait for a single background job to reach terminal state.
 *
 * Positional: <job-id> (required).
 * Flags:
 *   --timeout-ms <ms>  override the wait timeout (default 15m)
 *   --json            emit JSON instead of markdown
 *   --cwd <path>      override working directory
 *
 * Exit codes:
 *   0  completed
 *   1  failed or missing
 *   2  cancelled
 *   10 timeout before terminal state
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { sleep, POLL_MS, TERMINAL_STATUSES, parseTimeoutMs, waitForTerminal } from "../lib/poll.mjs";
import {
  outputCommandResult,
  renderSingleJobStatus,
} from "../lib/render.mjs";

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

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

  let result;
  try {
    result = await waitForTerminal(cwd, reference, parseTimeoutMs(options["timeout-ms"], DEFAULT_WAIT_TIMEOUT_MS));
  } catch (err) {
    process.stderr.write(`antigravity:wait — ${err?.message ?? err}\n`);
    return 1;
  }

  const payload = buildWaitPayload(result.snapshot, { timedOut: result.timedOut });
  const rendered = renderWaitOutput(result.snapshot, { timedOut: result.timedOut });
  outputCommandResult(payload, rendered, json);
  return exitCodeFor(payload.status, result.timedOut);
}

function buildWaitPayload(snapshot, { timedOut }) {
  const job = snapshot.job;
  return {
    engine: "antigravity",
    jobId: job.id,
    status: job.status,
    phase: job.phase ?? null,
    title: job.title ?? null,
    summary: job.summary ?? null,
    errorMessage: job.errorMessage ?? null,
    healthStatus: job.healthStatus ?? null,
    conversationId: job.conversationId ?? null,
    threadId: job.threadId ?? null,
    elapsed: job.elapsed ?? null,
    completedAt: job.completedAt ?? null,
    timedOut,
  };
}

function renderWaitOutput(snapshot, { timedOut }) {
  const rendered = renderSingleJobStatus(snapshot);
  if (!timedOut) return rendered;
  return `${rendered.trimEnd()}\n\nantigravity:wait timed out before ${snapshot.job.id} reached a terminal state.\n`;
}

function exitCodeFor(status, timedOut) {
  if (timedOut) return 10;
  if (status === "completed") return 0;
  if (status === "cancelled") return 2;
  return 1;
}

export default run;

runAsMain(import.meta.url, run, "wait");
