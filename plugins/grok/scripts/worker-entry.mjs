#!/usr/bin/env node
// Detached worker CLI entry: `node worker-entry.mjs <stateDir> <jobId>`.
// The companion's --background path spawns this detached; it drives the vendored
// shared runtime's full job lifecycle off-process, then exits with the worker's
// return code. The cancel forwarder turns a SIGTERM into a process-group kill of
// the grok child (+ grandchildren), with a hard self-exit fallback.
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { readJob, writeJob } from "./lib/shared/core/state-store.mjs";
import { TERMINAL_STATUSES } from "./lib/shared/core/job.mjs";
import { makeGrokAdapter } from "./lib/adapter.mjs";

const [stateDir, jobId] = process.argv.slice(2);

// Early race-free pid stamp so reconcile can recover a queued job if this
// launcher dies before markJobRunning.
const existing = readJob(stateDir, jobId);
if (existing && !TERMINAL_STATUSES.has(existing.status)) {
  writeJob(stateDir, { ...existing, pid: process.pid });
}

const forwarder = installCancelForwarder({ forceExitMs: 7000 });
runWorker({
  stateDir,
  jobId,
  adapter: makeGrokAdapter({ stateDir }),
  deps: { onChild: forwarder.onChild },
}).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
