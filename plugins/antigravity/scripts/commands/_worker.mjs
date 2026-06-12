#!/usr/bin/env node
/**
 * Internal background worker. Not exposed via bin/antigravity.mjs.
 *
 * Invoked by job-helpers.startBackgroundJob as:
 *   node scripts/commands/_worker.mjs <jobId>
 *
 * Reads the job file for <jobId>, runs `agy --print` per the persisted request,
 * and finalizes the job record. Every status write goes through
 * applyJobPatchIfActive so a cancel / watchdog / reconcile racing this worker is
 * first-terminal-writer-wins, never last-writer.
 */

import {
  appendJobLog,
  readJobFile,
  resolveJobLogFile,
  applyJobPatchIfActive,
  touchJobProgress,
} from "../lib/state.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runAgyPrint, resolveAgyTimeouts } from "../lib/agent-runtime.mjs";
import { deriveSummary, trimToNull } from "../lib/text.mjs";

async function main() {
  const [jobId] = process.argv.slice(2);
  if (!jobId) {
    process.stderr.write("worker: missing jobId\n");
    process.exit(2);
  }

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const stored = readJobFile(workspaceRoot, jobId);
  if (!stored) {
    process.stderr.write(`worker: no job file for ${jobId}\n`);
    process.exit(2);
  }
  const request = stored.request ?? {};
  const prompt = request.prompt;
  if (!prompt) {
    await applyJobPatchIfActive(workspaceRoot, jobId, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: "worker: missing prompt in job request",
      healthStatus: "failed",
    });
    process.exit(1);
  }

  const { printMs, hardMs } = resolveAgyTimeouts(process.env);

  // Promote queued → running, but only while still active. If a cancel landed
  // before we started, this returns applied:false and we must not run agy.
  // timeoutAt is the hard deadline the watchdog uses to detect a wedged worker.
  const promoted = await applyJobPatchIfActive(workspaceRoot, jobId, {
    status: "running",
    phase: "running",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    timeoutAt: new Date(Date.now() + hardMs).toISOString(),
    pid: process.pid,
  });
  if (!promoted.applied) {
    const finalStatus = promoted.stored?.status ?? "finished";
    appendJobLog(workspaceRoot, jobId, `[worker] not started; job already ${finalStatus}`);
    process.exit(finalStatus === "cancelled" ? 2 : 0);
  }
  appendJobLog(workspaceRoot, jobId, `[worker] started pid=${process.pid}`);

  const logPath = resolveJobLogFile(workspaceRoot, jobId);
  const fs = await import("node:fs");

  let lastBeatMs = 0;
  const onStdout = (chunk) => {
    try {
      fs.appendFileSync(logPath, chunk, { encoding: "utf8", mode: 0o600 });
    } catch {
      // best-effort log capture
    }
    // Throttled progress heartbeat so /antigravity:status can report 'active'
    // and the watchdog/health classifier see a live, working job.
    const now = Date.now();
    if (now - lastBeatMs > 5000) {
      lastBeatMs = now;
      touchJobProgress(workspaceRoot, jobId).catch(() => {});
    }
  };

  let result;
  try {
    result = await runAgyPrint({
      prompt,
      mode: request.mode ?? "print",
      conversationId: request.conversationId,
      model: request.model,
      sandbox: request.sandbox,
      addDirs: request.addDirs ?? [],
      cwd: request.cwd ?? workspaceRoot,
      timeoutMs: Number(request.timeoutMs) || hardMs,
      printTimeoutMs: printMs,
      onStdout,
    });
  } catch (err) {
    appendJobLog(workspaceRoot, jobId, `[worker] error: ${err?.message ?? err}`);
    await applyJobPatchIfActive(workspaceRoot, jobId, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: err?.message ?? String(err),
      healthStatus: "failed",
    });
    process.exit(1);
  }

  const status =
    result.status === "completed"
      ? "completed"
      : result.status === "cancelled"
      ? "cancelled"
      : "failed";
  const oauth = result.oauthUrl ?? null;
  const summary = deriveSummary(result.stdout);

  const finalize = await applyJobPatchIfActive(workspaceRoot, jobId, {
    status,
    phase: status,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    summary,
    threadId: result.conversationId ?? null,
    conversationId: result.conversationId ?? null,
    oauthUrl: oauth,
    healthStatus:
      result.status === "auth_required" ? "auth_required" : status === "failed" ? "failed" : null,
    healthMessage:
      result.status === "auth_required"
        ? "Antigravity is not authenticated. Complete OAuth and retry."
        : null,
    recommendedAction:
      result.status === "auth_required" ? "Run /antigravity:setup to complete the OAuth flow." : null,
    errorMessage: status === "failed" ? trimToNull(result.stderr) : null,
    result: {
      rawOutput: result.stdout,
      stderr: result.stderr,
      status: result.status,
      exitCode: result.exitCode,
      oauthUrl: oauth,
      conversationId: result.conversationId ?? null,
    },
  });

  if (finalize.applied) {
    appendJobLog(workspaceRoot, jobId, `[worker] ${status} exit=${result.exitCode}`);
  } else {
    appendJobLog(
      workspaceRoot,
      jobId,
      `[worker] finalize skipped; job already ${finalize.stored?.status ?? "finished"}`,
    );
  }
  process.exit(status === "completed" ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`worker: fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
