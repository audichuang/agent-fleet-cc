import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("execute-plan background flow documents the signal-file Monitor + PushNotification handoff", () => {
  const source = read("commands/execute-plan.md");
  assert.match(source, /signalFile/);
  assert.match(source, /Monitor/);
  assert.match(source, /until \[ -f/);
  assert.match(source, /PushNotification/);
});

// A wait that dies before the job does reports nothing, and the job it abandons
// usually SUCCEEDED — silence is indistinguishable from "still running". `Monitor`'s
// `timeout_ms` is a required parameter defaulting to five minutes and capped at one
// hour, and this command routes to the background exactly when the plan is big enough
// to outlast that. So the doc has to name a route with no deadline: `run_in_background`
// (the loop exits on its own, so one notification, no ceiling) or `persistent: true`.
// Naming the tools without naming the deadline is what left the hole.
test("execute-plan tells the model how to outlive Monitor's five-minute default", () => {
  const source = read("commands/execute-plan.md");
  assert.match(source, /run_in_background/, "the no-deadline route must be named");
  assert.match(source, /persistent:\s*`?true/, "the Monitor escape hatch must be named");
  assert.match(source, /five minutes|300000|5 minutes/i, "the default that bites must be stated");
});

// The old text promised the watchdog made this wait "always terminate". It does not:
// a watchdog that fails to spawn is swallowed into a job-log `Warning:` line and the
// launch payload carries no field reporting it, so the model arms its wait believing a
// backstop exists. The doc may describe the watchdog; it may not promise it.
test("execute-plan does not promise the liveness watchdog always terminates the wait", () => {
  const source = read("commands/execute-plan.md");
  assert.doesNotMatch(source, /always terminates/i);
});

test("execute-plan background launch emits the JSON payload it tells the model to parse", () => {
  const source = read("commands/execute-plan.md");
  // jobId + signalFile only exist when the launch uses --background --json. Without
  // them the companion prints plain text and the documented parse step is impossible.
  assert.match(source, /task --background --json --write --prompt-file/);
});

test("execute-plan grants the Monitor + PushNotification tools its background flow uses", () => {
  const source = read("commands/execute-plan.md");
  const frontmatter = source.split("---")[1] ?? "";
  assert.match(frontmatter, /allowed-tools:.*\bMonitor\b/);
  assert.match(frontmatter, /allowed-tools:.*\bPushNotification\b/);
});

test("status command documents the liveness watchdog", () => {
  const source = read("commands/status.md");
  assert.match(source, /watchdog/i);
});
