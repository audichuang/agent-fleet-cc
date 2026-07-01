import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobDoneFile, resolveJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { readStoredJobWithRetry } from "../../plugins/codex/scripts/lib/job-control.mjs";
import { enqueueBackgroundTask, spawnDetachedTaskWorker, spawnWatchdog } from "../../plugins/codex/scripts/codex-companion.mjs";

test("enqueueBackgroundTask exposes the signal file and launches the watchdog", () => {
  const workspace = makeTempDir();
  const job = { id: "task-bg", workspaceRoot: workspace, title: "Codex task", summary: "do x" };

  const calls = { worker: [], watchdog: [] };
  const result = enqueueBackgroundTask(workspace, job, { kind: "task" }, {
    spawnWorker: (cwd, jobId) => {
      calls.worker.push([cwd, jobId]);
      return { pid: 4321 };
    },
    spawnWatchdog: (cwd, jobId) => {
      calls.watchdog.push([cwd, jobId]);
      return { pid: 4322 };
    }
  });

  assert.equal(result.payload.signalFile, resolveJobDoneFile(workspace, "task-bg"));
  assert.equal(result.signalFile, resolveJobDoneFile(workspace, "task-bg"));
  assert.deepEqual(calls.worker, [[workspace, "task-bg"]]);
  assert.deepEqual(calls.watchdog, [[workspace, "task-bg"]]);
  assert.equal(result.payload.status, "queued");
});

// D: timeoutAt was only stamped when runTrackedJob promoted queued->running. A job whose
// worker dies/wedges BEFORE it ever starts the turn stayed "queued" with no deadline, so
// the watchdog's missedOwnDeadline never tripped and a reachable broker kept it HEALTHY
// forever. Stamp a deadline at enqueue too (runTrackedJob still resets it fresh on run).
test("enqueueBackgroundTask stamps a timeoutAt on the queued record so a never-started job can be reaped", () => {
  const workspace = makeTempDir();
  const job = { id: "task-deadline", workspaceRoot: workspace, title: "t", summary: "s" };

  enqueueBackgroundTask(workspace, job, { kind: "task" }, {
    spawnWorker: () => ({ pid: 1 }),
    spawnWatchdog: () => ({ pid: 2 })
  });

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, "task-deadline"), "utf8"));
  assert.equal(stored.status, "queued");
  assert.ok(stored.timeoutAt, "the queued record carries a deadline");
  assert.ok(Number.isFinite(stored.timeoutMs) && stored.timeoutMs > 0, "the queued record carries a positive timeoutMs");
  const deadline = Date.parse(stored.timeoutAt);
  assert.ok(deadline > Date.now(), "the deadline is in the future");
  // deadline ≈ now + timeoutMs (allow generous slack for test execution)
  assert.ok(Math.abs(deadline - (Date.now() + stored.timeoutMs)) < 60_000, "timeoutAt is now + timeoutMs");
});

test("enqueueBackgroundTask still launches the task when the watchdog fails to start", () => {
  const workspace = makeTempDir();
  const job = { id: "task-bg2", workspaceRoot: workspace, title: "Codex task", summary: "do y" };

  let workerLaunched = false;
  const result = enqueueBackgroundTask(workspace, job, { kind: "task" }, {
    spawnWorker: () => {
      workerLaunched = true;
      return { pid: 1 };
    },
    spawnWatchdog: () => {
      throw new Error("watchdog boom");
    }
  });

  assert.equal(workerLaunched, true);
  assert.equal(result.payload.status, "queued");
  assert.equal(result.payload.signalFile, resolveJobDoneFile(workspace, "task-bg2"));
});

// The detached background worker was spawned with stdio:"ignore", so a crash
// stack (the app-server dispatch guard's diagnostic, or the crash-net's logging)
// went to /dev/null in background mode — exactly the forensics you want under
// daily Codex churn. Route the worker's stderr (fd2) into the job log instead.
test("spawnDetachedTaskWorker routes the worker stderr (fd2) into the job log file", () => {
  const stdioSeen = [];
  let openedPath = null;
  let closedFd = null;

  const child = spawnDetachedTaskWorker("/ws", "task-x", "/ws/jobs/task-x.log", {
    spawnImpl: (_cmd, _args, opts) => {
      stdioSeen.push(opts.stdio);
      return { unref() {}, pid: 4242 };
    },
    openLog: (p) => {
      openedPath = p;
      return 77; // sentinel fd
    },
    closeLog: (fd) => {
      closedFd = fd;
    }
  });

  assert.equal(openedPath, "/ws/jobs/task-x.log", "the job log is opened for the worker stderr");
  assert.deepEqual(stdioSeen[0], ["ignore", "ignore", 77], "fd2 is the opened job log, not /dev/null");
  assert.equal(closedFd, 77, "the parent closes its copy of the inherited fd after spawn");
  assert.equal(child.pid, 4242);
});

test("spawnDetachedTaskWorker falls back to ignore when there is no log file", () => {
  const stdioSeen = [];
  spawnDetachedTaskWorker("/ws", "task-y", null, {
    spawnImpl: (_cmd, _args, opts) => {
      stdioSeen.push(opts.stdio);
      return { unref() {} };
    },
    openLog: () => {
      throw new Error("openLog must not be called when there is no log file");
    }
  });
  assert.deepEqual(stdioSeen[0], ["ignore", "ignore", "ignore"]);
});

// D: the detached liveness watchdog was spawned with stdio:"ignore", so if it crashed
// (or logged a diagnostic) the forensics went to /dev/null — and the watchdog is the
// only actor that recovers a hung/dead background turn. Route its stderr into the job
// log too, mirroring the worker.
test("spawnWatchdog routes the watchdog stderr (fd2) into the job log file", () => {
  const stdioSeen = [];
  let openedPath = null;
  let closedFd = null;

  const child = spawnWatchdog("/ws", "task-w", "/ws/jobs/task-w.log", {
    spawnImpl: (_cmd, _args, opts) => {
      stdioSeen.push(opts.stdio);
      return { unref() {}, pid: 5151 };
    },
    openLog: (p) => {
      openedPath = p;
      return 88; // sentinel fd
    },
    closeLog: (fd) => {
      closedFd = fd;
    }
  });

  assert.equal(openedPath, "/ws/jobs/task-w.log", "the job log is opened for the watchdog stderr");
  assert.deepEqual(stdioSeen[0], ["ignore", "ignore", 88], "fd2 is the opened job log, not /dev/null");
  assert.equal(closedFd, 88, "the parent closes its copy of the inherited fd after spawn");
  assert.equal(child.pid, 5151);
});

test("spawnWatchdog falls back to ignore when there is no log file", () => {
  const stdioSeen = [];
  spawnWatchdog("/ws", "task-w2", null, {
    spawnImpl: (_cmd, _args, opts) => {
      stdioSeen.push(opts.stdio);
      return { unref() {} };
    },
    openLog: () => {
      throw new Error("openLog must not be called when there is no log file");
    }
  });
  assert.deepEqual(stdioSeen[0], ["ignore", "ignore", "ignore"]);
});

// #7: enqueueBackgroundTask spawns the detached worker (:831) BEFORE it writes the job
// file (:850), with no await between — the worker's first act (handleTaskWorker ->
// readStoredJob) only succeeds because the parent's synchronous write normally wins the
// race against the child's Node bootstrap. Under scheduler pressure the child can reach
// the read first and, with a hard first-miss throw, the background job dies instantly.
// readStoredJobWithRetry removes that timing bet: bounded-wait for the file instead.
test("readStoredJobWithRetry waits out the spawn/write race instead of throwing on the first miss", async () => {
  let calls = 0;
  const job = await readStoredJobWithRetry("/ws", "task-x", {
    readFn: () => (++calls < 3 ? null : { id: "task-x" }),
    sleepFn: async () => {},
    attempts: 10
  });
  assert.deepEqual(job, { id: "task-x" });
  assert.equal(calls, 3, "kept reading until the parent's write landed");
});

test("readStoredJobWithRetry stays bounded and returns null when the job truly never appears", async () => {
  let calls = 0;
  const job = await readStoredJobWithRetry("/ws", "missing", {
    readFn: () => { calls++; return null; },
    sleepFn: async () => {},
    attempts: 5
  });
  assert.equal(job, null);
  assert.equal(calls, 5, "bounded to `attempts` reads — never spins forever");
});

test("spawnWatchdog closes the opened log fd even when the spawn throws (no fd leak)", () => {
  let closedFd = null;
  assert.throws(() =>
    spawnWatchdog("/ws", "task-w3", "/ws/jobs/task-w3.log", {
      spawnImpl: () => {
        throw new Error("spawn boom");
      },
      openLog: () => 99,
      closeLog: (fd) => {
        closedFd = fd;
      }
    })
  );
  assert.equal(closedFd, 99, "the inherited log fd is closed in finally even on spawn failure");
});
