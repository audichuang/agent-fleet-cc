import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClaudeArgs,
  runClaudeTurn,
  resolveTimeoutMs,
  DEFAULT_TIMEOUT_MS,
} from "../../plugins/delegate/scripts/lib/claude.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fake-claude.mjs",
);

// 把 binary/args 替換成 node + fixture，其餘照舊 — runClaudeTurn 的 spawn seam。
function fakeSpawn(mode) {
  return (_binary, _args, options) =>
    spawn(process.execPath, [FIXTURE], {
      ...options,
      env: { ...options.env, FAKE_CLAUDE_MODE: mode },
    });
}

test("buildClaudeArgs composes the headless invocation", () => {
  const args = buildClaudeArgs({ settingsPath: "/p/kimi.json" });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    "/p/kimi.json",
    "--permission-mode",
    "bypassPermissions",
  ]);
  const resumed = buildClaudeArgs({
    settingsPath: "/p/kimi.json",
    permissionMode: "acceptEdits",
    resumeSessionId: "sess-9",
  });
  assert.ok(resumed.includes("acceptEdits"));
  assert.deepEqual(resumed.slice(-2), ["-r", "sess-9"]);
});

test("resolveTimeoutMs defaults to 1h, env-overridable", () => {
  assert.equal(resolveTimeoutMs({}), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ DELEGATE_JOB_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveTimeoutMs({ DELEGATE_JOB_TIMEOUT_MS: "junk" }), DEFAULT_TIMEOUT_MS);
});

test("success: captures session id, result text, exit 0", async () => {
  const lines = [];
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "hello world",
    env: {},
    spawnImpl: fakeSpawn("success"),
    onLine: (line) => lines.push(line),
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.sessionId, "sess-fake-1");
  assert.match(outcome.resultText, /^echo:hello world/);
  assert.equal(outcome.isError, false);
  assert.ok(lines.length >= 2, "raw lines streamed to onLine");
});

test("noise: non-JSON and broken-JSON lines are skipped, result still captured", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "x",
    env: {},
    spawnImpl: fakeSpawn("noise"),
  });
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.resultText, /^echo:/);
});

test("fail: nonzero exit with stderr tail captured", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "x",
    env: {},
    spawnImpl: fakeSpawn("fail"),
  });
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.stderrTail, /invalid auth token/);
});

test("hang: timeout escalates SIGTERM→SIGKILL and flags timedOut", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "x",
    env: {},
    timeoutMs: 300,
    graceMs: 200,
    spawnImpl: fakeSpawn("hang"),
  });
  assert.equal(outcome.timedOut, true);
  assert.notEqual(outcome.exitCode, 0);
});

test("early-exit: big prompt EPIPE is survived, recorded, not thrown", async () => {
  const outcome = await runClaudeTurn({
    args: [],
    prompt: "p".repeat(1024 * 1024),
    env: {},
    spawnImpl: fakeSpawn("early-exit"),
  });
  assert.equal(outcome.exitCode, 3);
  assert.ok(outcome.stdinError, "stdin error captured");
});

test("onChild exposes the child handle so a cancel forwarder can kill it", async () => {
  let childRef = null;
  const outcomePromise = runClaudeTurn({
    args: [],
    prompt: "x",
    env: {},
    spawnImpl: fakeSpawn("hang"),
    onChild: (c) => {
      childRef = c;
    },
  });
  assert.ok(childRef, "onChild fires synchronously after spawn");
  childRef.kill("SIGTERM");
  const outcome = await outcomePromise;
  assert.equal(outcome.signal, "SIGTERM");
});

test("spawn failure (ENOENT) resolves as error outcome", async () => {
  const outcome = await runClaudeTurn({
    binary: "/definitely/not/a/binary",
    args: [],
    prompt: "x",
    env: {},
  });
  assert.equal(outcome.isError, true);
  assert.match(outcome.stderrTail, /ENOENT|not found/i);
});
