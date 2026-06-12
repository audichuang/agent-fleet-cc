// Shared turn executor: the foreground path awaits it in-process; the
// background path runs it as a detached `node worker.mjs <stateDir> <jobId>`.
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildDelegateEnv } from "./env.mjs";
import { resolveProfile } from "./profiles.mjs";
import { buildClaudeArgs, runClaudeTurn } from "./claude.mjs";
import {
  readJob,
  markJobRunning,
  finalizeJob,
  promptFilePath,
  logFilePath,
} from "./state.mjs";

// Cancel reaches the worker as SIGTERM, but the expensive process is the
// claude CHILD — forward the signal or it keeps running orphaned (and keeps
// editing files under bypassPermissions). All collaborators are injectable
// seams so the kill sequencing is deterministic to test.
export function installCancelForwarder({
  proc = process,
  graceMs = 5000,
  forceExitMs = null,
  killImpl = (child, signal) => {
    try {
      child.kill(signal);
    } catch {}
  },
  exitImpl = (code) => process.exit(code),
  scheduleImpl = setTimeout,
} = {}) {
  let child = null;
  let terminated = false;
  const killSequence = (target) => {
    killImpl(target, "SIGTERM");
    scheduleImpl(() => killImpl(target, "SIGKILL"), graceMs)?.unref?.();
  };
  const handler = () => {
    terminated = true;
    if (child) killSequence(child);
    if (forceExitMs !== null) {
      // Grandchildren can inherit the child's stdio pipes; then `close` never
      // fires and the worker would linger as a zombie. Whoever SIGTERMed us
      // already finalized the job, so a hard self-exit is safe.
      scheduleImpl(() => exitImpl(0), forceExitMs)?.unref?.();
    }
  };
  proc.once("SIGTERM", handler);
  return {
    onChild(c) {
      child = c;
      if (terminated) killSequence(c); // SIGTERM arrived before spawn
    },
    dispose() {
      proc.removeListener("SIGTERM", handler);
    },
  };
}

export async function runWorker({ stateDir, jobId, deps = {} }) {
  const job = readJob(stateDir, jobId);
  if (!job) return 1;
  let prompt;
  try {
    prompt = fs.readFileSync(promptFilePath(stateDir, jobId), "utf8");
  } catch {
    finalizeJob(stateDir, jobId, { status: "failed", error: "prompt file missing" });
    return 1;
  }

  let profile;
  try {
    profile = resolveProfile({ settingsPath: job.settingsPath });
  } catch (error) {
    finalizeJob(stateDir, jobId, { status: "failed", error: String(error.message) });
    return 1;
  }

  // CAS-guarded queued→running: losing to a canceller means we must not
  // spawn anything — exiting 0 is the correct outcome, not an error.
  const running = markJobRunning(stateDir, jobId, { pid: deps.pid ?? process.pid });
  if (!running) return 0;

  const env = buildDelegateEnv({
    baseEnv: deps.baseEnv ?? process.env,
    profileEnv: profile.env,
  });
  const logStream = fs.createWriteStream(logFilePath(stateDir, jobId), {
    flags: "a",
    mode: 0o600,
  });
  const outcome = await runClaudeTurn({
    binary: deps.binary ?? process.env.DELEGATE_CLAUDE_BIN ?? "claude",
    args: buildClaudeArgs({
      settingsPath: job.settingsPath,
      permissionMode: job.permissionMode,
      resumeSessionId: job.resumeSessionId,
    }),
    prompt,
    env,
    cwd: job.cwd,
    timeoutMs: job.timeoutMs,
    graceMs: deps.graceMs,
    spawnImpl: deps.spawnImpl,
    onLine: (line) => logStream.write(line + "\n"),
    onChild: deps.onChild,
  });
  logStream.end();

  const failed =
    outcome.isError || outcome.stdinError || outcome.exitCode !== 0;
  const status = outcome.timedOut ? "timed-out" : failed ? "failed" : "completed";
  const error = outcome.stdinError
    ? `stdin: ${outcome.stdinError.code ?? outcome.stdinError.message}`
    : failed && !outcome.timedOut
      ? (outcome.stderrTail || "claude exited nonzero").slice(-500)
      : null;
  finalizeJob(stateDir, jobId, {
    status,
    exitCode: outcome.exitCode,
    sessionId: outcome.sessionId ?? job.sessionId ?? null,
    resultText: outcome.resultText,
    error,
  });
  return 0;
}

const isCliEntry =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const [stateDir, jobId] = process.argv.slice(2);
  const forwarder = installCancelForwarder({ forceExitMs: 7000 });
  runWorker({ stateDir, jobId, deps: { onChild: forwarder.onChild } }).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
