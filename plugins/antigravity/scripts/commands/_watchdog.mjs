#!/usr/bin/env node
/**
 * Detached liveness watchdog for a single background job. Not exposed via bin.
 *
 * Spawned by job-helpers.startBackgroundJob as a detached, unref'd process:
 *   node scripts/commands/_watchdog.mjs <cwd> <jobId>
 *
 * It polls the per-job file and, using the escalate-not-kill gate in
 * liveness.mjs, terminates a job whose worker has died or blown past its hard
 * deadline — proactively, without waiting for anyone to run /antigravity:status.
 * Every write goes through applyJobPatchIfActive so it never clobbers a job the
 * worker (or cancel) finalized first.
 */

import {
  readJobFile,
  applyJobPatchIfActive,
  isProcessAlive,
  appendJobLog,
} from "../lib/state.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { terminateProcessTree } from "../lib/process.mjs";
import { createLivenessGate, resolveLivenessConfig } from "../lib/liveness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [cwdArg, jobId] = process.argv.slice(2);
  if (!cwdArg || !jobId) {
    process.stderr.write("watchdog: usage: _watchdog.mjs <cwd> <jobId>\n");
    process.exit(2);
  }

  const workspaceRoot = resolveWorkspaceRoot(cwdArg);
  const config = resolveLivenessConfig(process.env);
  const gate = createLivenessGate(config);

  for (;;) {
    const job = readJobFile(workspaceRoot, jobId);
    if (!job) return; // record pruned/gone

    const pid = Number(job.pid);
    const hasPid = Number.isFinite(pid) && pid > 0;
    const observation = {
      status: job.status,
      // No pid yet (queued, pre-spawn) → assume alive so we don't reap early.
      workerAlive: hasPid ? isProcessAlive(pid) : true,
      nowMs: Date.now(),
      deadlineMs: job.timeoutAt ? Date.parse(job.timeoutAt) : null,
    };

    const { verdict, action } = gate.assess(observation);
    if (action === "stop") return;

    if (action === "terminate") {
      if (hasPid) {
        try {
          terminateProcessTree(pid);
        } catch {
          // already gone
        }
      }
      await applyJobPatchIfActive(workspaceRoot, jobId, {
        status: "failed",
        phase: "failed",
        pid: null,
        completedAt: new Date().toISOString(),
        errorMessage: `Watchdog terminated job: worker ${verdict} (no terminal status reported).`,
        healthStatus: "failed",
        watchdogTerminated: true,
        watchdogVerdict: verdict,
      });
      try {
        appendJobLog(workspaceRoot, jobId, `[watchdog] ${verdict} → terminated`);
      } catch {
        // best effort
      }
      return;
    }

    await sleep(config.intervalMs);
  }
}

main().catch((err) => {
  process.stderr.write(`watchdog: fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
