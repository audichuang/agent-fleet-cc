/**
 * /antigravity:result — fetch a finished job's stored output.
 *
 * Reads the shared runtime (dir-per-job). The shared job record is projected
 * (job-runtime.projectJob) into the shape render.mjs expects: resultText →
 * result.rawOutput, error → errorMessage, auth re-detected into errorKind.
 *
 * Exit codes:
 *   0  completed
 *   1  failed / timed-out (or no job found)
 *   2  cancelled
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { stateDirFor, listProjectedJobs, filterJobsForCurrentSession } from "../lib/job-runtime.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import { outputCommandResult, renderResultOutput } from "../lib/render.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed-out"]);
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
  let workspaceRoot;
  try {
    ({ workspaceRoot, job } = resolveResultJob(cwd, reference, process.env));
  } catch (err) {
    process.stderr.write(`antigravity:result — ${err?.message ?? err}\n`);
    return 1;
  }

  // projected job carries result.rawOutput; pass it as BOTH render args so the
  // renderResultOutput(cwd, job, storedJob) contract never sees undefined (M5).
  const rendered = renderResultOutput(workspaceRoot, job, job);
  const payload = {
    jobId: job.id,
    status: job.status,
    conversationId: job.conversationId ?? null,
    result: job.result ?? null,
    rendered,
  };
  outputCommandResult(payload, rendered, json);

  switch (job.status) {
    case "completed":
      return 0;
    case "cancelled":
      return 2;
    default:
      return 1; // failed / timed-out / anything non-terminal-success
  }
}

// Ported from job-control.resolveResultJob: without a reference the search is
// session-scoped (D-14); with an explicit reference it spans the workspace.
// Selection helper: id-exact → unique-substring → 1-based positional index.
function resolveResultJob(cwd, reference, env = process.env) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateDir = stateDirFor(cwd, env);
  reconcileDeadPids(stateDir);
  const all = listProjectedJobs(stateDir);
  const jobs = reference ? all : filterJobsForCurrentSession(all, env);

  const selected = matchJobReference(jobs, reference, (j) => TERMINAL.has(j.status));
  if (selected) return { workspaceRoot, job: selected };

  const active = matchJobReference(jobs, reference, (j) => ACTIVE.has(j.status));
  if (active) {
    throw new Error(
      `Job ${active.id} is still ${active.status}. Run /antigravity:status ${active.id} ` +
        `to check progress, or /antigravity:status ${active.id} --wait to wait.`,
    );
  }

  if (reference) {
    throw new Error(
      `No job found for "${reference}". Run /antigravity:status to inspect active jobs.`,
    );
  }

  throw new Error("No finished antigravity jobs found for this repository yet.");
}

function matchJobReference(jobs, reference, filter) {
  const candidates = filter ? jobs.filter(filter) : jobs;
  if (!reference) return candidates[0] ?? null;

  const exact = candidates.find((j) => j.id === reference);
  if (exact) return exact;

  const partial = candidates.filter((j) => j.id.includes(reference));
  if (partial.length === 1) return partial[0];

  const idx = Number(reference);
  if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
    return candidates[idx - 1];
  }
  return null;
}

export default run;

runAsMain(import.meta.url, run, "result");
