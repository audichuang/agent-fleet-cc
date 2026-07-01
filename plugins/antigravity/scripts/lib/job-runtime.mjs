// plugins/antigravity/scripts/lib/job-runtime.mjs
// Launch + projection seam for the antigravity commands (spec §4/§5). Owns the
// foreground/background launch helpers (mirroring cc's cc-companion launch
// path) and the projectJob/listProjectedJobs seam that maps a shared job record
// onto the antigravity-shaped fields render.mjs + the command exit-code
// branches consume. Keeping the projection here lets Phase 4 flip commands
// mechanically. Imports the VENDORED shared runtime (./shared/...) + adapter.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJobRecord } from "./shared/core/job.mjs";
import {
  createJob,
  readJob,
  listJobs,
  pruneJobs,
  finalizeJob,
} from "./shared/core/state-store.mjs";
import { runWorker, installCancelForwarder } from "./shared/runtime/worker.mjs";
import {
  makeAntigravityAdapter,
  resolveDataRoot,
  workspaceStateDir,
  resolveAgyTimeouts,
} from "./adapter.mjs";

// Auth-by-text (belt-and-suspenders, plan BEHAVIOR CHANGE 1): an agy that prints
// its auth prompt to stdout and exits 0 finalizes failed via extractResult, but
// classifyError runs on (possibly empty) stderr → "unknown". Re-detect auth from
// resultText here so errorKind:"auth" survives the stdout-auth case too.
const AUTH_RE =
  /Authentication required|accounts\.google\.com\/o\/oauth2\/auth|not (?:authenticated|logged in)/i;

export function stateDirFor(cwd, env = process.env) {
  return workspaceStateDir(resolveDataRoot(env), cwd);
}

// updatedAt-desc re-sort (D-7 / codex regression fix): shared listJobs sorts by
// createdAt (state-store.mjs), but status/result present newest-activity-first.
// Ported from job-control.mjs's sortJobsNewestFirst.
function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
  );
}

// Shared job → antigravity-shaped fields the render.mjs helpers expect.
// resultText → result.rawOutput; errorKind==="auth" (or auth-in-text) → auth.
export function projectJob(job) {
  if (!job) return null;
  const authByText =
    job.status === "failed" &&
    typeof job.resultText === "string" &&
    AUTH_RE.test(job.resultText);
  const errorKind = authByText ? "auth" : (job.errorKind ?? null);
  return {
    ...job,
    kind: job.request?.kind ?? "task",
    conversationId: job.request?.conversationId ?? null,
    threadId: null,
    summary: firstLine(job.resultText),
    errorMessage: job.error ?? null,
    errorKind,
    result:
      job.resultText != null
        ? { rawOutput: job.resultText, status: job.status, exitCode: job.exitCode ?? null }
        : null,
  };
}

// listJobs → updatedAt desc → projectJob. Shared by status + result so ordering
// (and projection) is identical across the two read commands (D-7).
export function listProjectedJobs(stateDir) {
  return sortJobsNewestFirst(listJobs(stateDir)).map(projectJob);
}

function firstLine(t) {
  if (typeof t !== "string") return null;
  const l = t.split("\n").map((s) => s.trim()).find(Boolean) ?? null;
  return l && l.length > 120 ? `${l.slice(0, 117)}...` : l;
}

function makeRecord({ cwd, kind, title, request, env }) {
  const { printMs, hardMs } = resolveAgyTimeouts(env);
  // D-19 (codex M4): the Node backstop must never pre-empt agy's own
  // --print-timeout, which buildInvocation derives from request.printTimeoutMs
  // ?? env printMs. Clamp against that EFFECTIVE print timeout, not just env
  // printMs — a per-request printTimeoutMs larger than hardMs must still win.
  const effPrintMs =
    Number(request?.printTimeoutMs) > 0 ? Number(request.printTimeoutMs) : printMs;
  const requested = Number(request?.timeoutMs);
  const timeoutMs = Math.max(
    Number.isFinite(requested) && requested > 0 ? requested : hardMs,
    effPrintMs,
  );
  const record = createJobRecord({
    engine: "antigravity",
    title,
    cwd,
    timeoutMs,
    request: { ...request, kind },
  });
  // D-14 (codex M1): the host session id lives in top-level sessionId (where
  // filterJobsForCurrentSession reads it); agy engine sessionId is always null
  // (HARD FACT 4), so this field is free to carry it. createJobRecord defaults
  // it to null — overwrite from ANTIGRAVITY_PLUGIN_SESSION_ID.
  record.sessionId = env.ANTIGRAVITY_PLUGIN_SESSION_ID ?? null;
  return record;
}

// FOREGROUND (rescue/review/adversarial/image + task --foreground): in-process
// await of the shared worker lifecycle, then return the projected terminal job.
export async function runForeground({
  cwd,
  kind,
  title,
  prompt,
  request,
  env = process.env,
  deps = {},
}) {
  const stateDir = stateDirFor(cwd, env);
  const record = makeRecord({ cwd, kind, title, request, env });
  createJob(stateDir, record, prompt);
  pruneJobs(stateDir);
  const forwarder = installCancelForwarder({});
  try {
    await runWorker({
      stateDir,
      jobId: record.id,
      adapter: makeAntigravityAdapter({ env }),
      deps: { baseEnv: env, onChild: forwarder.onChild, ...deps },
    });
  } finally {
    forwarder.dispose();
  }
  return { stateDir, job: projectJob(readJob(stateDir, record.id)) };
}

// BACKGROUND (task default, review/rescue --background): spawn worker-entry.mjs
// detached (2-arg <stateDir> <jobId>). cc F3 sync-throw guard: if the spawn
// itself throws, finalize the queued job failed so it is never stuck queued.
export function startBackground({
  cwd,
  kind,
  title,
  prompt,
  request,
  env = process.env,
  deps = {},
}) {
  const stateDir = stateDirFor(cwd, env);
  const record = makeRecord({ cwd, kind, title, request, env });
  createJob(stateDir, record, prompt);
  pruneJobs(stateDir);
  const workerPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "worker-entry.mjs",
  );
  let child;
  try {
    child = (deps.workerSpawnImpl ?? spawn)(
      process.execPath,
      [workerPath, stateDir, record.id],
      { detached: true, stdio: "ignore", env: { ...env } },
    );
  } catch (error) {
    finalizeJob(stateDir, record.id, {
      status: "failed",
      error: String(error?.message ?? error),
      errorKind: "spawn",
    });
    return { stateDir, job: projectJob(readJob(stateDir, record.id)), failed: true };
  }
  child.unref();
  return { stateDir, job: projectJob(readJob(stateDir, record.id)), failed: false };
}
