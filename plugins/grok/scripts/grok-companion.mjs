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
import crypto from "node:crypto";
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
  task <prompt...>|--prompt-file <path> [--read-only] [--research] [--max-turns <n>] [--no-memory] [--model <id>] [--effort <level>] [--no-subagents] [--schema <path>] [--background|--wait|--live] [--json] [--resume-job <job>|--resume-last] [--timeout-ms <n>]
  status [--json]
  result [<job-id>|--last] [--json]
  cancel <job-id> [--json]
  wait <job-id> [--timeout-s <n>] [--json]
  logs <job-id> [--follow]`;

const TASK_FLAGS = {
  valueFlags: ["model", "effort", "resume-job", "timeout-ms", "prompt-file", "schema", "max-turns"],
  boolFlags: ["background", "wait", "live", "resume-last", "json", "no-subagents", "read-only", "research", "no-memory"],
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
  // Emptiness first: JSON.parse("") also throws, but "not valid JSON" is the
  // wrong story for a file the user meant to fill in and didn't.
  if (!raw.trim()) throw new UsageError(`schema file is empty: ${schemaPath}`);
  try {
    JSON.parse(raw);
  } catch {
    throw new UsageError(`schema file is not valid JSON: ${schemaPath}`);
  }
  return raw;
}

// --- `setup`'s advisory auth report ----------------------------------------
// These two are a BEST-EFFORT REPORT of the credential sources a user probably
// has, for `/grok:setup` to print. They gate NOTHING: seeing a source here is no
// proof grok will accept it (an empty/garbage GROK_AUTH, an empty auth.json, a
// per-model `api_key` we never look at), and seeing none is no proof it will not.
// Auth resolution belongs to the grok CLI, which fails closed in milliseconds
// (xai-grok-pager/src/headless.rs:459-480 fn `authenticate` — "failing closed
// when none is available"; message at :445-457 `auth_required_message`).
//
// Where grok itself looks for a cached token: $GROK_AUTH_PATH, else
// <grok home>/auth.json, where grok home is $GROK_HOME else <home>/.grok
// (xai-grok-shell/src/auth/manager.rs:306-313; xai-grok-home/src/lib.rs:29-45
// resolve_grok_home_from). No base dir at all → nothing to look at, so `null`
// rather than a relative `.grok/auth.json`.
function grokAuthFile(env) {
  if (env.GROK_AUTH_PATH) return env.GROK_AUTH_PATH;
  const home = env.GROK_HOME || (env.HOME ? path.join(env.HOME, ".grok") : null);
  return home ? path.join(home, "auth.json") : null;
}

// Env keys that authenticate model sampling, in grok's own order: XAI_API_KEY,
// then the legacy GROK_CODE_XAI_API_KEY (read_xai_api_key_env,
// xai-grok-shell/src/agent/auth_method.rs:26-43), then GROK_AUTH — inline JSON
// credentials, the highest-priority source of all (auth/manager.rs:315-328).
// GROK_DEPLOYMENT_KEY is deliberately NOT here: resolve_credentials never
// consults it (BYOK → cached provider token → session → XAI_API_KEY env,
// agent/config.rs:4801-4825) — it authenticates grok's backend/management calls,
// not sampling, so reporting it as "auth" would mislead a deployment-key-only user.
const AUTH_ENV_KEYS = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_AUTH"];

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

// --max-turns <n>: a runaway-cost fuse (grok's own clap range is 1.., cli.rs:685).
// Validate here so a typo/negative value fails fast instead of at engine spawn.
function parseMaxTurns(value) {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`--max-turns must be a positive integer, got: ${value}`);
  }
  return n;
}

function resultProjection(job) {
  return {
    engine: "grok",
    jobId: job.id,
    status: job.status,
    resultText: job.resultText ?? null,
    // effectiveSessionId, not job.sessionId: a worker that died before finalize
    // has only the pre-minted request.sessionId, and a --json consumer that sees
    // null there cannot tell the job is still resumable (see renderResult).
    sessionId: effectiveSessionId(job),
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
  // Advisory only — see AUTH_ENV_KEYS / grokAuthFile above. Nothing here gates a
  // launch; grok resolves (and refuses) its own credentials.
  const envKey = AUTH_ENV_KEYS.find((k) => env[k]);
  const authFile = grokAuthFile(env);
  if (envKey) {
    out(`✓ auth: ${envKey} is set`);
  } else if (authFile && fs.existsSync(authFile)) {
    out(`✓ auth: cached token at ${authFile}`);
  } else {
    out(
      "• auth: none of the sources we can see is set — if a run fails with `auth`, " +
        "run `!grok login --device-code` (SuperGrok / X Premium+) or set XAI_API_KEY",
    );
  }
  out(`default model: ${env.GROK_DEFAULT_MODEL ?? "grok-4.5"}`);
  return healthy ? 0 : 1;
}

// job.sessionId is the post-hoc value extractResult reports off the `end` event
// (only written once the worker finalizes normally). job.request.sessionId is the
// SAME id, minted+persisted before spawn (see startJob) — it survives a worker
// crash that never reaches finalize, which is the entire point of pre-generating
// it. Prefer the post-hoc one when present (belt-and-braces; they should match).
function effectiveSessionId(job) {
  return job?.sessionId ?? job?.request?.sessionId ?? null;
}

function resolveResumeSource({ flags, stateDir }) {
  if (flags["resume-job"]) {
    const source = readJob(stateDir, safeJobId(flags["resume-job"]));
    if (!source) throw new UsageError(`No job ${flags["resume-job"]} to resume`);
    // Same guard --resume-last applies below. Nothing in grok's session layer
    // locks a resumed session, so `-r` onto a running job puts two processes on
    // one session (mid-turn snapshot at best); onto a queued job it names a
    // session grok has not created yet and fails opaquely in the engine.
    if (!TERMINAL_STATUSES.has(source.status)) {
      throw new UsageError(`Job ${source.id} is still ${source.status} — wait for it to finish before resuming`);
    }
    const sessionId = effectiveSessionId(source);
    if (!sessionId) throw new UsageError(`Job ${source.id} has no session id to resume`);
    return { ...source, sessionId };
  }
  if (flags["resume-last"]) {
    const source = listJobs(stateDir).find(
      (j) => TERMINAL_STATUSES.has(j.status) && effectiveSessionId(j),
    );
    if (!source) throw new UsageError("No resumable job in this workspace");
    return { ...source, sessionId: effectiveSessionId(source) };
  }
  return null;
}

async function startJob({ prompt, flags, env, out, cwd, stateDir, deps }) {
  const jsonSchema = readSchemaFile(flags.schema, cwd); // UsageError on bad file/JSON
  const maxTurns = parseMaxTurns(flags["max-turns"]); // UsageError on non-positive-integer
  // No auth preflight on purpose: grok's headless path fails CLOSED in milliseconds
  // (xai-grok-pager/src/headless.rs:459-480 fn `authenticate` — bails via
  // `auth_required_message` when no non-interactive method resolves; interactive
  // login is never attempted headless), and its message names `grok login
  // --device-code` + XAI_API_KEY. classifyError buckets that as `auth`, so the job
  // lands failed/auth with the ENGINE's message — strictly better than guessing at
  // grok's credential resolution (per-model api_key/env_key, OS-resolved home, …).
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
      research: flags.research ?? false, // opt-in --tools x_search,web_search,web_fetch --deny MCPTool
      maxTurns, // opt-in --max-turns <n> — runaway-cost fuse, validated above
      noMemory: flags["no-memory"] ?? false, // opt-in --no-memory (skip cross-session grok memory)
      jsonSchema,
      resumeSessionId: source?.sessionId ?? null,
      resumedFrom: source?.id ?? null,
      // Pre-generate the session id for a NEW conversation only (never set
      // alongside resumeSessionId — grok rejects --session-id combined with
      // --resume, see adapter.mjs). Minted here and persisted by createJob
      // below BEFORE runWorker/the background worker ever spawns the grok
      // child, so a crash mid-run still leaves an id to resume from
      // (resolveResumeSource's request.sessionId fallback above). One job =
      // one spawn (no retry-with-same-request path in this companion), so
      // minting once per job record is safe — a fresh id is never reused.
      sessionId: source ? null : crypto.randomUUID(),
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
      adapter: makeGrokAdapter({ stateDir }),
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
  // .trim(): the positional path already trims, but a --prompt-file of pure
  // whitespace is short enough to go out as `-p` and die in the engine with
  // "--single: prompt is empty" (headless/cli.rs from_text). Fail fast instead.
  if (!prompt.trim()) throw new UsageError("task requires a non-empty prompt or --prompt-file");
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
  // `--last` is accepted as an EXPLICIT alias for the default and deliberately
  // needs no branch: listJobs is newest-first, so omitting the job id already
  // resolves to the last job (a positional still wins over the flag). Kept in
  // the parse list so `result --last` — advertised by commands/result.md — is
  // not rejected as an unknown flag.
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
