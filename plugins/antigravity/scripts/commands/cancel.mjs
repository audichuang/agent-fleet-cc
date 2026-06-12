/**
 * /antigravity:cancel — terminate an active background job.
 *
 * Race- and signal-safe:
 *  - Re-reads the per-job file (source of truth) for the authoritative pid
 *    rather than trusting the possibly-stale state.json index.
 *  - Verifies the pid is alive before signalling, and terminates the whole
 *    process group (terminateProcessTree) so the real `agy` grandchild is
 *    reaped, not just the Node worker.
 *  - Writes the terminal `cancelled` status through applyJobPatchIfActive, so a
 *    cancel that loses a race to the worker's natural completion does not
 *    clobber the real result.
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveCancelableJob } from "../lib/job-control.mjs";
import {
  appendJobLog,
  applyJobPatchIfActive,
  isProcessAlive,
  readJobFile,
} from "../lib/state.mjs";
import { terminateProcessTree } from "../lib/process.mjs";
import { outputCommandResult, renderCancelReport } from "../lib/render.mjs";

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  let job;
  let workspaceRoot;
  try {
    ({ workspaceRoot, job } = resolveCancelableJob(cwd, reference));
  } catch (err) {
    process.stderr.write(`antigravity:cancel — ${err?.message ?? err}\n`);
    return 1;
  }

  // Source of truth for the pid is the per-job file, not the index.
  const stored = readJobFile(workspaceRoot, job.id) ?? job;
  const pid = Number(stored.pid);

  let killed = false;
  if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
    try {
      terminateProcessTree(pid);
      killed = true;
    } catch (err) {
      appendJobLog(workspaceRoot, job.id, `[cancel] terminate failed: ${err?.message ?? err}`);
    }
  }
  appendJobLog(workspaceRoot, job.id, `[cancel] terminate pid=${pid} killed=${killed}`);

  const completedAt = new Date().toISOString();
  const result = await applyJobPatchIfActive(workspaceRoot, job.id, {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    healthStatus: null,
  });

  if (!result.applied) {
    // The worker (or watchdog/reconcile) finalized first — respect it.
    const finalStatus = result.stored?.status ?? "finished";
    process.stderr.write(
      `antigravity:cancel — job ${job.id} already ${finalStatus}; nothing to cancel.\n`,
    );
    return 1;
  }

  const updated = { ...result.stored, ...result.patch, id: job.id };
  const rendered = renderCancelReport(updated);
  outputCommandResult(
    {
      jobId: job.id,
      status: "cancelled",
      pid: Number.isFinite(pid) ? pid : null,
      killed,
    },
    rendered,
    json,
  );
  return 0;
}

export default run;

runAsMain(import.meta.url, run, "cancel");
