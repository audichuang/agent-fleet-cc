#!/usr/bin/env node
// Detached worker CLI entry: `node worker-entry.mjs <stateDir> <jobId>`.
// The companion's --background path spawns this detached (Plan B wiring): it
// drives the vendored shared runtime's full job lifecycle off-process, then
// exits with the worker's return code. The cancel forwarder turns a SIGTERM to
// this process into a process-group kill of the engine child (+ grandchildren),
// with a hard self-exit fallback if a grandchild keeps stdio open.
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { readJob, writeJob } from "./lib/shared/core/state-store.mjs";
import { TERMINAL_STATUSES } from "./lib/shared/core/job.mjs";
import { makeClaudeAdapter } from "./lib/adapter.mjs";

const [stateDir, jobId] = process.argv.slice(2);

// F3:早期 pid stamp(race-free — worker-entry 是自己 pid 的唯一寫者,companion
// 不 stamp)。在做任何事之前先把本進程 pid 蓋上去:若 launcher 在 markJobRunning
// 之前就崩潰,reconcile 就能靠這個死 pid 把 queued job 收成 failed,不再永遠 queued。
// (markJobRunning 之後會以 running+pid 經 fresh-merge 覆寫;這裡只是讓崩潰可偵測。)
const existing = readJob(stateDir, jobId);
if (existing && !TERMINAL_STATUSES.has(existing.status)) {
  writeJob(stateDir, { ...existing, pid: process.pid });
}

const forwarder = installCancelForwarder({ forceExitMs: 7000 });
runWorker({
  stateDir,
  jobId,
  adapter: makeClaudeAdapter(),
  deps: { onChild: forwarder.onChild },
}).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
