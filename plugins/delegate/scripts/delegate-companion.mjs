#!/usr/bin/env node
// CLI entry. Commands: setup | task | execute-plan | status | result | cancel
// Testable via runCompanion(argv, deps) with injectable seams.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./lib/args.mjs";
import { resolveProfile, listProfiles, ProfileError } from "./lib/profiles.mjs";
import { resolveTimeoutMs } from "./lib/claude.mjs";
import { runWorker, installCancelForwarder } from "./lib/worker.mjs";
import { renderStatus, renderResult } from "./lib/render.mjs";
import { reconcileDeadPids, cancelJob } from "./lib/job-control.mjs";
import {
  resolveDataRoot,
  workspaceStateDir,
  newJobId,
  writeJob,
  readJob,
  listJobs,
  pruneJobs,
  promptFilePath,
  logFilePath,
  TERMINAL_STATUSES,
} from "./lib/state.mjs";

const USAGE = `usage: delegate-companion <command> [...]
  setup
  task <prompt...> [--profile <name>|--settings <path>] [--background] [--resume-id <job>|--resume-last] [--timeout-ms <n>]
  execute-plan <plan-file> [same flags as task]
  status
  result [<job-id>|--last]
  cancel <job-id>`;

const TASK_FLAGS = {
  valueFlags: ["profile", "settings", "resume-id", "timeout-ms"],
  boolFlags: ["background", "resume-last"],
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
        return cmdStatus({ out, stateDir });
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
  if (flags["resume-id"]) {
    const source = readJob(stateDir, safeJobId(flags["resume-id"]));
    if (!source) throw new UsageError(`No job ${flags["resume-id"]} to resume`);
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

async function startJob({ prompt, promptPreview, flags, env, out, cwd, dataRoot, stateDir, deps }) {
  const source = resolveResumeSource({ flags, stateDir });
  let settingsPath;
  let profileName;
  if (source) {
    // Fail fast pre-spawn (SPEC §10): the source profile may have been
    // deleted since the original job ran.
    resolveProfile({ settingsPath: source.settingsPath });
    settingsPath = source.settingsPath;
    profileName = source.profile;
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
  const job = {
    id: newJobId(),
    status: "queued",
    profile: profileName,
    settingsPath,
    permissionMode: env.DELEGATE_PERMISSION_MODE ?? "bypassPermissions",
    cwd,
    timeoutMs: parseTimeoutMs(flags["timeout-ms"], env),
    background: Boolean(flags.background),
    resumedFrom: source?.id ?? null,
    resumeSessionId: source?.sessionId ?? null,
    promptPreview,
    createdAt: new Date().toISOString(),
  };
  // Prompts can carry proprietary code/secrets — keep artifacts owner-only.
  fs.mkdirSync(path.dirname(promptFilePath(stateDir, job.id)), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(promptFilePath(stateDir, job.id), prompt, { mode: 0o600 });
  writeJob(stateDir, job);
  pruneJobs(stateDir);

  if (job.background) {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "lib",
      "worker.mjs",
    );
    const spawnImpl = deps.workerSpawnImpl ?? spawn;
    const child = spawnImpl(
      process.execPath,
      [workerPath, stateDir, job.id],
      { detached: true, stdio: "ignore", env: { ...env } },
    );
    child.unref();
    out(`Started background job ${job.id} (profile=${job.profile}).`);
    out(`Check: status | result ${job.id} | cancel ${job.id}`);
    return 0;
  }

  // Foreground has the same cancel gap as the worker: SIGTERM kills the
  // companion, not the claude child — forward it. No forceExit here, the
  // companion still has to render the result.
  const forwarder = installCancelForwarder({});
  try {
    await runWorker({
      stateDir,
      jobId: job.id,
      deps: {
        spawnImpl: deps.claudeSpawnImpl,
        binary: env.DELEGATE_CLAUDE_BIN,
        baseEnv: env,
        onChild: forwarder.onChild,
      },
    });
  } finally {
    forwarder.dispose();
  }
  const finished = readJob(stateDir, job.id);
  out(renderResult(finished, readLogTail(stateDir, job.id)));
  return finished.status === "completed" ? 0 : 1;
}

async function cmdTask({ argv, env, out, cwd, dataRoot, stateDir, deps }) {
  const { flags, positionals } = parseArgs(argv, TASK_FLAGS);
  const prompt = positionals.join(" ").trim();
  if (!prompt) throw new UsageError("task requires a prompt");
  return startJob({
    prompt,
    promptPreview: prompt.slice(0, 120),
    flags, env, out, cwd, dataRoot, stateDir, deps,
  });
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
    promptPreview: `execute-plan ${path.basename(planPath)}`,
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

function cmdStatus({ out, stateDir }) {
  reconcileDeadPids(stateDir);
  out(renderStatus(listJobs(stateDir)));
  return 0;
}

function cmdResult({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["last"] });
  reconcileDeadPids(stateDir);
  const job = flags.last
    ? listJobs(stateDir)[0]
    : positionals[0]
      ? readJob(stateDir, safeJobId(positionals[0]))
      : listJobs(stateDir)[0];
  if (!job) {
    out("No delegate jobs in this workspace.");
    return 1;
  }
  out(renderResult(job, job.status === "completed" ? "" : readLogTail(stateDir, job.id)));
  return job.status === "completed" ? 0 : 1;
}

function cmdCancel({ argv, out, stateDir }) {
  const { positionals } = parseArgs(argv, {});
  if (!positionals[0]) throw new UsageError("cancel requires a job id");
  const result = cancelJob(stateDir, safeJobId(positionals[0]));
  out(result.message);
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
