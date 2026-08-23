#!/usr/bin/env node
// Scriptable stand-in for the grok CLI (streaming-json contract).
// FAKE_GROK_MODE:
//   success (default) | fail | hang
//   conf-ok | conf-resume | conf-midway-drop | conf-noise | conf-hang |
//   conf-instant-exit | conf-huge-output | conf-auth-expire-midway | conf-grandchild |
//   not-signed-in
// The prompt arrives as the `-p` value (grok does not read stdin).
import fs from "node:fs";

const mode = process.env.FAKE_GROK_MODE ?? "success";
if (process.env.FAKE_GROK_PIDFILE) {
  fs.writeFileSync(process.env.FAKE_GROK_PIDFILE, String(process.pid));
}

// Real grok takes the prompt from `-p` OR `--prompt-file <path>` (mutually
// exclusive: conflicts_with_all). The adapter swaps to the file form once the
// prompt would blow MAX_ARG_STRLEN, so the fake must honour both or an oversized
// job "passes" while the prompt silently never arrived.
const pIdx = process.argv.indexOf("-p");
const fIdx = process.argv.indexOf("--prompt-file");
const promptArg = pIdx >= 0
  ? (process.argv[pIdx + 1] ?? "")
  : fIdx >= 0
    ? fs.readFileSync(process.argv[fIdx + 1], "utf8")
    : "";
// Only on the file path, and only for tests: report the exact byte count received.
// The echo below is truncated to 60 chars, so a prompt that arrived TRUNCATED would
// otherwise pass — this makes "all the bytes got there" assertable.
const promptBytesNote = fIdx >= 0 ? `|bytes:${Buffer.byteLength(promptArg)}` : "";
const hasResume = process.argv.includes("-r");

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
// stopReason is snake_case on the wire (headless.rs stop_reason_wire); the full
// token set is end_turn | max_tokens | max_turn_requests | refusal | cancelled.
// It was CamelCase before grok 1.0.0 — keep this in sync with the real engine
// even though extractResult deliberately never compares it, because this fake is
// the repo's only written record of grok's stdout.
function end() {
  out({ type: "end", stopReason: "end_turn", sessionId: "fake-session-1", requestId: "req-1" });
}

// --json-schema implies non-streaming --output-format json: emit ONE result
// object (not a token stream), matching real grok 1.0.0 shape.
if (process.argv.includes("--json-schema")) {
  // schema-no-structured: the model answered in prose. Real grok still EXITS 0 and
  // says so only via structuredOutput:null + structuredOutputError.
  const noStructured = mode === "schema-no-structured";
  process.stdout.write(
    JSON.stringify(
      noStructured
        ? {
            text: "Sure! Here is a summary in plain prose.",
            stopReason: "end_turn",
            sessionId: "fake-session-json",
            requestId: "req-json",
            usage: { input_tokens: 11, output_tokens: 22 },
            structuredOutput: null,
            structuredOutputError: "model did not produce structured output",
          }
        : {
            text: '{"ok": true}',
            stopReason: "end_turn",
            sessionId: "fake-session-json",
            requestId: "req-json",
            structuredOutput: { ok: true },
          },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
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
    // Real 1.0.0 line types the adapter does not read but MUST tolerate.
    out({ type: "tool_call", toolCallId: "call_1", title: "Read", kind: "read",
          status: "in_progress", toolName: "read_file", rawInput: { path: "src/main.rs" },
          content: [], locations: [] });
    out({ type: "tool_call_update", toolCallId: "call_1", status: "completed",
          content: [], rawOutput: { lines: 42 }, locations: [] });
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
    // NOT a real grok line type — a test-only transport for the grandchild pid.
    // Doubles as an unknown-type tolerance check (parseEvent must return null).
    out({ type: "tool", pid: gc.pid });
    setInterval(() => {}, 1000);
    break;
  }
  // grok 1.0.5's headless fail-closed path, verbatim: no auth resolves, so
  // authenticate() bails BEFORE any turn starts and nothing is streamed
  // (xai-grok-pager/src/headless.rs:459-480; text = auth_required_message(false),
  // :445-457 — the non-interactive branch, which is what a piped-stdin spawn gets).
  case "not-signed-in":
    process.stderr.write(
      "Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\n" +
        "Alternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.\n",
    );
    process.exit(1);
  case "fail":
    process.stderr.write("xai: 401 unauthorized\n");
    process.exit(1);
  case "success":
  default:
    out({ type: "thought", data: "considering the request" });
    out({ type: "text", data: `echo:${promptArg.trim().slice(0, 60)}${promptBytesNote}` });
    end();
    process.exit(0);
}
