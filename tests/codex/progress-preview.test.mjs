import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { captureTurn } from "../../plugins/codex/scripts/lib/codex.mjs";
import { isHeartbeatProgressLine, readJobProgressPreview } from "../../plugins/codex/scripts/lib/job-control.mjs";

// A live run (gpt-6.1-sol, 2026-10-06) wrote a `Token usage` and a `Rate limits` line on
// every model call — every 5–30 s while a command ran — so the 4-line Progress preview
// showed only those and hid what Codex was actually doing. They still go to the log (they
// keep Last activity fresh); the preview skips them.

function writeLog(lines) {
  const logFile = path.join(makeTempDir(), "log");
  const stamp = "2026-10-06T05:00:00.000Z";
  fs.writeFileSync(logFile, lines.map((line) => `[${stamp}] ${line}\n`).join(""), "utf8");
  return logFile;
}

const strip = (line) => line.replace(/^\[[^\]]*\] /, "");

test("the Progress preview skips heartbeat lines and keeps what Codex is doing", () => {
  const logFile = writeLog([
    "Running command: npm test -- tests/shared/retry.test.mjs",
    "Thinking.",
    "Token usage: 22382 total (in 22315, out 67).",
    "Rate limits updated: primary 44% used.",
    "Command output streaming (~3 KB so far).",
    "Token usage: 44826 total (in 44720, out 106).",
    "Rate limits updated: primary 44% used."
  ]);
  assert.deepEqual(readJobProgressPreview(logFile).map(strip), [
    "Running command: npm test -- tests/shared/retry.test.mjs",
    "Thinking."
  ]);
});

function makeFakeClient() {
  return {
    notificationHandler: null,
    setNotificationHandler(fn) {
      this.notificationHandler = fn;
    },
    exitPromise: new Promise(() => {})
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The filter matches on text codex.mjs writes; take that text from codex.mjs itself so a
// reworded heartbeat cannot slip back into the preview unnoticed.
test("every heartbeat line codex.mjs writes is one the preview skips", async () => {
  const client = makeFakeClient();
  const lines = [];
  let resolveAck;
  const promise = captureTurn(client, "thread1", () => new Promise((r) => (resolveAck = r)), {
    idleTimeoutMs: 0,
    onProgress: (event) => lines.push(typeof event === "string" ? event : event?.message)
  });
  promise.catch(() => {});
  await tick();
  resolveAck({ turn: { id: "turn1", status: "inProgress" } });
  await tick();
  const notify = (method, params) => client.notificationHandler({ method, params: { threadId: "thread1", turnId: "turn1", ...params } });
  notify("thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 10, inputTokens: 8, outputTokens: 2 } } });
  notify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 44 } } });
  notify("item/commandExecution/outputDelta", { itemId: "c1", delta: "x" });
  client.notificationHandler({
    method: "turn/completed",
    params: { threadId: "thread1", turn: { id: "turn1", status: "completed" } }
  });
  await promise;

  const heartbeats = lines.filter((line) => /^(Token usage|Rate limits|Command output streaming)/.test(line ?? ""));
  assert.equal(heartbeats.length, 3, lines.join("\n"));
  for (const line of heartbeats) {
    assert.ok(isHeartbeatProgressLine(line), line);
  }
  assert.ok(!isHeartbeatProgressLine("Thinking."));
  assert.ok(!isHeartbeatProgressLine("Running command: npm test"));
});
