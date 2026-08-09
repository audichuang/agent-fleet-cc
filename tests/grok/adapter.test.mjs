// tests/grok/adapter.test.mjs
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { validateProcessAdapter } from "../../plugins/grok/scripts/lib/shared/adapter-api.mjs";
import { promptFilePath } from "../../plugins/grok/scripts/lib/shared/core/state-store.mjs";
import { makeGrokAdapter, PROMPT_ARGV_LIMIT } from "../../plugins/grok/scripts/lib/adapter.mjs";

test("adapter satisfies the ProcessAdapter contract", () => {
  assert.deepEqual(validateProcessAdapter(makeGrokAdapter()), []);
});

test("buildInvocation composes the headless streaming-json invocation", () => {
  const a = makeGrokAdapter();
  const { argv, stdinPayload } = a.buildInvocation({
    job: { cwd: "/w", request: { model: "grok-4.5" } },
    prompt: "do the thing",
  });
  assert.equal(stdinPayload, null);
  assert.deepEqual(argv, [
    "grok", "-p", "do the thing",
    "--output-format", "streaming-json",
    "--always-approve", "--no-auto-update", "--no-alt-screen",
    "-m", "grok-4.5", "--cwd", "/w",
  ]);
});

test("buildInvocation: --sandbox read-only only on opt-in readOnly (default omits it)", () => {
  const a = makeGrokAdapter();
  const sandboxOf = (argv) => {
    const i = argv.indexOf("--sandbox");
    return i >= 0 ? argv[i + 1] : null;
  };
  // default (no readOnly) → NO sandbox flag (grok's `off` default: full access, incl. network)
  assert.equal(
    sandboxOf(a.buildInvocation({ job: { cwd: "/w", request: {} }, prompt: "p" }).argv),
    null,
  );
  // opt-in readOnly → --sandbox read-only
  assert.equal(
    sandboxOf(a.buildInvocation({ job: { cwd: "/w", request: { readOnly: true } }, prompt: "p" }).argv),
    "read-only",
  );
  // readOnly + resume → still emitted (fail-closed: grok exit(1)s on a conflicting saved
  // profile rather than silently granting writes; a matching read-only session is fine)
  assert.equal(
    sandboxOf(a.buildInvocation({ job: { cwd: "/w", request: { readOnly: true, resumeSessionId: "s1" } }, prompt: "p" }).argv),
    "read-only",
  );
});

test("buildInvocation adds effort and resume when present, honors binaryArgv", () => {
  const a = makeGrokAdapter();
  const { argv } = a.buildInvocation({
    job: { cwd: "/w", request: { model: "grok-4.5", effort: "high", resumeSessionId: "s9", binaryArgv: ["node", "/fake"] } },
    prompt: "p",
  });
  assert.deepEqual(argv.slice(0, 2), ["node", "/fake"]);
  assert.ok(argv.includes("--reasoning-effort") && argv[argv.indexOf("--reasoning-effort") + 1] === "high");
  assert.deepEqual(argv.slice(-2), ["-r", "s9"]);
});

test("buildInvocation adds --no-subagents only when requested", () => {
  const a = makeGrokAdapter();
  const on = a.buildInvocation({ job: { cwd: "/w", request: { noSubagents: true } }, prompt: "p" });
  assert.ok(on.argv.includes("--no-subagents"));
  const off = a.buildInvocation({ job: { cwd: "/w", request: {} }, prompt: "p" });
  assert.ok(!off.argv.includes("--no-subagents"));
});

test("buildInvocation: --research emits --tools x_search,web_search,web_fetch --deny MCPTool (opt-in only)", () => {
  const a = makeGrokAdapter();
  const off = a.buildInvocation({ job: { cwd: "/w", request: {} }, prompt: "p" });
  assert.ok(!off.argv.includes("--tools"));
  assert.ok(!off.argv.includes("--deny"));
  const on = a.buildInvocation({ job: { cwd: "/w", request: { research: true } }, prompt: "p" }).argv;
  assert.equal(on[on.indexOf("--tools") + 1], "x_search,web_search,web_fetch");
  assert.equal(on[on.indexOf("--deny") + 1], "MCPTool");
});

test("buildInvocation: --max-turns <n> only when a positive maxTurns is set", () => {
  const a = makeGrokAdapter();
  const off = a.buildInvocation({ job: { cwd: "/w", request: {} }, prompt: "p" });
  assert.ok(!off.argv.includes("--max-turns"));
  const on = a.buildInvocation({ job: { cwd: "/w", request: { maxTurns: 5 } }, prompt: "p" }).argv;
  assert.equal(on[on.indexOf("--max-turns") + 1], "5");
});

test("buildInvocation: --no-memory only when opted in", () => {
  const a = makeGrokAdapter();
  const off = a.buildInvocation({ job: { cwd: "/w", request: {} }, prompt: "p" });
  assert.ok(!off.argv.includes("--no-memory"));
  const on = a.buildInvocation({ job: { cwd: "/w", request: { noMemory: true } }, prompt: "p" });
  assert.ok(on.argv.includes("--no-memory"));
});

test("buildInvocation: --research / --max-turns / --no-memory compose freely with --read-only and resume (all orthogonal)", () => {
  const a = makeGrokAdapter();
  const { argv } = a.buildInvocation({
    job: {
      cwd: "/w",
      request: { readOnly: true, research: true, maxTurns: 3, noMemory: true, resumeSessionId: "s1" },
    },
    prompt: "p",
  });
  assert.ok(argv.includes("--sandbox"));
  assert.ok(argv.includes("--tools"));
  assert.ok(argv.includes("--max-turns"));
  assert.ok(argv.includes("--no-memory"));
  // resume args (session identity) still land last, unaffected by these behavior flags
  assert.deepEqual(argv.slice(-2), ["-r", "s1"]);
});

// The ceiling is MAX_ARG_STRLEN (one argv element), NOT ARG_MAX. Prove the cliff is
// real before asserting the adapter steers around it — a guard whose failure mode was
// never observed is a guard nobody can trust. Deliberately NOT pinned to 131072:
// MAX_ARG_STRLEN is PAGE_SIZE * 32, so the exact cliff is 128 KiB on a 4 KiB-page
// kernel but 2 MiB on a 64 KiB-page one. 4 MiB is over it on both; PROMPT_ARGV_LIMIT
// stays sized for the smaller page (conservative, never wrong).
test("oversized prompt: a single huge argv element really throws E2BIG (linux)", { skip: process.platform !== "linux" && "MAX_ARG_STRLEN is linux-specific" }, () => {
  const under = spawnSync(process.execPath, ["-e", "0", "x".repeat(PROMPT_ARGV_LIMIT)]);
  assert.equal(under.error, undefined, "a prompt at the adapter's limit must still spawn");
  const over = spawnSync(process.execPath, ["-e", "0", "x".repeat(4 * 1024 * 1024)]);
  assert.equal(over.error?.code, "E2BIG", "4 MiB in one argv element must fail on any page size");
});

test("oversized prompt: buildInvocation swaps -p for the prompt file the worker already wrote", () => {
  const a = makeGrokAdapter({ stateDir: "/state" });
  const job = { id: "grok-1", cwd: "/w", request: {} };

  const small = a.buildInvocation({ job, prompt: "hi" }).argv;
  assert.deepEqual(small.slice(0, 3), ["grok", "-p", "hi"]);

  const big = a.buildInvocation({ job, prompt: "x".repeat(PROMPT_ARGV_LIMIT + 1) }).argv;
  assert.deepEqual(big.slice(0, 3), ["grok", "--prompt-file", promptFilePath("/state", "grok-1")]);
  assert.ok(!big.includes("-p"), "--prompt-file conflicts_with -p; it is a swap, not an addition");
  // .txt matters: grok parses a .json prompt file as ACP content blocks instead.
  assert.ok(big[2].endsWith(".txt"));

  // No stateDir (nothing to point at) → unchanged inline behavior, never a bad path.
  const noState = makeGrokAdapter().buildInvocation({ job, prompt: "x".repeat(PROMPT_ARGV_LIMIT + 1) }).argv;
  assert.equal(noState[1], "-p");
});

test("json-schema mode: buildInvocation switches to --json-schema (not streaming-json)", () => {
  const a = makeGrokAdapter();
  const { argv } = a.buildInvocation({ job: { cwd: "/w", request: { jsonSchema: '{"type":"object"}' } }, prompt: "p" });
  assert.ok(argv.includes("--json-schema"));
  assert.equal(argv[argv.indexOf("--json-schema") + 1], '{"type":"object"}');
  assert.ok(!argv.includes("streaming-json"));
});

test("json-schema mode: parseEvent buffers the multi-line result object; extractResult returns its JSON", () => {
  const a = makeGrokAdapter();
  a.buildInvocation({ job: { cwd: "/w", request: { jsonSchema: "{}" } }, prompt: "p" }); // flips jsonMode
  const objLines = [
    "{",
    '  "text": "{\\"ok\\": true}",',
    '  "stopReason": "end_turn",',
    '  "sessionId": "s1",',
    '  "structuredOutput": {',
    '    "ok": true',
    "  }",
    "}",
  ];
  const events = objLines.map((l) => a.parseEvent(l)).filter(Boolean);
  assert.equal(events.length, 1); // only the closing line yields the event
  assert.equal(events[0].kind, "json");
  assert.equal(events[0].text, '{"ok": true}');
  assert.equal(events[0].sessionId, "s1");
  const res = a.extractResult(events, 0);
  assert.deepEqual(res, { ok: true, resultText: '{"ok": true}', sessionId: "s1", usage: null });
});

// grok exits 0 when a --json-schema run produced no structured output; it signals
// the failure ONLY via structuredOutputError. Without this the job is recorded
// completed and resultText is the un-schema'd prose.
test("json-schema mode: structuredOutputError fails the job but keeps sessionId and usage", () => {
  const a = makeGrokAdapter();
  a.buildInvocation({ job: { request: { jsonSchema: "{}" } }, prompt: "p" });
  const lines = [
    "{",
    '  "text": "Sure! Here is a summary in plain prose.",',
    '  "stopReason": "end_turn",',
    '  "sessionId": "s1",',
    '  "usage": { "input_tokens": 11, "output_tokens": 22 },',
    '  "structuredOutput": null,',
    '  "structuredOutputError": "model did not produce structured output"',
    "}",
  ];
  const events = lines.map((l) => a.parseEvent(l)).filter(Boolean);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "json", "must stay a json event — an error event drops sessionId/usage");
  assert.equal(events[0].structuredError, "model did not produce structured output");
  // exit 0 must NOT make this ok, and the prose must never surface as the result…
  const res = a.extractResult(events, 0);
  assert.equal(res.ok, false);
  assert.equal(res.resultText, null);
  // …but the job must stay resumable and its cost recorded.
  assert.equal(res.sessionId, "s1");
  assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 22 });
});

test("json-schema mode: a {type:error} object fails the job", () => {
  const a = makeGrokAdapter();
  a.buildInvocation({ job: { request: { jsonSchema: "{}" } }, prompt: "p" });
  const ev = a.parseEvent('{"type":"error","message":"unknown model id"}');
  assert.deepEqual(ev, { kind: "error", message: "unknown model id" });
  assert.equal(a.extractResult([ev], 1).ok, false);
});

test("parseEvent maps grok events and tolerates junk", () => {
  const a = makeGrokAdapter();
  assert.equal(a.parseEvent("not json"), null);
  assert.equal(a.parseEvent('{"type":"thought","data":"hmm"}'), null);
  assert.deepEqual(a.parseEvent('{"type":"text","data":"pong"}'), { kind: "text", text: "pong" });
  assert.deepEqual(
    a.parseEvent('{"type":"end","stopReason":"end_turn","sessionId":"abc","requestId":"r"}'),
    { kind: "end", sessionId: "abc", stopReason: "end_turn", usage: null },
  );
  // grok emits {type:error,message} on stdout for bad model / bad effort / no-auth
  assert.deepEqual(a.parseEvent('{"type":"error","message":"unknown model id"}'), { kind: "error", message: "unknown model id" });
  assert.equal(a.parseEvent("{broken"), null);
});

test("extractResult joins text deltas; ok = exit 0 + terminal end (not a specific stopReason)", () => {
  const a = makeGrokAdapter();
  const events = [
    { kind: "text", text: "po" },
    { kind: "text", text: "ng" },
    { kind: "end", sessionId: "abc", stopReason: "end_turn" },
  ];
  assert.deepEqual(a.extractResult(events, 0), { ok: true, resultText: "pong", sessionId: "abc", usage: null });
  // exit 0 + end present with a NON-end_turn stopReason (e.g. max_tokens) → still ok:
  // the answer is usable; the old end_turn-only gate wrongly failed these.
  assert.equal(
    a.extractResult([{ kind: "text", text: "partial" }, { kind: "end", sessionId: "x", stopReason: "max_tokens" }], 0).ok,
    true,
  );
  // non-zero exit → not ok even with a clean end
  assert.equal(a.extractResult(events, 1).ok, false);
  // no terminal end event → not ok (engine died mid-stream even if exit 0)
  assert.equal(a.extractResult([{ kind: "text", text: "hi" }], 0).ok, false);
  // a stdout error event → not ok even on exit 0 + end
  assert.equal(
    a.extractResult([{ kind: "error", message: "boom" }, { kind: "end", sessionId: "x", stopReason: "end_turn" }], 0).ok,
    false,
  );
  // no text at all → null resultText
  assert.equal(a.extractResult([{ kind: "end", sessionId: "x", stopReason: "end_turn" }], 0).resultText, null);
});

test("usage: captured from the end event (streaming) and the json result", () => {
  const a = makeGrokAdapter();
  // streaming-json: grok now stamps usage on `end` (snake_case) → normalized shape
  const end = a.parseEvent(
    '{"type":"end","stopReason":"end_turn","sessionId":"abc","usage":{"input_tokens":7210,"output_tokens":1893,"total_tokens":50103}}',
  );
  assert.deepEqual(end.usage, { inputTokens: 7210, outputTokens: 1893 });
  assert.deepEqual(
    a.extractResult([{ kind: "text", text: "hi" }, end], 0).usage,
    { inputTokens: 7210, outputTokens: 1893 },
  );
  // json-schema mode: usage rides on the single result object too
  const b = makeGrokAdapter();
  b.buildInvocation({ job: { request: { jsonSchema: "{}" } }, prompt: "p" });
  const jsonEvents = ['{"text":"{}","sessionId":"s1","usage":{"input_tokens":10,"output_tokens":2},"structuredOutput":{}}']
    .map((l) => b.parseEvent(l))
    .filter(Boolean);
  assert.deepEqual(b.extractResult(jsonEvents, 0).usage, { inputTokens: 10, outputTokens: 2 });
});

test("extractResult fences the final report on the sentinels (fan-out cleanup)", () => {
  const a = makeGrokAdapter();
  const end = { kind: "end", sessionId: "s", stopReason: "end_turn" };
  // subagent chatter leaks before the fence (real grok multi-agent behavior);
  // only the fenced report survives, trimmed.
  const leaked = [
    { kind: "text", text: "Spawning subagents.Paris4" },
    { kind: "text", text: "<<<GROK_FINAL>>>\nCapital=Paris Sum=4\n<<<GROK_END>>>" },
    end,
  ];
  assert.equal(a.extractResult(leaked, 0).resultText, "Capital=Paris Sum=4");
  // no sentinels → unchanged full text (single-agent / caller didn't opt in)
  assert.equal(
    a.extractResult([{ kind: "text", text: "plain answer" }, end], 0).resultText,
    "plain answer",
  );
  // first-open → last-close: spans the whole fenced region even when the report
  // body quotes the sentinel tokens (as an audit report about grok would), while
  // still dropping the pre-fence leak.
  assert.equal(
    a.extractResult([{ kind: "text", text: "leak <<<GROK_FINAL>>>report mentions <<<GROK_END>>> and <<<GROK_FINAL>>> inline<<<GROK_END>>>" }, end], 0).resultText,
    "report mentions <<<GROK_END>>> and <<<GROK_FINAL>>> inline",
  );
});

test("classifyError maps auth / quota / config / endpoint / not-installed / unknown", () => {
  const a = makeGrokAdapter();
  assert.equal(a.classifyError("xai: 401 unauthorized", 1), "auth");
  assert.equal(a.classifyError("not logged in — run grok login", 1), "auth");
  // real 0.2.93 failure strings (verified by running)
  assert.equal(a.classifyError("Waiting for authorization...", 124), "auth");
  assert.equal(a.classifyError("No cached credentials found. Run `grok login` first.", 1), "auth");
  assert.equal(a.classifyError("You've reached your free Grok Build usage limit", 1), "quota");
  assert.equal(a.classifyError("429 Too Many Requests", 1), "quota");
  assert.equal(a.classifyError('Couldn\'t set model: Invalid params: "unknown model id"', 1), "config");
  assert.equal(a.classifyError("unknown effort level 'superduper'", 1), "config");
  assert.equal(a.classifyError("fetch failed ECONNREFUSED", 1), "endpoint");
  assert.equal(a.classifyError("command not found", 127), "not-installed");
  assert.equal(a.classifyError("boom", 1), "unknown");
});

// grok 1.0.0's read-only sandbox fails CLOSED (exit 1, not 127, and the OS text is
// "No such file or directory", never the token ENOENT) — without a dedicated regex
// these actionable failures fall through to "unknown".
test("classifyError buckets grok 1.0.0 sandbox refusals as config, not unknown", () => {
  const a = makeGrokAdapter();
  assert.equal(
    a.classifyError(
      "error: this sandbox could not enforce its deny list on Linux: bwrap exec failed: "
      + "No such file or directory (os error 2). Install bubblewrap with `apt install -y bubblewrap`. "
      + "Refusing to start with denied paths unprotected.",
      1,
    ),
    "config",
  );
  assert.equal(a.classifyError("error: hook write-deny is required but no plan was prepared", 1), "config");
  assert.equal(
    a.classifyError("error: could not apply the 'read-only' sandbox profile; Refusing to start with its protections missing.", 1),
    "config",
  );
  assert.equal(a.classifyError("error: sandbox profile resolve failed: bad toml", 1), "config");
  assert.equal(a.classifyError("error: sandbox deny glob could not be enforced on Linux: too many entries", 1), "config");
  // …and must NOT steal a failure that merely contains one of those words. The check
  // runs LAST for exactly this reason: every earlier bucket is a more specific claim.
  assert.equal(a.classifyError("spawn /opt/sandbox/grok ENOENT", 1), "not-installed");
  assert.equal(a.classifyError("spawn /opt/bwrap/grok ENOENT", 1), "not-installed");
  assert.equal(a.classifyError("fetch failed ECONNREFUSED bubblewrap-relay.internal", 1), "endpoint");
  // …but the real refusal must still win, even when its text embeds a user path that
  // looks like another bucket. grok stamps the configured hooks-path verbatim into
  // HookWriteDenyError::MissingConfigured, so a path named /tmp/quota or /srv/relay
  // would be stolen by the quota/endpoint regexes without the "Refusing to start" tier.
  assert.equal(
    a.classifyError(
      "error: this sandbox could not enforce its deny list on Linux: hook write-deny plan failed: "
      + "configured absolute hooks-paths target(s) do not exist: /tmp/quota. "
      + "Refusing to start with denied paths unprotected.",
      1,
    ),
    "config",
  );
  assert.equal(
    a.classifyError(
      "error: this sandbox could not enforce its deny list on Linux: hook write-deny plan failed: "
      + "configured absolute hooks-paths target(s) do not exist: /srv/relay. "
      + "Refusing to start with denied paths unprotected.",
      1,
    ),
    "config",
  );
});

test("resumeArgs yields -r <id>", () => {
  assert.deepEqual(makeGrokAdapter().resumeArgs("s1"), ["-r", "s1"]);
});

test("buildInvocation: -s <sessionId> for a new conversation (request.sessionId, no resume)", () => {
  const a = makeGrokAdapter();
  const uuid = "6f9d3c2a-1b4e-4a7f-9c2d-8e5f6a1b2c3d";
  const { argv } = a.buildInvocation({
    job: { cwd: "/w", request: { model: "grok-4.5", sessionId: uuid } },
    prompt: "p",
  });
  assert.deepEqual(argv.slice(-2), ["-s", uuid]);
});

test("buildInvocation: resumeSessionId wins — never sends -s alongside -r (cli.rs:582: --session-id is new-conversation-only, invalid with --resume without --fork-session)", () => {
  const a = makeGrokAdapter();
  const { argv } = a.buildInvocation({
    job: { cwd: "/w", request: { resumeSessionId: "prior-session", sessionId: "should-never-be-sent" } },
    prompt: "p",
  });
  assert.deepEqual(argv.slice(-2), ["-r", "prior-session"]);
  assert.ok(!argv.includes("-s"));
  assert.ok(!argv.includes("should-never-be-sent"));
});

test("buildInvocation: no sessionId and no resumeSessionId sends neither flag", () => {
  const a = makeGrokAdapter();
  const { argv } = a.buildInvocation({ job: { cwd: "/w", request: {} }, prompt: "p" });
  assert.ok(!argv.includes("-s"));
  assert.ok(!argv.includes("-r"));
});
