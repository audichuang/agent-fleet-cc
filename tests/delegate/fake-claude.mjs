#!/usr/bin/env node
// Scriptable stand-in for the claude CLI (stream-json contract).
// FAKE_CLAUDE_MODE: success (default) | noise | fail | hang | early-exit | env-echo
import fs from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
const sessionId = process.env.FAKE_CLAUDE_SESSION_ID ?? "sess-fake-1";

// e2e cancel tests poll this to verify the real child process dies.
if (process.env.FAKE_CLAUDE_PIDFILE) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(process.pid));
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (mode === "early-exit") {
  // Exit without ever reading stdin → parent gets EPIPE on a large prompt.
  process.exit(3);
}

let stdin = "";
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  out({ type: "system", subtype: "init", session_id: sessionId });
  if (mode === "env-echo") {
    // Report the env this process actually received, so tests can assert the
    // rebuilt-env contract across a REAL detached worker process boundary.
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? null,
        CLAUDECODE: process.env.CLAUDECODE ?? null,
        CLAUDE_DELEGATE_ACTIVE: process.env.CLAUDE_DELEGATE_ACTIVE ?? null,
      }),
      session_id: sessionId,
    });
    process.exit(0);
  }
  if (mode === "noise") {
    process.stdout.write("WARNING: ansi-ish noise line\n");
    process.stdout.write("{broken json line\n");
  }
  if (mode === "fail") {
    process.stderr.write("API error: invalid auth token\n");
    process.exit(1);
  }
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `echo:${stdin.trim().slice(0, 60)}`,
    session_id: sessionId,
  });
  process.exit(0);
});
