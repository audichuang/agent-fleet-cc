// Unit tests for the antigravity ProcessAdapter (spec §2/§5, D-1/D-2/D-3/D-5).
// Pure adapter surface - no shared runtime, no real agy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  makeAntigravityAdapter,
  workspaceStateDir,
  resolveDataRoot,
  resolveAgyBin,
  resolveAgyTimeouts,
  RECURSION_MARKER,
  DEFAULT_PRINT_TIMEOUT_MS,
} from "../../plugins/antigravity/scripts/lib/adapter.mjs";
import { validateProcessAdapter } from "../../shared/lib/adapter-api.mjs";

// events as runWorker delivers them to extractResult: parseEvent output flattened.
const lineEvents = (...texts) => texts.map((text) => ({ kind: "line", text, raw: text, type: "engine-event" }));

test("validateProcessAdapter === [] (structural contract)", () => {
  assert.deepEqual(validateProcessAdapter(makeAntigravityAdapter()), []);
});

test("RECURSION_MARKER is ANTIGRAVITY_ACTIVE (D-15)", () => {
  assert.equal(RECURSION_MARKER, "ANTIGRAVITY_ACTIVE");
  assert.equal(makeAntigravityAdapter().recursionMarker, "ANTIGRAVITY_ACTIVE");
});

test("resolveAgyBin: AGY_BIN wins, Windows env.Path fallback, bare default (coverage restored from deleted deep test)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agybin-"));
  const binFile = path.join(dir, "agy");
  fs.writeFileSync(binFile, "#!/bin/sh\n");
  try {
    // explicit AGY_BIN wins when it exists on disk
    assert.equal(resolveAgyBin({ AGY_BIN: binFile, PATH: "" }), binFile);
    // Windows-style env.Path is used when PATH is absent (adapter.mjs:47 branch)
    assert.equal(resolveAgyBin({ Path: dir }), binFile);
    // POSIX PATH still works
    assert.equal(resolveAgyBin({ PATH: dir }), binFile);
    // nothing resolvable → bare "agy" default
    assert.equal(resolveAgyBin({ PATH: "", Path: "" }), "agy");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildInvocation: --print is LAST with prompt as its value, stdinPayload empty (D-1)", () => {
  const a = makeAntigravityAdapter({ env: { AGY_BIN: "", PATH: "" } });
  const { argv, stdinPayload, env } = a.buildInvocation({ job: { request: { mode: "print" } }, prompt: "hello world" });
  assert.equal(stdinPayload, "");
  assert.deepEqual(env, {});
  assert.equal(argv[argv.length - 2], "--print");
  assert.equal(argv[argv.length - 1], "hello world");
  // print-timeout precedes --print
  assert.ok(argv.includes("--print-timeout"));
});

test("buildInvocation: continue / conversation / model / sandbox / add-dir wiring", () => {
  const a = makeAntigravityAdapter({ env: {} });
  const cont = a.buildInvocation({ job: { request: { mode: "continue" } }, prompt: "x" });
  assert.ok(cont.argv.includes("--continue"));

  const conv = a.buildInvocation({ job: { request: { mode: "conversation", conversationId: "c-42" } }, prompt: "x" });
  const ci = conv.argv.indexOf("--conversation");
  assert.equal(conv.argv[ci + 1], "c-42");

  assert.throws(
    () => a.buildInvocation({ job: { request: { mode: "conversation" } }, prompt: "x" }),
    /requires conversationId/,
  );

  const full = a.buildInvocation({
    job: { request: { model: "gemini", sandbox: true, addDirs: ["/a", "/b"] } },
    prompt: "x",
  });
  assert.equal(full.argv[full.argv.indexOf("--model") + 1], "gemini");
  assert.ok(full.argv.includes("--sandbox"));
  const dirs = full.argv.reduce((acc, v, idx) => (v === "--add-dir" ? [...acc, full.argv[idx + 1]] : acc), []);
  assert.deepEqual(dirs, ["/a", "/b"]);
});

test("buildInvocation: binaryArgv replaces the bin head", () => {
  const a = makeAntigravityAdapter({ env: {} });
  const { argv } = a.buildInvocation({ job: { request: { binaryArgv: ["node", "/x/fake.mjs"] } }, prompt: "p" });
  assert.equal(argv[0], "node");
  assert.equal(argv[1], "/x/fake.mjs");
});

test("parseEvent: content / blank / non-string all -> {kind:line,text}, never throws", () => {
  const a = makeAntigravityAdapter();
  assert.deepEqual(a.parseEvent("hello"), { kind: "line", text: "hello" });
  assert.deepEqual(a.parseEvent(""), { kind: "line", text: "" });
  assert.deepEqual(a.parseEvent("   "), { kind: "line", text: "   " });
  assert.deepEqual(a.parseEvent(undefined), { kind: "line", text: "" });
  assert.deepEqual(a.parseEvent(null), { kind: "line", text: "" });
  assert.deepEqual(a.parseEvent(123), { kind: "line", text: "123" });
});

test("extractResult: join with \\n, edge-trim only, ok tracks exit code, sessionId null", () => {
  const a = makeAntigravityAdapter();
  const r = a.extractResult(lineEvents("", "line one", "line two", ""), 0);
  assert.equal(r.resultText, "line one\nline two");
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, null);
  assert.equal(r.usage, null);

  const bad = a.extractResult(lineEvents("something"), 1);
  assert.equal(bad.ok, false);
});

test("extractResult: inner blank lines PRESERVED (D-1 lossless), only edges trimmed", () => {
  const a = makeAntigravityAdapter();
  const r = a.extractResult(lineEvents("OK", "", "body paragraph one.", "", "body paragraph two."), 0);
  assert.equal(r.resultText, "OK\n\nbody paragraph one.\n\nbody paragraph two.");
});

test("extractResult: empty stdout on exit 0 -> resultText null (D-10)", () => {
  const a = makeAntigravityAdapter();
  const r = a.extractResult([], 0);
  assert.equal(r.resultText, null);
  assert.equal(r.ok, true);
});

test("extractResult: auth sentinel in stdout -> ok:false even on exit 0 (D-3)", () => {
  const a = makeAntigravityAdapter();
  const r = a.extractResult(
    lineEvents("Authentication required. Please visit the URL to log in", "https://accounts.google.com/o/oauth2/auth?x=1"),
    0,
  );
  assert.equal(r.ok, false);
});

test("classifyError: auth / endpoint / not-installed / unknown (D-3)", () => {
  const a = makeAntigravityAdapter();
  assert.equal(a.classifyError("Authentication required", 1), "auth");
  assert.equal(a.classifyError("unauthorized 401", 1), "auth");
  assert.equal(a.classifyError("fetch failed ECONNREFUSED", 1), "endpoint");
  assert.equal(a.classifyError("", 127), "not-installed");
  assert.equal(a.classifyError("command not found", 1), "not-installed");
  assert.equal(a.classifyError("some random error", 1), "unknown");
});

test("workspaceStateDir: reproduces <slug>-<12hex sha256(root)> keying (D-5)", () => {
  const root = "/home/audichuang/research/agent-fleet-cc";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const dataRoot = resolveDataRoot({});
  const dir = workspaceStateDir(dataRoot, root);
  assert.equal(path.basename(dir), `agent-fleet-cc-${hash}`);
  assert.equal(hash.length, 12);
});

test("resolveDataRoot: CLAUDE_PLUGIN_DATA/state vs os.tmpdir()/antigravity fallback (D-5)", () => {
  assert.equal(resolveDataRoot({ CLAUDE_PLUGIN_DATA: "/data" }), path.join("/data", "state"));
  assert.equal(resolveDataRoot({}), path.join(os.tmpdir(), "antigravity"));
});

test("resolveAgyTimeouts: hardMs never below printMs (D-19)", () => {
  const def = resolveAgyTimeouts({});
  assert.equal(def.printMs, DEFAULT_PRINT_TIMEOUT_MS);
  assert.ok(def.hardMs >= def.printMs);
  // job timeout smaller than print timeout is clamped up
  const clamped = resolveAgyTimeouts({ AGY_PRINT_TIMEOUT_MS: "10000", AGY_JOB_TIMEOUT_MS: "5000" });
  assert.equal(clamped.printMs, 10000);
  assert.ok(clamped.hardMs >= 10000);
});
