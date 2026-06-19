#!/usr/bin/env node
// CLI entry. Commands: setup | task | status | result | cancel | wait | logs
// Testable via runCompanion(argv, deps) with injectable seams.
//
// Job runtime (state/worker/cancel/reconcile) lives in the vendored shared lib;
// the cc-specific engine knowledge lives in ./lib/adapter.mjs. This
// companion only orchestrates: parse flags, build a job record, drive the
// shared runWorker (foreground) or spawn worker-entry.mjs (background).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./lib/shared/args.mjs";
import { createJobRecord, TERMINAL_STATUSES } from "./lib/shared/core/job.mjs";
import {
  createJob,
  readJob,
  listJobs,
  pruneJobs,
  finalizeJob,
  promptFilePath,
  logFilePath,
  jobDir,
} from "./lib/shared/core/state-store.mjs";
import { reconcileDeadPids } from "./lib/shared/core/reconcile.mjs";
import { cancelJob } from "./lib/shared/core/job-control.mjs";
import { waitForJob } from "./lib/shared/core/wait.mjs";
import { readEvents } from "./lib/shared/core/events.mjs";
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { makeClaudeAdapter, resolveDataRoot, workspaceStateDir } from "./lib/adapter.mjs";
import { resolveProfile, listProfiles, ProfileError } from "./lib/profiles.mjs";
import { renderStatus, renderResult } from "./lib/render.mjs";

// Job timeout default (1h) — inlined from the retired claude helper module.
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const USAGE = `usage: cc-companion <command> [...]
  setup
  task <prompt...>|--prompt-file <path> [--profile <name>|--settings <path>] [--background|--wait] [--json] [--model <id>] [--read-only|--write] [--resume-job <job>|--resume-last] [--timeout-ms <n>]
  status
  result [<job-id>|--last]
  cancel <job-id>
  wait <job-id> [--timeout-s <n>] [--json]
  logs <job-id> [--follow]`;

const TASK_FLAGS = {
  valueFlags: ["profile", "settings", "resume-job", "timeout-ms", "prompt-file", "model"],
  boolFlags: ["background", "wait", "resume-last", "json", "read-only", "write"],
};

// Job ids are joined into state paths — reject traversal before any fs use.
function safeJobId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new UsageError(`Invalid job id: ${value}`);
  }
  return value;
}

function parseTimeoutMs(value, env) {
  if (value === undefined) {
    const raw = Number(env.CC_JOB_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    // Unvalidated NaN would become setTimeout(NaN) ≈ a 1ms timeout.
    throw new UsageError(`--timeout-ms must be a positive number, got: ${value}`);
  }
  return n;
}

// Unified result projection (spec §2.1): the shape result/--json speak.
function resultProjection(job) {
  return {
    engine: "cc",
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
  if (env.CLAUDE_CC_ACTIVE === "1") {
    out("cc: disabled inside a cc session (recursion guard).");
    return 0;
  }
  const cwd = deps.cwd ?? process.cwd();
  const dataRoot = resolveDataRoot(env);
  const stateDir = workspaceStateDir(dataRoot, cwd);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return cmdSetup({ env, out, dataRoot, deps });
      case "task":
        return await cmdTask({ argv: rest, env, out, cwd, dataRoot, stateDir, deps });
      case "status":
        return cmdStatus({ argv: rest, out, stateDir });
      case "result":
        return cmdResult({ argv: rest, out, stateDir });
      case "cancel":
        return cmdCancel({ argv: rest, out, stateDir });
      case "wait":
        return await cmdWait({ argv: rest, out, stateDir });
      case "logs":
        return await cmdLogs({ argv: rest, out, stateDir });
      default:
        out(USAGE);
        return command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ProfileError) {
      out(`cc: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function cmdSetup({ env, out, dataRoot, deps }) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const binary = env.CC_CLAUDE_BIN ?? "claude";
  let healthy = true;
  const probe = spawnSyncImpl(binary, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    out(`✗ claude CLI not runnable (${binary}). Install Claude Code first.`);
    healthy = false;
  } else {
    out(`✓ claude CLI: ${String(probe.stdout).trim()}`);
  }
  let names = listProfiles(dataRoot);
  if (!names.length) {
    // 零 profile 時自動建立 native(空 settings = 原生 claude),讓原生開箱即用。
    // 單一 profile 時 task 會自動採用它,所以裝好 → setup → /cc:task 直接跑原生。
    const nativePath = path.join(dataRoot, "profiles", "native.json");
    try {
      fs.mkdirSync(path.dirname(nativePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(nativePath, "{}\n", { mode: 0o600 });
      out(`✓ created native profile (empty settings = 原生 claude) at ${nativePath}`);
      out(`  use it directly: /cc:task "..." (single profile is auto-selected)`);
      names = listProfiles(dataRoot);
    } catch (error) {
      out(`✗ no profiles and failed to create native: ${error.message}`);
      healthy = false;
    }
  }
  for (const name of names) {
    try {
      resolveProfile({ dataRoot, profile: name, env: {} });
      out(`✓ profile ${name}`);
    } catch (error) {
      out(`✗ profile ${name}: ${error.message}`);
      healthy = false;
    }
  }
  out(
    env.CC_DEFAULT_PROFILE
      ? `default profile: ${env.CC_DEFAULT_PROFILE}`
      : "default profile: (none — pass --profile per call or set CC_DEFAULT_PROFILE)",
  );
  return healthy ? 0 : 1;
}

function resolveResumeSource({ flags, stateDir }) {
  if (flags["resume-job"]) {
    const source = readJob(stateDir, safeJobId(flags["resume-job"]));
    if (!source) throw new UsageError(`No job ${flags["resume-job"]} to resume`);
    if (!source.sessionId)
      throw new UsageError(`Job ${source.id} has no session id to resume`);
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

async function startJob({ prompt, title, flags, env, out, cwd, dataRoot, stateDir, deps }) {
  const source = resolveResumeSource({ flags, stateDir });
  let settingsPath;
  let profileName;
  if (source) {
    // Fail fast pre-spawn (SPEC §10): the source profile may have been
    // deleted since the original job ran. Engine-specific request fields live
    // under request.* in the unified schema.
    const sourceSettingsPath = source.request?.settingsPath ?? source.settingsPath;
    resolveProfile({ settingsPath: sourceSettingsPath });
    settingsPath = sourceSettingsPath;
    profileName = source.request?.profile ?? source.profile;
  } else {
    const profile = resolveProfile({
      dataRoot,
      profile: flags.profile,
      settingsPath: flags.settings,
      env,
    });
    settingsPath = profile.path;
    profileName = profile.name;
  }
  // --read-only → "default"; --write is an explicit no-op synonym for the
  // legacy default (bypassPermissions).
  const permissionMode = flags["read-only"]
    ? "default"
    : (env.CC_PERMISSION_MODE ?? "bypassPermissions");
  const record = createJobRecord({
    engine: "cc",
    title: title ?? prompt.slice(0, 120),
    cwd,
    timeoutMs: parseTimeoutMs(flags["timeout-ms"], env),
    request: {
      profile: profileName,
      settingsPath,
      permissionMode,
      model: flags.model ?? null,
      resumeSessionId: source?.sessionId ?? null,
      resumedFrom: source?.id ?? null,
    },
  });
  // createJob writes the job dir (0700) + prompt.txt (0600) + job.json atomically.
  createJob(stateDir, record, prompt);
  pruneJobs(stateDir);

  if (flags.background) {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "worker-entry.mjs",
    );
    const spawnImpl = deps.workerSpawnImpl ?? spawn;
    // F3:detached spawn 同步 throw(execPath 不存在、資源耗盡等)時不能把
    // queued job 留著爛 — reconcile 只救「有死 pid」的 job,而此時 worker-entry
    // 根本沒起來 stamp pid。直接 finalize failed 並回報,exit 1。
    let child;
    try {
      child = spawnImpl(
        process.execPath,
        [workerPath, stateDir, record.id],
        { detached: true, stdio: "ignore", env: { ...env } },
      );
    } catch (error) {
      const message = String(error?.message ?? error);
      finalizeJob(stateDir, record.id, {
        status: "failed",
        error: message,
        errorKind: "spawn",
      });
      const finished = readJob(stateDir, record.id);
      out(
        flags.json
          ? JSON.stringify(resultProjection(finished))
          : `cc: failed to launch background worker: ${message}`,
      );
      return 1;
    }
    child.unref();
    if (flags.json) {
      out(JSON.stringify({ engine: "cc", jobId: record.id, status: "queued" }));
    } else {
      out(`Started background job ${record.id} (profile=${record.request.profile}).`);
      out(`Check: status | result ${record.id} | cancel ${record.id}`);
    }
    return 0;
  }

  // Foreground has the same cancel gap as the worker: SIGTERM kills the
  // companion, not the claude child — forward it. No forceExit here, the
  // companion still has to render the result.
  const forwarder = installCancelForwarder({});
  try {
    await runWorker({
      stateDir,
      jobId: record.id,
      adapter: makeClaudeAdapter(),
      deps: {
        spawnImpl: deps.claudeSpawnImpl,
        baseEnv: env,
        onChild: forwarder.onChild,
      },
    });
  } finally {
    forwarder.dispose();
  }
  const finished = readJob(stateDir, record.id);
  out(
    flags.json
      ? JSON.stringify(resultProjection(finished))
      : renderResult(finished, readLogTail(stateDir, record.id)),
  );
  return finished.status === "completed" ? 0 : 1;
}

async function cmdTask({ argv, env, out, cwd, dataRoot, stateDir, deps }) {
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
  return startJob({ prompt, flags, env, out, cwd, dataRoot, stateDir, deps });
}

function readLogTail(stateDir, jobId, lines = 30) {
  try {
    const text = fs.readFileSync(logFilePath(stateDir, jobId), "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function cmdStatus({ argv, out, stateDir }) {
  const { flags } = parseArgs(argv, { boolFlags: ["json"] });
  reconcileDeadPids(stateDir);
  const jobs = listJobs(stateDir);
  out(flags.json ? JSON.stringify(jobs.map(resultProjection)) : renderStatus(jobs));
  return 0;
}

function cmdResult({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["last", "json"] });
  reconcileDeadPids(stateDir);
  const job = positionals[0]
    ? readJob(stateDir, safeJobId(positionals[0]))
    : listJobs(stateDir)[0];
  if (!job) {
    out(flags.json ? JSON.stringify({ error: "no jobs" }) : "No cc jobs in this workspace.");
    return 1;
  }
  out(flags.json
    ? JSON.stringify(resultProjection(job))
    : renderResult(job, job.status === "completed" ? "" : readLogTail(stateDir, job.id)));
  return job.status === "completed" ? 0 : 1;
}

function cmdCancel({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["json"] });
  if (!positionals[0]) throw new UsageError("cancel requires a job id");
  const result = cancelJob(stateDir, safeJobId(positionals[0]));
  out(flags.json ? JSON.stringify(result) : result.message);
  return result.ok ? 0 : 1;
}

// Timeout exit code for wait: not an error — lets an orchestrator cleanly re-enter (spec §2.3)
const WAIT_TIMEOUT_EXIT = 10;

// wait exit-code contract (identical to codex/antigravity):
// 0 completed, 2 cancelled, 1 failed/other terminal, 10 timeout (handled separately).
function waitExitCode(status) {
  if (status === "completed") return 0;
  if (status === "cancelled") return 2;
  return 1;
}

async function cmdWait({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, {
    valueFlags: ["timeout-s"],
    boolFlags: ["json"],
  });
  if (!positionals[0]) throw new UsageError("wait requires a job id");
  const jobId = safeJobId(positionals[0]);
  if (!readJob(stateDir, jobId)) {
    out(
      flags.json
        ? JSON.stringify({ error: `no job ${jobId}` })
        : `No job ${jobId} in this workspace.`,
    );
    return 1;
  }
  const timeoutS = flags["timeout-s"] ? Number(flags["timeout-s"]) : 540;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    throw new UsageError(
      `--timeout-s must be a positive number, got: ${flags["timeout-s"]}`,
    );
  }
  reconcileDeadPids(stateDir);
  const { done, job } = await waitForJob({
    stateDir,
    jobId,
    timeoutMs: timeoutS * 1000,
    // F1:每輪 poll reconcile,worker 中途死亡時不卡到 timeout。
    reconcile: reconcileDeadPids,
    onEvent: (e) => {
      if (!flags.json)
        out(`[${e.ts}] ${e.type}${e.kind ? ":" + e.kind : ""}`);
    },
  });
  if (!job) {
    out(flags.json ? JSON.stringify({ error: `job ${jobId} no longer exists` }) : `Job ${jobId} no longer exists.`);
    return 1;
  }
  out(flags.json ? JSON.stringify(resultProjection(job)) : renderResult(job, ""));
  if (!done) return WAIT_TIMEOUT_EXIT;
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
  const dir = jobDir(stateDir, jobId);
  if (!flags.follow) {
    // Without --follow: print all events as JSON lines and return
    for (const e of readEvents(dir)) out(JSON.stringify(e));
    return 0;
  }
  // With --follow: do NOT static-print first (avoids double-print).
  // waitForJob's onEvent drain starts at index 0, emitting all events
  // including history, until terminal.
  const { job } = await waitForJob({
    stateDir,
    jobId,
    timeoutMs: 24 * 60 * 60 * 1000,
    // F1:--follow 最長等 24h;worker 中途死亡時必須靠 reconcile 收斂,否則卡滿。
    reconcile: reconcileDeadPids,
    onEvent: (e) => out(JSON.stringify(e)),
  });
  return TERMINAL_STATUSES.has(job?.status) ? 0 : 1;
}

const isCliEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  runCompanion(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`cc: ${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}
