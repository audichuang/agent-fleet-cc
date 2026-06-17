#!/usr/bin/env node
// Detached worker CLI entry: `node worker-entry.mjs <stateDir> <jobId>`.
// The companion's --background path spawns this detached (Plan B wiring): it
// drives the vendored shared runtime's full job lifecycle off-process, then
// exits with the worker's return code. The cancel forwarder turns a SIGTERM to
// this process into a process-group kill of the engine child (+ grandchildren),
// with a hard self-exit fallback if a grandchild keeps stdio open.
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { makeClaudeAdapter } from "./lib/adapter.mjs";

const [stateDir, jobId] = process.argv.slice(2);
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
