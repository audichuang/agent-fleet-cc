#!/usr/bin/env node
// CLI entry. Commands: setup | task | status | result | cancel | wait | logs
// Testable via runCompanion(argv, deps) with injectable seams.
//
// Job runtime (state/worker/cancel/reconcile) lives in the vendored shared lib;
// grok-specific engine knowledge lives in ./lib/adapter.mjs. Auth is delegated
// to the grok CLI — this companion never handles secrets and has no profiles.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, UsageError } from "./lib/shared/args.mjs";
import { createJobRecord, TERMINAL_STATUSES, ACTIVE_STATUSES } from "./lib/shared/core/job.mjs";
import {
  createJob,
  readJob,
  listJobs,
  pruneJobs,
  finalizeJob,
  logFilePath,
  jobDir,
} from "./lib/shared/core/state-store.mjs";
import { reconcileDeadPids } from "./lib/shared/core/reconcile.mjs";
import { cancelJob } from "./lib/shared/core/job-control.mjs";
import { waitForJob } from "./lib/shared/core/wait.mjs";
import { readEvents } from "./lib/shared/core/events.mjs";
import { collectLiveness, formatLiveness } from "./lib/shared/core/liveness.mjs";
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { makeGrokAdapter, resolveDataRoot, workspaceStateDir } from "./lib/adapter.mjs";
import { renderStatus, renderResult } from "./lib/render.mjs";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const USAGE = `usage: grok-companion <command> [...]
  setup
  task <prompt...>|--prompt-file <path> [--read-only] [--model <id>] [--effort none|minimal|low|medium|high|xhigh|max] [--no-subagents] [--schema <path>] [--background|--wait|--live] [--json] [--resume-job <job>|--resume-last] [--timeout-ms <n>]
  status [--json]
  result [<job-id>|--last] [--json]
  cancel <job-id> [--json]
  wait <job-id> [--timeout-s <n>] [--json]
  logs <job-id> [--follow]`;

const TASK_FLAGS = {
  valueFlags: ["model", "effort", "resume-job", "timeout-ms", "prompt-file", "schema"],
  boolFlags: ["background", "wait", "live", "resume-last", "json", "no-subagents", "read-only"],
};

// --schema <path>: read a JSON Schema file and pass it to grok's --json-schema
// (constrains the model to matching JSON; grok returns the JSON in resultText).
// A file keeps big schemas out of the shell-quoting minefield. Validate here so
// a typo fails fast instead of at engine spawn.
function readSchemaFile(schemaPath, cwd) {
  if (!schemaPath) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(cwd, schemaPath), "utf8");
  } catch {
    throw new UsageError(`schema file not readable: ${schemaPath}`);
  }
  try {
    JSON.parse(raw);
  } catch {
    throw new UsageError(`schema file is not valid JSON: ${schemaPath}`);
  }
  return raw;
}

// Auth is delegated to the grok CLI, but a headless run with NO auth does not
// fail — it prints a device-code URL and blocks on "Waiting for authorization"
// until the job timeout (1h). Preflight the same two sources `setup` reports and
// refuse fast. Skip when a custom binary is injected (tests/e2e fakes own their
// auth) or when explicitly overridden.
function hasGrokAuth(env) {
  if (env.XAI_API_KEY) return true;
  return Boolean(env.HOME && fs.existsSync(path.join(env.HOME, ".grok", "auth.json")));
}
function authPreflightNeeded(env, deps) {
  return !deps.binaryArgv && !env.GROK_BIN && env.GROK_SKIP_AUTH_PREFLIGHT !== "1";
}

function safeJobId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new UsageError(`Invalid job id: ${value}`);
  }
  return value;
}

function parseTimeoutMs(value, env) {
  if (value === undefined) {
    const raw = Number(env.GROK_JOB_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--timeout-ms must be a positive number, got: ${value}`);
  }
  return n;
}

function resultProjection(job) {
  return {
    engine: "grok",
    jobId: job.id,
    status: job.status,
    resultText: job.resultText ?? null,
    sessionId: job.sessionId ?? null,
    exitCode: job.exitCode ?? null,
    error: job.error ?? null,
    errorKind: job.errorKind ?? null,
    durationMs: job.durationMs ?? null,
  };
}

export async function runCompanion(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line) => process.stdout.write(line + "\n"));
  if (env.GROK_FLEET_ACTIVE === "1") {
    out("grok: disabled inside a grok session (recursion guard).");
    return 0;
  }
  const cwd = deps.cwd ?? process.cwd();
  const dataRoot = resolveDataRoot(env);
  const stateDir = workspaceStateDir(dataRoot, cwd);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return cmdSetup({ env, out, deps });
      case "task":
        return await cmdTask({ argv: rest, env, out, cwd, stateDir, deps });
      case "status":
        return cmdStatus({ argv: rest, out, stateDir, deps });
      case "result":
        return cmdResult({ argv: rest, out, stateDir });
      case "cancel":
        return cmdCancel({ argv: rest, out, stateDir });
      case "wait":
        return await cmdWait({ argv: rest, out, stateDir, deps });
      case "logs":
        return await cmdLogs({ argv: rest, out, stateDir });
      default:
        out(USAGE);
        return command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      out(`grok: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function cmdSetup({ env, out, deps }) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const binary = env.GROK_BIN ?? "grok";
  let healthy = true;
  const probe = spawnSyncImpl(binary, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    out(`✗ grok CLI not runnable (${binary}). Install Grok Build from https://x.ai/cli first.`);
    healthy = false;
  } else {
    out(`✓ grok CLI: ${String(probe.stdout).trim()}`);
  }
  // Auth is delegated to the grok CLI. Report the two accepted sources.
  const authFile = path.join(env.HOME ?? "", ".grok", "auth.json");
  if (env.XAI_API_KEY) {
    out("✓ auth: XAI_API_KEY is set");
  } else if (env.HOME && fs.existsSync(authFile)) {
    out(`✓ auth: cached token at ${authFile}`);
  } else {
    out("• auth: none detected — run `!grok login` (SuperGrok / X Premium+) or set XAI_API_KEY");
  }
  out(`default model: ${env.GROK_DEFAULT_MODEL ?? "grok-4.5"}`);
  return healthy ? 0 : 1;
}

function resolveResumeSource({ flags, stateDir }) {
  if (flags["resume-job"]) {
    const source = readJob(stateDir, safeJobId(flags["resume-job"]));
    if (!source) throw new UsageError(`No job ${flags["resume-job"]} to resume`);
    if (!source.sessionId) throw new UsageError(`Job ${source.id} has no session id to resume`);
    return source;
  }
  if (flags["resume-last"]) {
    const source = listJobs(stateDir).find(
      (j) => TERMINAL_STATUSES.has(j.status) && j.sessionId,
    );
    if (!source) throw new UsageError("No resumable job in this workspace");
    return source;
  }
  return null;
}

async function startJob({ prompt, flags, env, out, cwd, stateDir, deps }) {
  const jsonSchema = readSchemaFile(flags.schema, cwd); // UsageError on bad file/JSON
  if (authPreflightNeeded(env, deps) && !hasGrokAuth(env)) {
    const msg =
      "not authenticated — run `!grok login` (SuperGrok / X Premium+) or set XAI_API_KEY. " +
      "Skipping launch to avoid a headless OAuth hang. (Override: GROK_SKIP_AUTH_PREFLIGHT=1.)";
    out(flags.json ? JSON.stringify({ engine: "grok", status: "failed", errorKind: "auth", error: msg }) : `grok: ${msg}`);
    return 1;
  }
  const source = resolveResumeSource({ flags, stateDir });
  const record = createJobRecord({
    engine: "grok",
    title: prompt.slice(0, 120),
    cwd,
    timeoutMs: parseTimeoutMs(flags["timeout-ms"], env),
    request: {
      model: flags.model ?? env.GROK_DEFAULT_MODEL ?? "grok-4.5",
      effort: flags.effort ?? env.GROK_DEFAULT_EFFORT ?? null,
      noSubagents: flags["no-subagents"] ?? false,
      readOnly: flags["read-only"] ?? false, // opt-in --sandbox read-only (OS-enforced no-write; also no network)
      jsonSchema,
      resumeSessionId: source?.sessionId ?? null,
      resumedFrom: source?.id ?? null,
      // test-only injection of a fake binary; undefined in production.
      binaryArgv: deps.binaryArgv,
    },
  });
  createJob(stateDir, record, prompt);
  pruneJobs(stateDir);

  if (flags.background) {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "worker-entry.mjs",
    );
    const spawnImpl = deps.workerSpawnImpl ?? spawn;
    let child;
    try {
      child = spawnImpl(process.execPath, [workerPath, stateDir, record.id], {
        detached: true,
        stdio: "ignore",
        env: { ...env },
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      finalizeJob(stateDir, record.id, { status: "failed", error: message, errorKind: "spawn" });
      const finished = readJob(stateDir, record.id);
      out(flags.json ? JSON.stringify(resultProjection(finished)) : `grok: failed to launch background worker: ${message}`);
      return 1;
    }
    child.unref();
    if (flags.json) {
      out(JSON.stringify({ engine: "grok", jobId: record.id, status: "queued" }));
    } else {
      out(`Started background job ${record.id} (model=${record.request.model}).`);
      out(`Check: status | result ${record.id} | cancel ${record.id}`);
    }
    return 0;
  }

  const forwarder = installCancelForwarder({});
  // --live: stream each raw engine line to stderr the instant the worker sees it
  // (runWorker's onLine hook — no file tail, no flush race), so a run_in_background
  // Claude Code shell shows live progress AND surfaces a non-zero exit the moment
  // the job dies (parity with codex's stderr progress). The authoritative result
  // still lands on stdout via renderResult below.
  const err = deps.err ?? ((line) => process.stderr.write(line + "\n"));
  try {
    await runWorker({
      stateDir,
      jobId: record.id,
      adapter: makeGrokAdapter(),
      deps: {
        spawnImpl: deps.grokSpawnImpl,
        baseEnv: env,
        onChild: forwarder.onChild,
        ...(flags.live ? { onLine: (line) => err(line) } : {}),
      },
    });
  } finally {
    forwarder.dispose();
  }
  const finished = readJob(stateDir, record.id);
  out(flags.json ? JSON.stringify(resultProjection(finished)) : renderResult(finished, readLogTail(stateDir, record.id)));
  return finished.status === "completed" ? 0 : 1;
}

async function cmdTask({ argv, env, out, cwd, stateDir, deps }) {
  const { flags, positionals } = parseArgs(argv, TASK_FLAGS);
  let prompt;
  if (flags["prompt-file"]) {
    try {
      prompt = fs.readFileSync(path.resolve(cwd, flags["prompt-file"]), "utf8");
    } catch {
      throw new UsageError(`prompt file not readable: ${flags["prompt-file"]}`);
    }
  } else {
    prompt = positionals.join(" ").trim();
  }
  if (!prompt) throw new UsageError("task requires a prompt or --prompt-file");
  if (flags.wait && flags.background) {
    throw new UsageError("--wait and --background are mutually exclusive");
  }
  if (flags.live && flags.background) {
    throw new UsageError("--live and --background are mutually exclusive");
  }
  if (flags.live && flags.wait) {
    throw new UsageError("--live and --wait are mutually exclusive (--live is already foreground)");
  }
  return startJob({ prompt, flags, env, out, cwd, stateDir, deps });
}

function readLogTail(stateDir, jobId, lines = 30) {
  try {
    const text = fs.readFileSync(logFilePath(stateDir, jobId), "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// liveness observation seams (injectable for hermetic tests); collectLiveness
// falls back to the real isPidAlive / git / Date.now when a seam is undefined.
function livenessDeps(deps = {}) {
  return { isAlive: deps.isAlive, gitChanges: deps.gitChanges, nowMs: deps.nowMs };
}

function cmdStatus({ argv, out, stateDir, deps = {} }) {
  const { flags } = parseArgs(argv, { boolFlags: ["json"] });
  reconcileDeadPids(stateDir);
  const jobs = listJobs(stateDir);
  const livenessById = {};
  for (const job of jobs) {
    if (!ACTIVE_STATUSES.has(job.status)) continue; // liveness only meaningful while active
    const live = collectLiveness(stateDir, job.id, livenessDeps(deps));
    if (live) livenessById[job.id] = live;
  }
  out(
    flags.json
      ? JSON.stringify(
          jobs.map((j) =>
            livenessById[j.id] ? { ...resultProjection(j), liveness: livenessById[j.id] } : resultProjection(j),
          ),
        )
      : renderStatus(jobs, livenessById),
  );
  return 0;
}

function cmdResult({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["last", "json"] });
  reconcileDeadPids(stateDir);
  const job = positionals[0] ? readJob(stateDir, safeJobId(positionals[0])) : listJobs(stateDir)[0];
  if (!job) {
    out(flags.json ? JSON.stringify({ error: "no jobs" }) : "No grok jobs in this workspace.");
    return 1;
  }
  out(flags.json ? JSON.stringify(resultProjection(job)) : renderResult(job, job.status === "completed" ? "" : readLogTail(stateDir, job.id)));
  return job.status === "completed" ? 0 : 1;
}

function cmdCancel({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["json"] });
  if (!positionals[0]) throw new UsageError("cancel requires a job id");
  const result = cancelJob(stateDir, safeJobId(positionals[0]));
  out(flags.json ? JSON.stringify(result) : result.message);
  return result.ok ? 0 : 1;
}

const WAIT_TIMEOUT_EXIT = 10;
function waitExitCode(status) {
  if (status === "completed") return 0;
  if (status === "cancelled") return 2;
  return 1;
}

async function cmdWait({ argv, out, stateDir, deps = {} }) {
  const { flags, positionals } = parseArgs(argv, { valueFlags: ["timeout-s"], boolFlags: ["json"] });
  if (!positionals[0]) throw new UsageError("wait requires a job id");
  const jobId = safeJobId(positionals[0]);
  if (!readJob(stateDir, jobId)) {
    out(flags.json ? JSON.stringify({ error: `no job ${jobId}` }) : `No job ${jobId} in this workspace.`);
    return 1;
  }
  const timeoutS = flags["timeout-s"] ? Number(flags["timeout-s"]) : 540;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    throw new UsageError(`--timeout-s must be a positive number, got: ${flags["timeout-s"]}`);
  }
  reconcileDeadPids(stateDir);
  // B1 watch loop: no per-event chatter. waitForJob blocks up to the caller's
  // timeout (the check interval); we emit exactly ONE line when it returns and
  // the commander loops. See commands/task.md and the design spec.
  const { done, job } = await waitForJob({
    stateDir,
    jobId,
    timeoutMs: timeoutS * 1000,
    reconcile: reconcileDeadPids,
    onEvent: () => {},
  });
  if (!job) {
    out(flags.json ? JSON.stringify({ error: `job ${jobId} no longer exists` }) : `Job ${jobId} no longer exists.`);
    return 1;
  }
  if (!done) {
    const live = collectLiveness(stateDir, jobId, livenessDeps(deps));
    // Race: waitForJob keys off job.json, but a terminal terminal.lock may
    // already be claimed while job.json still says running. The projection folds
    // the lock (authoritative). If it says terminal, relay the result now with
    // the right exit code instead of a false "still running" + exit 10.
    if (live && TERMINAL_STATUSES.has(live.status)) {
      const fresh = readJob(stateDir, jobId) ?? job;
      out(flags.json ? JSON.stringify(resultProjection(fresh)) : renderResult(fresh, ""));
      return waitExitCode(live.status);
    }
    // Still running: one compact liveness line, then exit 10 so the commander
    // reports "still alive" and re-invokes wait with the same interval. Uses the
    // authoritative projected status for the prefix.
    out(
      flags.json
        ? JSON.stringify({ ...resultProjection(job), liveness: live })
        : `[${jobId}] ${live?.status ?? job.status}  ${live ? formatLiveness(live) : ""}`.trimEnd(),
    );
    return WAIT_TIMEOUT_EXIT;
  }
  // Terminal: relay the FULL result exactly once (the liveness line never
  // replaces it). Exit 0 completed / 2 cancelled / 1 failed|timed-out.
  out(flags.json ? JSON.stringify(resultProjection(job)) : renderResult(job, ""));
  return waitExitCode(job.status);
}

async function cmdLogs({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["follow"] });
  if (!positionals[0]) throw new UsageError("logs requires a job id");
  const jobId = safeJobId(positionals[0]);
  if (!readJob(stateDir, jobId)) {
    out(`No job ${jobId} in this workspace.`);
    return 1;
  }
  // Story 10: logs shows the RAW grok stream (thought/text/end), not the normalized
  // lifecycle events — parseEvent drops `thought`, so the thinking only survives in
  // the raw stdout log the worker writes (logFilePath). Both modes read that file.
  const logPath = logFilePath(stateDir, jobId);
  if (!flags.follow) {
    let raw = "";
    try {
      raw = fs.readFileSync(logPath, "utf8");
    } catch {
      raw = "";
    }
    if (raw.trim()) {
      out(raw.replace(/\n$/, ""));
    } else {
      // Fall back to the lifecycle events if the raw log was never written
      // (e.g. the engine never spawned).
      for (const e of readEvents(jobDir(stateDir, jobId))) out(JSON.stringify(e));
    }
    return 0;
  }
  // --follow: tail the raw grok stream line-by-line until the job is terminal.
  let offset = 0;
  const drain = () => {
    let buf;
    try {
      buf = fs.readFileSync(logPath, "utf8");
    } catch {
      return;
    }
    if (buf.length <= offset) return;
    const fresh = buf.slice(offset);
    const lastNl = fresh.lastIndexOf("\n");
    if (lastNl < 0) return; // no complete line yet — wait for the newline
    offset += lastNl + 1;
    for (const line of fresh.slice(0, lastNl).split("\n")) if (line) out(line);
  };
  for (;;) {
    reconcileDeadPids(stateDir);
    drain();
    const job = readJob(stateDir, jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      drain();
      break;
    }
    await sleep(150);
  }
  return TERMINAL_STATUSES.has(readJob(stateDir, jobId)?.status) ? 0 : 1;
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  // Tolerate a consumer that closes the pipe early (e.g. `/grok:live … | head`):
  // stdout/stderr then emit an async EPIPE 'error' that would otherwise crash the
  // process mid-job and report a FALSE failure. Swallow EPIPE; surface anything else.
  for (const s of [process.stdout, process.stderr]) {
    s.on("error", (e) => {
      if (e?.code !== "EPIPE") throw e;
    });
  }
  // Set exitCode and let stdio drain naturally — NOT process.exit(), which drops
  // buffered pipe writes on exit. Under run_in_background stdout/stderr are pipes,
  // so process.exit() would truncate a large live stream or result (losing the tail,
  // incl. the terminal event). Natural exit flushes first, then exits with the code.
  runCompanion(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`grok: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
