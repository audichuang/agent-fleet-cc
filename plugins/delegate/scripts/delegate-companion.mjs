#!/usr/bin/env node
// CLI entry. Commands: setup | task | execute-plan | status | result | cancel
// Testable via runCompanion(argv, deps) with injectable seams.
//
// Job runtime (state/worker/cancel/reconcile) lives in the vendored shared lib;
// the delegate-specific engine knowledge lives in ./lib/adapter.mjs. This
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
  promptFilePath,
  logFilePath,
} from "./lib/shared/core/state-store.mjs";
import { reconcileDeadPids } from "./lib/shared/core/reconcile.mjs";
import { cancelJob } from "./lib/shared/core/job-control.mjs";
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { makeClaudeAdapter, resolveDataRoot, workspaceStateDir } from "./lib/adapter.mjs";
import { resolveProfile, listProfiles, ProfileError } from "./lib/profiles.mjs";
import { resolveTimeoutMs } from "./lib/claude.mjs";
import { renderStatus, renderResult } from "./lib/render.mjs";

const USAGE = `usage: delegate-companion <command> [...]
  setup
  task <prompt...>|--prompt-file <path> [--profile <name>|--settings <path>] [--background|--wait] [--json] [--model <id>] [--read-only|--write] [--resume-job <job>|--resume-last] [--timeout-ms <n>]
  execute-plan <plan-file> [same flags as task]
  status
  result [<job-id>|--last]
  cancel <job-id>`;

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
  if (value === undefined) return resolveTimeoutMs(env);
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
    engine: "delegate",
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

const EXECUTE_PLAN_TEMPLATE = (plan) => `You are executing a pre-approved implementation plan. Read it carefully, then implement it COMPLETELY:
- Follow the plan's tasks in order; run every verification step it specifies.
- Do not redesign or skip steps. If a step is impossible, finish what you can and report the blocker in your final summary.
- Commit as the plan instructs.

<plan>
${plan}
</plan>`;

export async function runCompanion(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line) => process.stdout.write(line + "\n"));
  if (env.CLAUDE_DELEGATE_ACTIVE === "1") {
    out("delegate: disabled inside a delegate session (recursion guard).");
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
      case "execute-plan":
        return await cmdExecutePlan({ argv: rest, env, out, cwd, dataRoot, stateDir, deps });
      case "status":
        return cmdStatus({ argv: rest, out, stateDir });
      case "result":
        return cmdResult({ argv: rest, out, stateDir });
      case "cancel":
        return cmdCancel({ argv: rest, out, stateDir });
      default:
        out(USAGE);
        return command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ProfileError) {
      out(`delegate: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function cmdSetup({ env, out, dataRoot, deps }) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const binary = env.DELEGATE_CLAUDE_BIN ?? "claude";
  let healthy = true;
  const probe = spawnSyncImpl(binary, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    out(`✗ claude CLI not runnable (${binary}). Install Claude Code first.`);
    healthy = false;
  } else {
    out(`✓ claude CLI: ${String(probe.stdout).trim()}`);
  }
  const names = listProfiles(dataRoot);
  if (!names.length) {
    out(`✗ no profiles. Create <name>.json under ${path.join(dataRoot, "profiles")} (standard Claude Code settings format, env block carries ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN).`);
    healthy = false;
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
    env.DELEGATE_DEFAULT_PROFILE
      ? `default profile: ${env.DELEGATE_DEFAULT_PROFILE}`
      : "default profile: (none — pass --profile per call or set DELEGATE_DEFAULT_PROFILE)",
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
    : (env.DELEGATE_PERMISSION_MODE ?? "bypassPermissions");
  const record = createJobRecord({
    engine: "delegate",
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
    const child = spawnImpl(
      process.execPath,
      [workerPath, stateDir, record.id],
      { detached: true, stdio: "ignore", env: { ...env } },
    );
    child.unref();
    if (flags.json) {
      out(JSON.stringify({ engine: "delegate", jobId: record.id, status: "queued" }));
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

async function cmdExecutePlan({ argv, env, out, cwd, dataRoot, stateDir, deps }) {
  const { flags, positionals } = parseArgs(argv, TASK_FLAGS);
  const planPath = positionals[0];
  if (!planPath) throw new UsageError("execute-plan requires a plan file path");
  let plan;
  try {
    plan = fs.readFileSync(path.resolve(cwd, planPath), "utf8");
  } catch {
    throw new UsageError(`plan file not readable: ${planPath}`);
  }
  return startJob({
    prompt: EXECUTE_PLAN_TEMPLATE(plan),
    title: `execute-plan ${path.basename(planPath)}`,
    flags, env, out, cwd, dataRoot, stateDir, deps,
  });
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
    out(flags.json ? JSON.stringify({ error: "no jobs" }) : "No delegate jobs in this workspace.");
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

const isCliEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  runCompanion(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`delegate: ${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}
