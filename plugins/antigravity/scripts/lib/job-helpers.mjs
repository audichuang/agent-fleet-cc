/**
 * job-helpers — shared helpers for command modules.
 *
 * Provides job id minting, foreground/background tracking glue, and stdout
 * persistence around `runAgyPrint` / `spawnAgyDetached`. agy's print mode only
 * exposes a final-response stdout — no streaming, no tool events — so the
 * helpers here intentionally avoid any event-bus or phase machinery.
 */

import { randomBytes } from "node:crypto";

import { runAgyPrint, spawnAgyDetached, resolveAgyBin, resolveAgyTimeouts } from "./agent-runtime.mjs";
import { deriveSummary, trimToNull } from "./text.mjs";
import {
  appendJobLog,
  resolveJobLogFile,
  upsertJob,
  writeJobFile,
  readJobFile,
} from "./state.mjs";
import { SESSION_ID_ENV } from "./job-control.mjs";

/** Generate a short, URL-safe job id (12 hex chars). */
export function newJobId() {
  return randomBytes(6).toString("hex");
}

/** Resolve the current session id (or `null` if unset). */
export function currentSessionId(env = process.env) {
  return env[SESSION_ID_ENV] ?? null;
}

/**
 * Map a `runAgyPrint` result.status onto a job status persisted on disk.
 *
 * `auth_required` and `timeout` are surfaced as `failed` with a diagnostic
 * `healthStatus` set so the status command can render the OAuth URL.
 */
function deriveJobStatus(result) {
  switch (result.status) {
    case "completed":
      return { status: "completed" };
    case "cancelled":
      return { status: "cancelled" };
    case "auth_required":
      return {
        status: "failed",
        healthStatus: "auth_required",
        healthMessage:
          "Antigravity is not authenticated. Complete the OAuth flow shown above, then re-run.",
        recommendedAction: "Run /antigravity:setup to complete the OAuth flow.",
      };
    case "timeout":
      return {
        status: "failed",
        healthStatus: "failed",
        healthMessage: "agy --print timed out before producing output.",
        recommendedAction: "Re-run the command, optionally with --background.",
      };
    case "failed":
    default:
      return {
        status: "failed",
        healthStatus: "failed",
      };
  }
}

/**
 * Create a tracked job record on disk.
 *
 * Returns the job index entry. The detailed payload (request, result,
 * stdout) lives in the per-job file written via `writeJobFile`.
 */
export async function createTrackedJob({
  workspaceRoot,
  kind,
  title,
  request = null,
  conversationId = null,
  env = process.env,
}) {
  const id = newJobId();
  const now = new Date().toISOString();
  const sessionId = currentSessionId(env);
  const job = {
    id,
    kind,
    title: title ?? null,
    status: "queued",
    phase: "queued",
    sessionId,
    pid: null,
    conversationId,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    logFile: resolveJobLogFile(workspaceRoot, id),
  };
  await upsertJob(workspaceRoot, job);
  await writeJobFile(workspaceRoot, id, {
    ...job,
    request,
    result: null,
  });
  appendJobLog(workspaceRoot, id, `[job] created kind=${kind}`);
  return job;
}

/** Patch and persist a job index + file. */
export async function patchJob(workspaceRoot, jobId, patch) {
  const existing = readJobFile(workspaceRoot, jobId) ?? { id: jobId };
  const merged = { ...existing, ...patch, id: jobId };
  await upsertJob(workspaceRoot, {
    id: jobId,
    ...stripDetail(patch),
  });
  await writeJobFile(workspaceRoot, jobId, merged);
  return merged;
}

/** Strip detail-only fields (request/result/stdout) from a patch destined for the index. */
function stripDetail(patch) {
  const { request: _r, result: _re, stdout: _s, ...rest } = patch;
  return rest;
}

/**
 * Run an agy --print call in the FOREGROUND while tracking it as a job.
 *
 * The job is created with status=queued, transitioned to running, and
 * resolved to completed/failed/cancelled based on the runAgyPrint result.
 *
 * @returns {Promise<{ job: any, result: any }>}
 */
export async function runForegroundJob({
  workspaceRoot,
  kind,
  title,
  prompt,
  mode = "print",
  conversationId,
  addDirs = [],
  model,
  sandbox = false,
  cwd,
  request = null,
  env = process.env,
  onStdout,
  onStderr,
} = {}) {
  const { printMs, hardMs } = resolveAgyTimeouts(env);
  const job = await createTrackedJob({
    workspaceRoot,
    kind,
    title,
    request,
    conversationId,
    env,
  });

  const startedAt = new Date().toISOString();
  await patchJob(workspaceRoot, job.id, {
    status: "running",
    phase: "running",
    startedAt,
    pid: process.pid,
  });
  appendJobLog(workspaceRoot, job.id, `[job] running (foreground) pid=${process.pid}`);

  let result;
  try {
    result = await runAgyPrint({
      prompt,
      mode,
      conversationId,
      addDirs,
      model,
      sandbox,
      cwd: cwd ?? workspaceRoot,
      timeoutMs: hardMs,
      printTimeoutMs: printMs,
      onStdout,
      onStderr,
    });
  } catch (err) {
    const completedAt = new Date().toISOString();
    appendJobLog(workspaceRoot, job.id, `[job] crashed: ${err?.message ?? err}`);
    await patchJob(workspaceRoot, job.id, {
      status: "failed",
      phase: "failed",
      completedAt,
      errorMessage: err?.message ?? String(err),
      healthStatus: "failed",
    });
    throw err;
  }

  const completedAt = new Date().toISOString();
  const derived = deriveJobStatus(result);
  await patchJob(workspaceRoot, job.id, {
    status: derived.status,
    phase: derived.status,
    completedAt,
    exitCode: result.exitCode,
    summary: deriveSummary(result.stdout),
    oauthUrl: result.oauthUrl ?? null,
    errorMessage: result.status === "failed" ? trimToNull(result.stderr) : null,
    healthStatus: derived.healthStatus ?? null,
    healthMessage: derived.healthMessage ?? null,
    recommendedAction: derived.recommendedAction ?? null,
    result: {
      rawOutput: result.stdout,
      stderr: result.stderr,
      status: result.status,
      exitCode: result.exitCode,
      oauthUrl: result.oauthUrl ?? null,
    },
  });
  appendJobLog(
    workspaceRoot,
    job.id,
    `[job] ${derived.status} exit=${result.exitCode} status=${result.status}`,
  );
  return { job: { ...job, status: derived.status }, result };
}

/**
 * Fire-and-forget a background worker that will run the prompt with the
 * given mode. Returns the queued job index entry.
 *
 * The worker script lives at scripts/commands/_worker.mjs and is invoked as
 * `node <worker.mjs> <jobId>`.
 */
export async function startBackgroundJob({
  workspaceRoot,
  kind,
  title,
  prompt,
  mode = "print",
  conversationId = null,
  addDirs = [],
  cwd,
  request = null,
  env = process.env,
}) {
  const job = await createTrackedJob({
    workspaceRoot,
    kind,
    title,
    request: {
      prompt,
      mode,
      conversationId,
      addDirs,
      cwd: cwd ?? workspaceRoot,
      ...(request ?? {}),
    },
    conversationId,
    env,
  });

  const workerPath = new URL("../commands/_worker.mjs", import.meta.url).pathname;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [workerPath, job.id], {
    cwd: workspaceRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...env, [SESSION_ID_ENV]: env[SESSION_ID_ENV] ?? "" },
  });
  child.unref();

  await patchJob(workspaceRoot, job.id, {
    pid: child.pid ?? null,
  });
  appendJobLog(workspaceRoot, job.id, `[job] dispatched worker pid=${child.pid}`);

  // Best-effort: spawn a detached liveness watchdog that reaps this job if the
  // worker dies or wedges, without anyone needing to poll /antigravity:status.
  try {
    const watchdogPath = new URL("../commands/_watchdog.mjs", import.meta.url).pathname;
    const watchdog = spawn(process.execPath, [watchdogPath, workspaceRoot, job.id], {
      cwd: workspaceRoot,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...env, [SESSION_ID_ENV]: env[SESSION_ID_ENV] ?? "" },
    });
    watchdog.unref();
  } catch {
    // The watchdog is a safety net; never block job launch on its failure.
  }

  return { job, pid: child.pid ?? null };
}

/**
 * Block in the current process until a job reaches a terminal state.
 *
 * Polls at `pollMs` (default 1000ms). Returns the latest job record. Times
 * out after `timeoutMs` (0 = no timeout).
 */
export async function waitForJob(workspaceRoot, jobId, { pollMs = 1000, timeoutMs = 0 } = {}) {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  while (true) {
    const job = readJobFile(workspaceRoot, jobId);
    if (job && TERMINAL.has(job.status)) return job;
    if (deadline && Date.now() > deadline) return job ?? null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Re-export so command modules can pull everything from one place. */
export { runAgyPrint, spawnAgyDetached, resolveAgyBin };
