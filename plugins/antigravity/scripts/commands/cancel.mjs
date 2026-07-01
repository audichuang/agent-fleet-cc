/**
 * /antigravity:cancel — terminate an active background job.
 *
 * Runs on the shared runtime (spec §5): `cancelJob(stateDir, jobId)` is the
 * race- and signal-safe primitive — CAS-first (only the terminal-transition
 * winner may signal), safe pid (never signals 0/negative/recycled pids), and
 * a single SIGTERM to the worker. The worker's own `installCancelForwarder`
 * does the process-group kill so the real `agy` grandchild is reaped, not just
 * the Node worker. A cancel that loses the race to natural completion returns
 * `{ok:false}` and never clobbers the real result.
 *
 * Multi-active resolution + refusal (ported from the old resolveCancelableJob):
 *  - 0 active jobs → "No active antigravity jobs to cancel." (exit 1)
 *  - >1 active jobs + no reference → "Multiple active antigravity jobs" (exit 1)
 *  - a reference is resolved id-exact → unique-substring → 1-based index.
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { filterJobsForCurrentSession } from "../lib/job-control.mjs";
import { stateDirFor, listProjectedJobs } from "../lib/job-runtime.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import { cancelJob } from "../lib/shared/core/job-control.mjs";
import { outputCommandResult, renderCancelReport } from "../lib/render.mjs";

const ACTIVE = new Set(["running", "queued"]);

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  let job;
  const stateDir = stateDirFor(cwd, process.env);
  // reconcile-per-invocation: a dead worker's running/queued job is finalized
  // BEFORE we resolve active jobs, so a stale-alive job is not offered to cancel.
  reconcileDeadPids(stateDir);
  try {
    job = resolveCancelableJob(stateDir, reference, process.env);
  } catch (err) {
    process.stderr.write(`antigravity:cancel — ${err?.message ?? err}\n`);
    return 1;
  }

  const result = cancelJob(stateDir, job.id);
  if (!result.ok) {
    // The worker (or reconcile) finalized first — respect it, do not clobber.
    process.stderr.write(`antigravity:cancel — ${result.message}\n`);
    return 1;
  }

  // Re-read the now-cancelled job for the report + the authoritative pid the
  // shared runtime signalled (post-finalize JSON carries the worker's stamp).
  const cancelled = listProjectedJobs(stateDir).find((j) => j.id === job.id) ?? job;
  const pid = Number(cancelled.pid);
  const rendered = renderCancelReport({ ...cancelled, status: "cancelled" });
  outputCommandResult(
    {
      jobId: job.id,
      status: "cancelled",
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      killed: Number.isFinite(pid) && pid > 0,
    },
    rendered,
    json,
  );
  return 0;
}

// Ported from job-control.resolveCancelableJob onto the shared layout. Active
// jobs are session-scoped (D-14) so a cancel only ever touches this session's
// jobs; an explicit reference still resolves within that active set.
function resolveCancelableJob(stateDir, reference, env = process.env) {
  const jobs = filterJobsForCurrentSession(listProjectedJobs(stateDir), env);
  const activeJobs = jobs.filter((j) => ACTIVE.has(j.status));

  if (activeJobs.length === 0) {
    throw new Error("No active antigravity jobs to cancel.");
  }

  if (activeJobs.length > 1) {
    const ids = activeJobs.map((j) => j.id).join(", ");
    if (!reference) {
      throw new Error(
        `Multiple active antigravity jobs; pass a job id. Active jobs: ${ids}`,
      );
    }
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job matched "${reference}". Active jobs: ${ids}`);
    }
    return selected;
  }

  const selected = matchJobReference(activeJobs, reference);
  if (!selected) {
    const ids = activeJobs.map((j) => j.id).join(", ");
    throw new Error(`No active job matched "${reference}". Active jobs: ${ids}`);
  }
  return selected;
}

// id-exact → unique-substring → 1-based positional index.
function matchJobReference(jobs, reference) {
  if (!reference) return jobs[0] ?? null;

  const exact = jobs.find((j) => j.id === reference);
  if (exact) return exact;

  const partial = jobs.filter((j) => j.id.includes(reference));
  if (partial.length === 1) return partial[0];

  const idx = Number(reference);
  if (Number.isFinite(idx) && idx >= 1 && idx <= jobs.length) {
    return jobs[idx - 1];
  }
  return null;
}

export default run;

runAsMain(import.meta.url, run, "cancel");
