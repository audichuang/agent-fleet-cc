// job-runtime seam (Phase 3): drives runForeground / startBackground against
// the fake-agy shim + the VENDORED shared layout, and unit-tests the
// projectJob / listProjectedJobs / makeRecord projection contract. Hermetic:
// fake binary via AGY_BIN, redirected CLAUDE_PLUGIN_DATA, no network, no real agy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runForeground,
  startBackground,
  projectJob,
  listProjectedJobs,
  stateDirFor,
} from "../../plugins/antigravity/scripts/lib/job-runtime.mjs";
import { createJobRecord } from "../../plugins/antigravity/scripts/lib/shared/core/job.mjs";
import {
  createJob,
  readJob,
  writeJob,
  listJobs,
  jobDir,
} from "../../plugins/antigravity/scripts/lib/shared/core/state-store.mjs";
import { readEvents } from "../../plugins/antigravity/scripts/lib/shared/core/events.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-agy.mjs");

// A hermetic, directly-spawnable `agy` binary: resolveAgyBin returns the path in
// AGY_BIN when it exists, and spawnEngine spawns argv[0] directly — so wrap the
// (non-executable) fake-agy.mjs in a tiny exec-bit launcher the test owns.
function writeFakeAgyBin(dir) {
  const bin = path.join(dir, "agy");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nimport("${FAKE.replace(/\\/g, "\\\\")}");\n`,
    { mode: 0o755 },
  );
  return bin;
}

// Build a hermetic env: a git-root cwd (a tmp dir), CLAUDE_PLUGIN_DATA so the
// state root is under our temp, AGY_BIN → fake, FAKE_AGY_MODE for the shim.
function makeEnv(mode, extra = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jr-data-"));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jr-bin-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jr-cwd-"));
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true }); // resolveWorkspaceRoot anchor
  const bin = writeFakeAgyBin(binDir);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_PLUGIN_DATA: dataRoot,
    AGY_BIN: bin,
    FAKE_AGY_MODE: mode,
    ...extra,
  };
  return { env, cwd, dataRoot };
}

test("runForeground(ok) → terminal completed + full event trail", async () => {
  const { env, cwd } = makeEnv("ok");
  const { stateDir, job } = await runForeground({
    cwd,
    kind: "task",
    title: "t",
    prompt: "hello",
    request: { mode: "print" },
    env,
    deps: { graceMs: 200 },
  });
  assert.equal(job.status, "completed");
  assert.equal(job.sessionId, null); // agy engine sessionId always null
  // resultText → result.rawOutput; inner blank lines preserved (D-1 lossless)
  assert.equal(job.result.rawOutput, "OK\n\nbody paragraph one.\n\nbody paragraph two.");
  const events = readEvents(jobDir(stateDir, job.id));
  for (const t of ["job-created", "spawned", "result", "finalized"]) {
    assert.ok(events.some((e) => e.type === t), `missing event ${t}`);
  }
});

test("startBackground(echo) → job dir + events, reaches terminal", async () => {
  const { env, cwd } = makeEnv("echo");
  const { stateDir, job, failed } = startBackground({
    cwd,
    kind: "task",
    title: "bg",
    prompt: "hello bg",
    request: { mode: "print" },
    env,
  });
  assert.equal(failed, false);
  assert.ok(job.id);
  // Wait for the detached worker to finalize the job.
  const deadline = Date.now() + 10000;
  let final = readJob(stateDir, job.id);
  while (Date.now() < deadline && !["completed", "failed", "cancelled", "timed-out"].includes(final?.status)) {
    await new Promise((r) => setTimeout(r, 50));
    final = readJob(stateDir, job.id);
  }
  assert.equal(final.status, "completed");
  const events = readEvents(jobDir(stateDir, job.id));
  for (const t of ["job-created", "spawned", "result", "finalized"]) {
    assert.ok(events.some((e) => e.type === t), `missing event ${t}`);
  }
});

test("startBackground sync-throw guard → finalizes failed (spawn)", () => {
  const { env, cwd } = makeEnv("ok");
  const { job, failed } = startBackground({
    cwd,
    kind: "task",
    title: "boom",
    prompt: "x",
    request: { mode: "print" },
    env,
    deps: {
      workerSpawnImpl: () => {
        throw new Error("spawn EACCES");
      },
    },
  });
  assert.equal(failed, true);
  assert.equal(job.status, "failed");
  assert.equal(job.errorKind, "spawn");
});

test("makeRecord writes top-level sessionId from ANTIGRAVITY_PLUGIN_SESSION_ID (D-14)", async () => {
  const { env, cwd } = makeEnv("empty", { ANTIGRAVITY_PLUGIN_SESSION_ID: "sess-xyz" });
  const { stateDir, job } = await runForeground({
    cwd,
    kind: "task",
    title: "s",
    prompt: "p",
    request: { mode: "print" },
    env,
    deps: { graceMs: 200 },
  });
  const stored = readJob(stateDir, job.id);
  assert.equal(stored.sessionId, "sess-xyz");
});

test("makeRecord clamps timeoutMs >= effective print timeout (D-19)", async () => {
  // request.printTimeoutMs (5m) far exceeds a tiny request.timeoutMs (1ms) and
  // the env-derived hardMs — the backstop must never pre-empt agy's own timeout.
  const bigPrint = 300000;
  const { env, cwd } = makeEnv("empty");
  const { stateDir, job } = await runForeground({
    cwd,
    kind: "task",
    title: "clamp",
    prompt: "p",
    request: { mode: "print", printTimeoutMs: bigPrint, timeoutMs: 1 },
    env,
    deps: { graceMs: 200 },
  });
  const stored = readJob(stateDir, job.id);
  assert.ok(
    stored.timeoutMs >= bigPrint,
    `timeoutMs ${stored.timeoutMs} must be >= effective print ${bigPrint}`,
  );
});

test("makeRecord carries conversationId into job.request (M8)", async () => {
  const { env, cwd } = makeEnv("empty");
  const { stateDir, job } = await runForeground({
    cwd,
    kind: "task",
    title: "conv",
    prompt: "p",
    request: { mode: "continue", conversationId: "conv-123" },
    env,
    deps: { graceMs: 200 },
  });
  const stored = readJob(stateDir, job.id);
  assert.equal(stored.request.conversationId, "conv-123");
  // projectJob surfaces it at top-level for the command layer.
  assert.equal(projectJob(stored).conversationId, "conv-123");
});

test("projectJob maps resultText→result.rawOutput and shapes fields", () => {
  const rec = createJobRecord({ engine: "antigravity", request: { kind: "review" } });
  const job = {
    ...rec,
    status: "completed",
    resultText: "first line\nsecond line",
    exitCode: 0,
    error: null,
  };
  const p = projectJob(job);
  assert.equal(p.result.rawOutput, "first line\nsecond line");
  assert.equal(p.result.status, "completed");
  assert.equal(p.result.exitCode, 0);
  assert.equal(p.kind, "review");
  assert.equal(p.threadId, null);
  assert.equal(p.conversationId, null);
  assert.equal(p.summary, "first line");
  assert.equal(p.errorMessage, null);
});

test("projectJob: null resultText → result null", () => {
  const rec = createJobRecord({ engine: "antigravity" });
  const p = projectJob({ ...rec, status: "completed", resultText: null });
  assert.equal(p.result, null);
  assert.equal(p.summary, null);
});

test("projectJob: auth-by-text sets errorKind auth (stdout-auth case)", () => {
  const rec = createJobRecord({ engine: "antigravity" });
  const p = projectJob({
    ...rec,
    status: "failed",
    resultText: "Authentication required. Please visit https://accounts.google.com/o/oauth2/auth",
    errorKind: null,
    error: "engine exited nonzero",
  });
  assert.equal(p.errorKind, "auth");
  assert.equal(p.errorMessage, "engine exited nonzero");
});

test("projectJob: passes through non-auth errorKind unchanged", () => {
  const rec = createJobRecord({ engine: "antigravity" });
  const p = projectJob({ ...rec, status: "failed", resultText: "boom", errorKind: "endpoint" });
  assert.equal(p.errorKind, "endpoint");
});

test("projectJob(null) → null", () => {
  assert.equal(projectJob(null), null);
});

test("listProjectedJobs sorts by updatedAt desc and projects", () => {
  const sd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jr-list-"));
  // createdAt ascending A<B<C, but updatedAt makes B the newest.
  const mk = (id, createdAt, updatedAt, resultText) => {
    const rec = createJobRecord({ engine: "antigravity" });
    createJob(sd, { ...rec, id, createdAt, updatedAt, status: "completed", resultText }, "p");
    // createJob writes the record verbatim; writeJob would bump updatedAt, so
    // stamp updatedAt directly via a raw re-write to keep the test deterministic.
    const jf = path.join(jobDir(sd, id), "job.json");
    const stored = JSON.parse(fs.readFileSync(jf, "utf8"));
    fs.writeFileSync(jf, JSON.stringify({ ...stored, createdAt, updatedAt }, null, 2));
  };
  mk("antigravity-a", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "A");
  mk("antigravity-b", "2026-01-02T00:00:00.000Z", "2026-01-09T00:00:00.000Z", "B");
  mk("antigravity-c", "2026-01-03T00:00:00.000Z", "2026-01-04T00:00:00.000Z", "C");
  const projected = listProjectedJobs(sd);
  assert.deepEqual(
    projected.map((j) => j.id),
    ["antigravity-b", "antigravity-c", "antigravity-a"],
  );
  // Projection applied: result.rawOutput present.
  assert.equal(projected[0].result.rawOutput, "B");
});

test("stateDirFor is deterministic per gitRoot + honors CLAUDE_PLUGIN_DATA", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-jr-sd-"));
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  const env = { CLAUDE_PLUGIN_DATA: "/data/root" };
  const a = stateDirFor(cwd, env);
  const b = stateDirFor(cwd, env);
  assert.equal(a, b);
  assert.ok(a.startsWith(path.join("/data/root", "state")), a);
});
