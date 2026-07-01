#!/usr/bin/env node
// Detached worker CLI entry: `node worker-entry.mjs <stateDir> <jobId>`.
// The launcher's --background path spawns this detached (Plan B wiring): it
// drives the vendored shared runtime's full job lifecycle off-process, then
// exits with the worker's return code. The cancel forwarder turns a SIGTERM to
// this process into a process-group kill of the engine child (+ grandchildren),
// with a hard self-exit fallback if a grandchild keeps stdio open.
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { readJob, writeJob } from "./lib/shared/core/state-store.mjs";
import { TERMINAL_STATUSES } from "./lib/shared/core/job.mjs";
import { makeAntigravityAdapter } from "./lib/adapter.mjs";

const [stateDir, jobId] = process.argv.slice(2);

// F3: early race-free pid stamp — worker-entry is the SOLE writer of its own
// pid (the launcher must NOT stamp). Stamp before doing anything else: if the
// launcher crashes before markJobRunning, reconcile can use this dead pid to
// reap the still-queued job into failed instead of leaving it queued forever.
// (markJobRunning later overwrites with running+pid via fresh-merge; this only
// makes a pre-run crash detectable.)
const existing = readJob(stateDir, jobId);
if (existing && !TERMINAL_STATUSES.has(existing.status)) {
  writeJob(stateDir, { ...existing, pid: process.pid });
}

const forwarder = installCancelForwarder({ forceExitMs: 7000 });
runWorker({
  stateDir,
  jobId,
  adapter: makeAntigravityAdapter(),
  deps: { onChild: forwarder.onChild },
}).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
