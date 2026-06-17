import { makeDataRoot, makeTempDir, writeProfile } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runCompanion } from "../../plugins/delegate/scripts/delegate-companion.mjs";
import {
  listJobs,
  readJob,
  jobFilePath,
  promptFilePath,
  logFilePath,
} from "../../plugins/delegate/scripts/lib/shared/core/state-store.mjs";
import { TERMINAL_STATUSES } from "../../plugins/delegate/scripts/lib/shared/core/job.mjs";
import { isPidAlive } from "../../plugins/delegate/scripts/lib/shared/core/reconcile.mjs";
import { workspaceStateDir } from "../../plugins/delegate/scripts/lib/adapter.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);
const fakeSpawn =
  (mode) =>
  (_b, _a, options) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });

function setup() {
  const dataRoot = makeDataRoot();
  const cwd = makeTempDir("delegate-ws-");
  writeProfile(dataRoot, "kimi", { env: { ANTHROPIC_BASE_URL: "https://cheap" } });
  const out = [];
  const deps = {
    env: { DELEGATE_PLUGIN_DATA: dataRoot, PATH: process.env.PATH },
    cwd,
    out: (line) => out.push(line),
    claudeSpawnImpl: fakeSpawn("success"),
  };
  return { dataRoot, cwd, out, deps, stateDir: workspaceStateDir(dataRoot, cwd) };
}

test("recursion guard: CLAUDE_DELEGATE_ACTIVE=1 makes companion a no-op", async () => {
  const { deps, out } = setup();
  deps.env.CLAUDE_DELEGATE_ACTIVE = "1";
  const code = await runCompanion(["task", "anything"], deps);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /recursion guard/);
});

test("foreground task: runs to completion and prints the result", async () => {
  const { deps, out, stateDir } = setup();
  const code = await runCompanion(
    ["task", "say", "hi", "--profile", "kimi"],
    deps,
  );
  assert.equal(code, 0);
  const jobs = listJobs(stateDir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].request.profile, "kimi");
  assert.match(out.join("\n"), /echo:say hi/);
  assert.equal(
    fs.readFileSync(promptFilePath(stateDir, jobs[0].id), "utf8"),
    "say hi",
  );
});

test("background task: writes queued job + prompt file and spawns detached worker", async () => {
  const { deps, out, stateDir } = setup();
  const spawned = [];
  deps.workerSpawnImpl = (cmd, args, options) => {
    spawned.push({ cmd, args, options });
    return { unref() {}, pid: 7777 };
  };
  const code = await runCompanion(
    ["task", "long", "job", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(code, 0);
  const jobs = listJobs(stateDir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
  assert.match(jobs[0].id, /^delegate-/);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.some((a) => a.includes("worker-entry.mjs")));
  assert.ok(spawned[0].args.includes(jobs[0].id));
  assert.equal(spawned[0].options.detached, true);
  assert.match(out.join("\n"), new RegExp(jobs[0].id));
});

test("task without profile or default fails with guidance, creates no job", async () => {
  const { deps, out, stateDir } = setup();
  const code = await runCompanion(["task", "hi"], deps);
  assert.notEqual(code, 0);
  assert.equal(listJobs(stateDir).length, 0);
  assert.match(out.join("\n"), /profile/i);
});

test("task without a prompt or --prompt-file fails with UsageError, creates no job", async () => {
  const { deps, out, stateDir } = setup();
  const code = await runCompanion(["task", "--profile", "kimi"], deps);
  assert.notEqual(code, 0);
  assert.equal(listJobs(stateDir).length, 0);
  assert.match(out.join("\n"), /prompt/i);
});

test("--prompt-file reads the prompt from a file (workflow seam)", async () => {
  const { dataRoot, cwd, deps } = setup();
  const promptPath = path.join(cwd, "p.md");
  fs.writeFileSync(promptPath, "from file");
  const code = await runCompanion(
    ["task", "--prompt-file", promptPath, "--profile", "kimi"],
    deps,
  );
  assert.equal(code, 0);
  const job = listJobs(workspaceStateDir(dataRoot, cwd))[0];
  assert.equal(
    fs.readFileSync(promptFilePath(workspaceStateDir(dataRoot, cwd), job.id), "utf8"),
    "from file",
  );
});

test("--prompt-file with an unreadable path fails with UsageError, creates no job", async () => {
  const { deps, out, stateDir } = setup();
  const code = await runCompanion(
    ["task", "--prompt-file", "/no/such/prompt.md", "--profile", "kimi"],
    deps,
  );
  assert.notEqual(code, 0);
  assert.equal(listJobs(stateDir).length, 0);
  assert.match(out.join("\n"), /prompt file not readable/i);
});

test("--json on background launch emits the unified launch projection", async () => {
  const { deps } = setup();
  const lines = [];
  deps.out = (line) => lines.push(line);
  deps.workerSpawnImpl = () => ({ unref() {}, pid: 7777 });
  await runCompanion(
    ["task", "x", "--profile", "kimi", "--background", "--json"],
    deps,
  );
  const payload = JSON.parse(lines.join("\n"));
  assert.equal(payload.engine, "delegate");
  assert.equal(payload.status, "queued");
  assert.match(payload.jobId, /^delegate-/);
});

test("--json on foreground completion emits the unified result projection", async () => {
  const { deps } = setup();
  const lines = [];
  deps.out = (line) => lines.push(line);
  const code = await runCompanion(
    ["task", "hello", "--profile", "kimi", "--json"],
    deps,
  );
  assert.equal(code, 0);
  const payload = JSON.parse(lines.join("\n"));
  assert.equal(payload.engine, "delegate");
  assert.equal(payload.status, "completed");
  assert.ok(typeof payload.resultText === "string");
  assert.ok("sessionId" in payload && "durationMs" in payload && "errorKind" in payload);
});

test("--read-only maps to permission-mode default in the spawned argv; --write and default map to bypassPermissions", async () => {
  for (const [flags, expected] of [
    [["--read-only"], "default"],
    [["--write"], "bypassPermissions"],
    [[], "bypassPermissions"],
  ]) {
    const { deps } = setup();
    let captured = null;
    deps.claudeSpawnImpl = (_b, args, options) => {
      captured = args;
      return spawn(process.execPath, [FIXTURE], {
        ...options,
        env: { ...options.env, FAKE_CLAUDE_MODE: "success" },
      });
    };
    const code = await runCompanion(
      ["task", "hi", "--profile", "kimi", ...flags],
      deps,
    );
    assert.equal(code, 0, `flags=${flags.join(" ")}`);
    const idx = captured.indexOf("--permission-mode");
    assert.ok(idx >= 0, `--permission-mode present for ${flags.join(" ")}`);
    assert.equal(captured[idx + 1], expected, `flags=${flags.join(" ")}`);
  }
});

test("--model is threaded into the spawned argv", async () => {
  const { deps } = setup();
  let captured = null;
  deps.claudeSpawnImpl = (_b, args, options) => {
    captured = args;
    return spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: "success" },
    });
  };
  const code = await runCompanion(
    ["task", "hi", "--profile", "kimi", "--model", "deepseek-chat"],
    deps,
  );
  assert.equal(code, 0);
  const idx = captured.indexOf("--model");
  assert.ok(idx >= 0);
  assert.equal(captured[idx + 1], "deepseek-chat");
});

test("resume-job reuses source job settings + session, links resumedFrom", async () => {
  const { deps, stateDir } = setup();
  await runCompanion(["task", "first", "--profile", "kimi"], deps);
  const first = listJobs(stateDir)[0];
  assert.equal(first.sessionId, "sess-fake-1");
  const code = await runCompanion(
    ["task", "follow", "up", "--resume-job", first.id],
    deps,
  );
  assert.equal(code, 0);
  const jobs = listJobs(stateDir);
  const resumed = jobs.find((j) => j.id !== first.id);
  assert.equal(resumed.request.resumedFrom, first.id);
  assert.equal(resumed.request.resumeSessionId, "sess-fake-1");
  assert.equal(resumed.request.settingsPath, first.request.settingsPath);
});

test("--resume-id now fails with UsageError (renamed to --resume-job)", async () => {
  const { deps, out, stateDir } = setup();
  await runCompanion(["task", "first", "--profile", "kimi"], deps);
  const first = listJobs(stateDir)[0];
  out.length = 0;
  const code = await runCompanion(
    ["task", "follow", "--resume-id", first.id],
    deps,
  );
  assert.notEqual(code, 0);
  assert.match(out.join("\n"), /Unknown flag: --resume-id/);
});

test("resume ignores --profile: reuses source job's settings (no mid-resume model switch)", async () => {
  const { deps, dataRoot, stateDir } = setup();
  writeProfile(dataRoot, "glm", { env: { ANTHROPIC_BASE_URL: "https://other" } });
  await runCompanion(["task", "first", "--profile", "kimi"], deps);
  const first = listJobs(stateDir)[0];
  const code = await runCompanion(
    ["task", "follow", "--resume-job", first.id, "--profile", "glm"],
    deps,
  );
  assert.equal(code, 0);
  const resumed = listJobs(stateDir).find((j) => j.id !== first.id);
  assert.equal(resumed.request.profile, "kimi");
  assert.equal(resumed.request.settingsPath, first.request.settingsPath);
});

test("resume-last picks newest terminal job with a session id", async () => {
  const { deps, stateDir } = setup();
  await runCompanion(["task", "first", "--profile", "kimi"], deps);
  const code = await runCompanion(["task", "more", "--resume-last"], deps);
  assert.equal(code, 0);
  assert.equal(listJobs(stateDir).length, 2);
});

async function waitForTerminal(stateDir, jobId, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const job = readJob(stateDir, jobId);
    if (job && TERMINAL_STATUSES.has(job.status)) return job;
    await sleep(50);
  }
  throw new Error(`job ${jobId} not terminal within ${deadlineMs}ms`);
}

test("background e2e: cancel kills the REAL claude child across process boundaries", async () => {
  const { deps, stateDir } = setup();
  const binDir = makeTempDir("delegate-bin-");
  const shim = path.join(binDir, "fake-claude");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`,
    { mode: 0o755 },
  );
  const pidFile = path.join(binDir, "claude.pid");
  deps.env = {
    ...deps.env,
    DELEGATE_CLAUDE_BIN: shim,
    FAKE_CLAUDE_MODE: "hang",
    FAKE_CLAUDE_PIDFILE: pidFile,
  };
  delete deps.workerSpawnImpl;
  const code = await runCompanion(
    ["task", "ping", "--profile", "kimi", "--background"],
    deps,
  );
  assert.equal(code, 0);
  const jobId = listJobs(stateDir)[0].id;
  // 等 claude 起來且 job 轉 running
  const upDeadline = Date.now() + 10_000;
  while (Date.now() < upDeadline) {
    if (fs.existsSync(pidFile) && readJob(stateDir, jobId)?.status === "running") break;
    await sleep(50);
  }
  const claudePid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(claudePid > 1);
  assert.equal(isPidAlive(claudePid), true, "fake claude is running");

  const cancelCode = await runCompanion(["cancel", jobId], deps);
  assert.equal(cancelCode, 0);
  // worker 收到 SIGTERM 後必須把 claude child 一起帶走
  let alive = true;
  const killDeadline = Date.now() + 10_000;
  while (Date.now() < killDeadline) {
    alive = isPidAlive(claudePid);
    if (!alive) break;
    await sleep(50);
  }
  assert.equal(alive, false, "claude child is dead after cancel");
  assert.equal(readJob(stateDir, jobId).status, "cancelled");
});

test("background end-to-end: REAL detached worker runs fake claude with rebuilt env", async () => {
  const { deps, stateDir } = setup();
  // Executable shim so the detached worker can spawn the fixture as `claude`.
  const binDir = makeTempDir("delegate-bin-");
  const shim = path.join(binDir, "fake-claude");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`,
    { mode: 0o755 },
  );
  deps.env = {
    ...deps.env,
    DELEGATE_CLAUDE_BIN: shim,
    FAKE_CLAUDE_MODE: "env-echo",
    // Polluted main-session env that the worker must strip before spawning.
    ANTHROPIC_BASE_URL: "https://expensive",
    ANTHROPIC_MODEL: "opus",
    CLAUDECODE: "1",
  };
  delete deps.workerSpawnImpl; // real spawn — this is the point of the test
  const code = await runCompanion(
    ["task", "ping", "--profile", "kimi", "--background", "--timeout-ms", "8000"],
    deps,
  );
  assert.equal(code, 0);
  const queued = listJobs(stateDir)[0];
  assert.equal(queued.status, "queued");
  const job = await waitForTerminal(stateDir, queued.id, 10_000);
  assert.equal(job.status, "completed");
  assert.equal(job.sessionId, "sess-fake-1");
  const seen = JSON.parse(job.resultText);
  assert.equal(seen.ANTHROPIC_BASE_URL, "https://cheap");
  assert.equal(seen.ANTHROPIC_MODEL, null);
  assert.equal(seen.CLAUDECODE, null);
  assert.equal(seen.CLAUDE_DELEGATE_ACTIVE, "1");
});

test("--timeout-ms rejects non-positive and non-numeric values, creates no job", async () => {
  const { deps, out, stateDir } = setup();
  for (const bad of ["abc", "0", "-5"]) {
    const code = await runCompanion(
      ["task", "hi", "--profile", "kimi", "--timeout-ms", bad],
      deps,
    );
    assert.notEqual(code, 0, `--timeout-ms ${bad}`);
  }
  assert.equal(listJobs(stateDir).length, 0);
  assert.match(out.join("\n"), /timeout-ms must be a positive number/);
});

test("--profile with path traversal is rejected before any job is created", async () => {
  const { deps, dataRoot, out, stateDir } = setup();
  fs.writeFileSync(path.join(dataRoot, "evil.json"), JSON.stringify({ env: {} }));
  const code = await runCompanion(["task", "hi", "--profile", "../evil"], deps);
  assert.notEqual(code, 0);
  assert.equal(listJobs(stateDir).length, 0);
  assert.match(out.join("\n"), /Invalid profile name/);
});

test("result/cancel/resume-job reject traversal job ids", async () => {
  const { deps, out } = setup();
  assert.notEqual(await runCompanion(["result", "../../etc/passwd"], deps), 0);
  assert.notEqual(await runCompanion(["cancel", "../../x"], deps), 0);
  assert.notEqual(
    await runCompanion(["task", "hi", "--resume-job", "../../x"], deps),
    0,
  );
  assert.match(out.join("\n"), /Invalid job id/);
});

test("resume with deleted source settings fails fast, creates no new job", async () => {
  const { deps, out, stateDir } = setup();
  await runCompanion(["task", "first", "--profile", "kimi"], deps);
  const first = listJobs(stateDir)[0];
  fs.unlinkSync(first.request.settingsPath);
  const code = await runCompanion(
    ["task", "again", "--resume-job", first.id],
    deps,
  );
  assert.notEqual(code, 0);
  assert.equal(listJobs(stateDir).length, 1, "no new job written");
  assert.match(out.join("\n"), /not found/i);
});

test("job artifacts are owner-only (no group/world access)", async () => {
  const { deps, stateDir } = setup();
  await runCompanion(["task", "secret prompt", "--profile", "kimi"], deps);
  const job = listJobs(stateDir)[0];
  for (const file of [
    promptFilePath(stateDir, job.id),
    jobFilePath(stateDir, job.id),
    logFilePath(stateDir, job.id),
  ]) {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode & 0o077, 0, `${path.basename(file)} is 0o${mode.toString(8)}`);
  }
});

test("execute-plan wraps the plan file into the prompt", async () => {
  const { deps, cwd, stateDir } = setup();
  const planPath = path.join(cwd, "plan.md");
  fs.writeFileSync(planPath, "# The Plan\n1. do X");
  const code = await runCompanion(
    ["execute-plan", planPath, "--profile", "kimi"],
    deps,
  );
  assert.equal(code, 0);
  const job = listJobs(stateDir)[0];
  const prompt = fs.readFileSync(promptFilePath(stateDir, job.id), "utf8");
  assert.match(prompt, /pre-approved implementation plan/);
  assert.match(prompt, /# The Plan/);
});

test("execute-plan with missing file fails cleanly", async () => {
  const { deps, out } = setup();
  const code = await runCompanion(
    ["execute-plan", "/no/such/plan.md", "--profile", "kimi"],
    deps,
  );
  assert.notEqual(code, 0);
  assert.match(out.join("\n"), /plan file/i);
});
