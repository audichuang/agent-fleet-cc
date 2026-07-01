/**
 * /antigravity:status — list active/recent jobs or inspect one.
 *
 * Reads the shared runtime (dir-per-job + reconcile). Health/heartbeat/watchdog
 * fields are gone (spec §7 #4 / D-16): the shared reconcile-per-poll +
 * reconcileDeadPids replaces the old health classifier, so the status snapshot
 * no longer carries healthStatus/lastProgressAt/oauthUrl.
 *
 * Positional: <job-id> (optional). When present, render the detailed view.
 * Flags:
 *   --wait        block until the job (or all active jobs) reach terminal state.
 *   --timeout-ms <ms>  override the wait timeout (default 15m).
 *   --json        emit JSON instead of markdown.
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { filterJobsForCurrentSession } from "../lib/job-control.mjs";
import { getConfig } from "../lib/agy-config.mjs";
import { stateDirFor, listProjectedJobs } from "../lib/job-runtime.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import {
  outputCommandResult,
  renderStatusSnapshot,
  renderSingleJobStatus,
} from "../lib/render.mjs";

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 1000;
const DEFAULT_MAX_STATUS_JOBS = 8;
const ACTIVE = new Set(["running", "queued"]);

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["timeout-ms", "cwd"],
    booleanOptions: ["wait", "json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  if (reference) {
    if (options.wait) {
      const finished = await waitForSingleJob(cwd, reference, options);
      const rendered = renderSingleJobStatus(finished);
      outputCommandResult(finished, rendered, json);
      return 0;
    }
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    const rendered = renderSingleJobStatus(snapshot);
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

// listProjectedJobs already returns updatedAt-desc + projectJob'd jobs. Session
// filter reads top-level sessionId (D-14). Health fields are absent by design.
function sessionJobs(cwd, env = process.env) {
  const stateDir = stateDirFor(cwd, env);
  reconcileDeadPids(stateDir);
  return {
    stateDir,
    jobs: filterJobsForCurrentSession(listProjectedJobs(stateDir), env),
  };
}

function buildStatusSnapshot(cwd, options = {}) {
  const env = options.env ?? process.env;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const { stateDir, jobs } = sessionJobs(cwd, env);
  const config = getConfig(stateDir);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;

  const running = jobs.filter((j) => ACTIVE.has(j.status));
  const recent = jobs.filter((j) => !ACTIVE.has(j.status)).slice(0, maxJobs);

  return {
    workspaceRoot,
    config,
    running,
    latestFinished: recent[0] ?? null,
    recent,
    needsReview: Boolean(config.stopReviewGate),
  };
}

function buildSingleJobSnapshot(cwd, reference, env = process.env) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const { jobs } = sessionJobsAllForReference(cwd, env);
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(
      `No job found for "${reference}". Run /antigravity:status to inspect known jobs.`,
    );
  }
  return { workspaceRoot, job: selected };
}

// A single-job lookup by explicit reference is NOT session-scoped (mirrors the
// old resolveResultJob behavior: an explicit id resolves across the workspace).
function sessionJobsAllForReference(cwd, env = process.env) {
  const stateDir = stateDirFor(cwd, env);
  reconcileDeadPids(stateDir);
  return { stateDir, jobs: listProjectedJobs(stateDir) };
}

// Ported from job-control.matchJobReference: id-exact → unique-substring →
// 1-based positional index.
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

async function waitForSingleJob(cwd, reference, options) {
  const timeoutMs = Number(options["timeout-ms"]) || DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = buildSingleJobSnapshot(cwd, reference);
    const status = snap.job?.status;
    if (!ACTIVE.has(status)) {
      return snap; // any terminal status (completed/failed/cancelled/timed-out)
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default run;

runAsMain(import.meta.url, run, "status");
