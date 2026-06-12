/**
 * /antigravity:status — list active/recent jobs or inspect one.
 *
 * Positional: <job-id> (optional). When present, render the detailed view.
 * Flags:
 *   --wait        block until the job (or all active jobs) reach terminal state.
 *   --timeout-ms <ms>  override the wait timeout (default 15m).
 *   --json        emit JSON instead of markdown.
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
} from "../lib/job-control.mjs";
import {
  outputCommandResult,
  renderStatusSnapshot,
  renderSingleJobStatus,
} from "../lib/render.mjs";

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 1000;

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["timeout-ms", "cwd"],
    booleanOptions: ["wait", "json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    if (options.wait) {
      const finished = await waitForSingleJob(cwd, reference, options);
      const rendered = renderSingleJobStatus(finished);
      maybeAnnotateOAuth(finished.job);
      outputCommandResult(finished, rendered, json);
      return 0;
    }
    const rendered = renderSingleJobStatus(snapshot);
    maybeAnnotateOAuth(snapshot.job);
    outputCommandResult(snapshot, rendered, json);
    return 0;
  }

  if (options.wait) {
    const final = await waitForAllActive(cwd, options);
    const rendered = renderStatusSnapshot(final);
    outputCommandResult(final, rendered, json);
    return 0;
  }

  const snapshot = buildStatusSnapshot(cwd, { env: process.env });
  const rendered = renderStatusSnapshot(snapshot);
  outputCommandResult(snapshot, rendered, json);
  return 0;
}

async function waitForSingleJob(cwd, reference, options) {
  const timeoutMs = Number(options["timeout-ms"]) || DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = buildSingleJobSnapshot(cwd, reference);
    const status = snap.job?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return snap;
    }
    await sleep(POLL_MS);
  }
  return buildSingleJobSnapshot(cwd, reference);
}

async function waitForAllActive(cwd, options) {
  const timeoutMs = Number(options["timeout-ms"]) || DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = buildStatusSnapshot(cwd, { env: process.env });
    if (snap.running.length === 0) return snap;
    await sleep(POLL_MS);
  }
  return buildStatusSnapshot(cwd, { env: process.env });
}

function maybeAnnotateOAuth(job) {
  if (job?.oauthUrl) {
    process.stderr.write(
      `\nantigravity:status — OAuth required. Open: ${job.oauthUrl}\n` +
        `Then run /antigravity:setup to complete the flow.\n`,
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default run;

runAsMain(import.meta.url, run, "status");
