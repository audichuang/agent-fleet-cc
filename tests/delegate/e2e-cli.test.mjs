// Black-box end-to-end regression: drives the REAL delegate-companion.mjs CLI
// as a subprocess (the genuine isCliEntry / process.argv path), with a real
// detached worker-entry, a real directory-layout store, and a real two-stage
// cancel — using a fake-claude shim so it needs NO API key and runs anywhere
// (CI included). This catches integration regressions that the in-process
// runCompanion(deps) unit tests structurally cannot (CLI wiring, real spawn,
// cross-process cancel, the --json projections a user/orchestrator actually
// sees). The real-endpoint smoke (real claude API) remains a separate manual
// gate — see scripts note at the bottom.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(HERE, "../../plugins/delegate/scripts/delegate-companion.mjs");
const FAKE_CLAUDE = path.join(HERE, "fake-claude.mjs");

// A fresh, isolated workspace per test (own data root + cwd + claude shim).
function makeWorkspace() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-data-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ws-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bin-"));
  const shim = path.join(bin, "claude");
  // Shim answers `--version` for setup's health probe, otherwise runs the
  // fake-claude stream-json fixture with whatever argv the adapter composed.
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-claude 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(data, "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(data, "profiles", "p-ok.json"),
    JSON.stringify({ env: { FAKE_CLAUDE_MODE: "success" } }),
  );
  fs.writeFileSync(
    path.join(data, "profiles", "p-hang.json"),
    JSON.stringify({ env: { FAKE_CLAUDE_MODE: "hang" } }),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DELEGATE_PLUGIN_DATA: data,
    DELEGATE_CLAUDE_BIN: shim,
  };
  return {
    env,
    ws,
    cleanup() {
      for (const d of [data, ws, bin]) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

// Invoke the companion CLI as a real subprocess, exactly as a user/orchestrator
// would: `node delegate-companion.mjs <verb> ...`.
function cli(w, args, opts = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: w.ws,
    env: w.env,
    encoding: "utf8",
    timeout: opts.timeout ?? 20000,
  });
}

// Parse the last non-empty stdout line as JSON (a --json call emits one line).
function lastJson(res) {
  const lines = (res.stdout ?? "").trim().split("\n").filter(Boolean);
  assert.ok(lines.length, `expected JSON on stdout, got: ${JSON.stringify(res.stdout)} / stderr: ${res.stderr}`);
  return JSON.parse(lines[lines.length - 1]);
}

async function pollStatus(w, jobId, want, deadlineMs = 15000) {
  const end = Date.now() + deadlineMs;
  let status = "?";
  while (Date.now() < end) {
    const arr = lastJson(cli(w, ["status", "--json"]));
    const job = Array.isArray(arr) ? arr.find((j) => j.jobId === jobId) : null;
    status = job ? job.status : "MISSING";
    if (status === want) return status;
    await sleep(200);
  }
  return status;
}

test("e2e: setup reports the claude shim + profiles", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["setup"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /fake-claude 0\.0\.0/);
    assert.match(res.stdout, /profile p-ok/);
  } finally {
    w.cleanup();
  }
});

test("e2e: foreground task runs to completion with a unified --json projection", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["task", "hello foreground", "--profile", "p-ok", "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const payload = lastJson(res);
    assert.equal(payload.engine, "delegate");
    assert.equal(payload.status, "completed");
    assert.equal(payload.resultText, "echo:hello foreground");
    assert.match(payload.jobId, /^delegate-/);
    assert.equal(payload.errorKind, null);
  } finally {
    w.cleanup();
  }
});

test("e2e: background lifecycle task -> status -> wait -> logs -> result", async () => {
  const w = makeWorkspace();
  try {
    const launch = lastJson(cli(w, ["task", "hello background", "--profile", "p-ok", "--background", "--json"]));
    assert.equal(launch.status, "queued");
    assert.match(launch.jobId, /^delegate-/);
    const jobId = launch.jobId;

    // status lists the queued/running job
    const statusArr = lastJson(cli(w, ["status", "--json"]));
    assert.ok(statusArr.some((j) => j.jobId === jobId), "status --json must list the job");

    // wait blocks to terminal and reports completed (exit 0)
    const waitRes = cli(w, ["wait", jobId, "--timeout-s", "30", "--json"], { timeout: 35000 });
    assert.equal(waitRes.status, 0, waitRes.stderr);
    assert.equal(lastJson(waitRes).status, "completed");

    // logs prints the full events spine
    const logs = cli(w, ["logs", jobId]).stdout;
    for (const ev of ["job-created", "spawned", "finalized"]) {
      assert.match(logs, new RegExp(ev), `logs must include ${ev}`);
    }

    // result returns the completed projection (exit 0)
    const resultRes = cli(w, ["result", jobId, "--json"]);
    assert.equal(resultRes.status, 0, resultRes.stderr);
    const result = lastJson(resultRes);
    assert.equal(result.status, "completed");
    assert.equal(result.resultText, "echo:hello background");
    assert.equal(result.sessionId, "sess-fake-1");
  } finally {
    w.cleanup();
  }
});

test("e2e: two-stage cancel kills a real running engine and finalizes cancelled", async () => {
  const w = makeWorkspace();
  let jobId;
  try {
    jobId = lastJson(cli(w, ["task", "hang me", "--profile", "p-hang", "--background", "--json"])).jobId;
    const running = await pollStatus(w, jobId, "running");
    assert.equal(running, "running", "hang job must reach running before cancel");

    const cancel = lastJson(cli(w, ["cancel", jobId, "--json"]));
    assert.equal(cancel.ok, true);
    assert.match(cancel.message, /Cancelled/);

    const finalStatus = await pollStatus(w, jobId, "cancelled");
    assert.equal(finalStatus, "cancelled", "job must be cancelled after the two-stage kill");
  } finally {
    if (jobId) cli(w, ["cancel", jobId]); // belt-and-suspenders: no leaked engine
    w.cleanup();
  }
});

test("e2e: wait on a still-running job times out with the dedicated exit code 10", async () => {
  const w = makeWorkspace();
  let jobId;
  try {
    jobId = lastJson(cli(w, ["task", "hang again", "--profile", "p-hang", "--background", "--json"])).jobId;
    await pollStatus(w, jobId, "running");
    const waitRes = cli(w, ["wait", jobId, "--timeout-s", "1", "--json"], { timeout: 10000 });
    assert.equal(waitRes.status, 10, "timeout is exit 10 (not an error) for clean orchestrator re-entry");
    assert.equal(lastJson(waitRes).status, "running");
  } finally {
    if (jobId) cli(w, ["cancel", jobId]);
    w.cleanup();
  }
});

test("e2e: machine-contract guards reject misuse (renamed/mutex/traversal/recursion)", () => {
  const w = makeWorkspace();
  try {
    // --resume-id was renamed to --resume-job and must now error
    assert.notEqual(cli(w, ["task", "x", "--profile", "p-ok", "--resume-id", "delegate-x"]).status, 0);
    // --wait and --background are mutually exclusive
    assert.notEqual(cli(w, ["task", "x", "--profile", "p-ok", "--wait", "--background"]).status, 0);
    // traversal job ids are rejected before any fs use
    assert.notEqual(cli(w, ["cancel", "../../etc/passwd"]).status, 0);
    assert.notEqual(cli(w, ["result", "../../x"]).status, 0);
    // recursion guard: inside a delegate session the companion is a no-op
    const recRes = spawnSync(process.execPath, [COMPANION, "task", "x", "--profile", "p-ok"], {
      cwd: w.ws,
      env: { ...w.env, CLAUDE_DELEGATE_ACTIVE: "1" },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(recRes.status, 0);
    assert.match(recRes.stdout, /recursion guard/i);
  } finally {
    w.cleanup();
  }
});
