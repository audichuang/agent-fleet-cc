#!/usr/bin/env node
// Scriptable stand-in for the claude CLI (stream-json contract).
// FAKE_CLAUDE_MODE: success (default) | noise | fail | hang | early-exit | env-echo
//                   conf-ok | conf-resume | conf-midway-drop | conf-noise | conf-hang |
//                   conf-instant-exit | conf-huge-output | conf-auth-expire-midway | conf-grandchild
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

// conf-instant-exit must exit before consuming stdin (mirrors early-exit placement)
if (mode === "conf-instant-exit") process.exit(7);

let stdin = "";
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", async () => {
  // conf-* conformance modes (placed after stdin read so they can use stdin/argv)
  if (mode === "conf-ok") {
    out({ type: "system", session_id: "fake-session-1" });
    out({ type: "result", result: `echo:${stdin.trim().slice(0, 40)}`, is_error: false,
          usage: { input_tokens: 7, output_tokens: 3 } });
    process.exit(0);
  }
  if (mode === "conf-resume") {
    out({ type: "system", session_id: "fake-session-1" });
    out({ type: "result", result: process.argv.includes("-r") ? "resumed" : "fresh", is_error: false });
    process.exit(0);
  }
  if (mode === "conf-midway-drop") {
    out({ type: "system", session_id: "fake-session-2" });
    process.exit(1);
  }
  if (mode === "conf-noise") {
    process.stdout.write("plain noise\n{broken json\n");
    out({ type: "result", result: "survived noise", is_error: false });
    process.exit(0);
  }
  if (mode === "conf-hang") {
    out({ type: "system", session_id: "s" });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "conf-huge-output") {
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 4; i += 1) out({ type: "assistant", chunk: big });
    out({ type: "result", result: `huge:${big.length * 4}`, is_error: false });
    // stdout must be fully flushed before exit; process.exit() skips flush on piped stdout.
    process.stdout.write("", () => process.exit(0));
    return;
  }
  if (mode === "conf-auth-expire-midway") {
    out({ type: "system", session_id: "s" });
    process.stderr.write("token expired: 401 mid-stream\n");
    process.exit(1);
  }
  if (mode === "conf-grandchild") {
    const { spawn } = await import("node:child_process");
    const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    out({ type: "grandchild", pid: gc.pid });
    setInterval(() => {}, 1000);
    return;
  }

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
        CLAUDE_CC_ACTIVE: process.env.CLAUDE_CC_ACTIVE ?? null,
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
