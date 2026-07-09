#!/usr/bin/env node
// Scriptable stand-in for the grok CLI (streaming-json contract).
// FAKE_GROK_MODE:
//   success (default) | fail | hang
//   conf-ok | conf-resume | conf-midway-drop | conf-noise | conf-hang |
//   conf-instant-exit | conf-huge-output | conf-auth-expire-midway | conf-grandchild
// The prompt arrives as the `-p` value (grok does not read stdin).
import fs from "node:fs";

const mode = process.env.FAKE_GROK_MODE ?? "success";
if (process.env.FAKE_GROK_PIDFILE) {
  fs.writeFileSync(process.env.FAKE_GROK_PIDFILE, String(process.pid));
}

const pIdx = process.argv.indexOf("-p");
const promptArg = pIdx >= 0 ? (process.argv[pIdx + 1] ?? "") : "";
const hasResume = process.argv.includes("-r");

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function end() {
  out({ type: "end", stopReason: "EndTurn", sessionId: "fake-session-1", requestId: "req-1" });
}

// Must exit before emitting anything (conformance scenario 5 asserts exit 7).
if (mode === "conf-instant-exit") process.exit(7);

switch (mode) {
  case "conf-ok":
    out({ type: "text", data: `echo:${promptArg.trim().slice(0, 40)}` });
    end();
    process.exit(0);
  case "conf-resume":
    out({ type: "text", data: hasResume ? "resumed" : "fresh" });
    end();
    process.exit(0);
  case "conf-midway-drop":
    out({ type: "thought", data: "partial" });
    process.exit(1); // no end event → the JOB fails, the runner does not
  case "conf-noise":
    process.stdout.write("plain noise\n{broken json\n");
    out({ type: "text", data: "survived noise" });
    end();
    process.exit(0);
  case "conf-hang":
  case "hang":
    out({ type: "thought", data: "thinking" });
    setInterval(() => {}, 1000);
    break;
  case "conf-huge-output": {
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 4; i += 1) out({ type: "thought", data: big });
    out({ type: "text", data: `huge:${big.length * 4}` });
    end();
    process.stdout.write("", () => process.exit(0)); // flush before exit
    break;
  }
  case "conf-auth-expire-midway":
    out({ type: "thought", data: "..." });
    process.stderr.write("xai auth: 401 unauthorized mid-stream\n");
    process.exit(1);
  case "conf-grandchild": {
    const { spawn } = await import("node:child_process");
    const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    out({ type: "tool", pid: gc.pid });
    setInterval(() => {}, 1000);
    break;
  }
  case "fail":
    process.stderr.write("xai: 401 unauthorized\n");
    process.exit(1);
  case "success":
  default:
    out({ type: "thought", data: "considering the request" });
    out({ type: "text", data: `echo:${promptArg.trim().slice(0, 60)}` });
    end();
    process.exit(0);
}
