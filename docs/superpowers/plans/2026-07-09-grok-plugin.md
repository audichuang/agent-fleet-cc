# Grok Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth marketplace plugin, `grok`, that drives xAI's Grok Build CLI as a headless one-shot engine through the shared runtime — same lifecycle (`task`/`status`/`wait`/`logs`/`result`/`cancel`) as `cc` and `antigravity`.

**Architecture:** Implement the shared `ProcessAdapter` contract (one adapter module) and run each job via the vendored shared `runWorker`, exactly like `cc`. No persistent broker (Grok's headless mode is one-shot; resume uses Grok's own `--session-id`/`-r`). Auth is delegated to the Grok CLI; the plugin stores no secrets and needs no `profiles.mjs`. Grok emits its own streaming-json events (`thought`/`text`/`end`) — the adapter normalizes them.

**Tech Stack:** Zero-dependency pure ESM `.mjs`; Node ≥ 22.3; `node:test` + `node:assert/strict`; the vendored `shared/lib/` runtime.

## Global Constraints

- Zero runtime dependencies. Pure ESM `.mjs`. Node ≥ 22.3.
- Tests use only `node:test` + `node:assert/strict`, hermetic: fake `grok` binary, redirected data dir, no network, no API key.
- Engine invocation (verified against real `grok` 0.2.93): `grok -p "<prompt>" --output-format streaming-json --always-approve --no-auto-update --no-alt-screen --cwd <cwd> -m <model> [--reasoning-effort <e>] [-r <sessionId>]`. Prompt is passed **inline as the `-p` value** (Grok's `-p` does not read stdin); `--prompt-file <path>` is the documented upgrade path if the ~2MB ARG_MAX ceiling ever bites.
- Grok streaming-json event shapes (verified): `{"type":"thought","data":...}` (reasoning — dropped), `{"type":"text","data":...}` (assistant text — accumulated), `{"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}` (terminal).
- Success = process exit 0 **and** `end.stopReason === "EndTurn"`. Any other outcome is a failure. No token/usage counts are emitted → `usage: null`.
- Default model `grok-4.5` (`grok-composer-2.5-fast` also valid); reasoning effort `high`/`medium`/`low`.
- Auth delegated to Grok CLI: `XAI_API_KEY` env or a cached token in `~/.grok/auth.json`. Never persist secrets into job records or logs.
- Binary is the literal `grok` on PATH, overridable via `GROK_BIN`. Data-root override `GROK_PLUGIN_DATA` (fallback `CLAUDE_PLUGIN_DATA`, then `~/.claude/plugins/data/grok`). Recursion marker env: `GROK_FLEET_ACTIVE`.
- **IRONCLAD:** do not modify any sibling plugin (`plugins/{codex,antigravity,cc}/`) or their tests (`tests/{codex,antigravity,cc}/`). The existing files this plan edits are: `.claude-plugin/marketplace.json`, `tests/fleet-structure.test.mjs`, `package.json`, `README.md`, `scripts/sync-shared.mjs`, and `AGENTS.md`. **Governance decision (approved by the repo owner, confirmed against the Codex review gate):** `scripts/sync-shared.mjs` must learn about `grok` because CI runs `npm run sync-shared && git diff --exit-code` (`.github/workflows/ci.yml:29-30`) — without it the vendored `plugins/grok/scripts/lib/shared/` is never drift-checked. It is shared infra that touches no sibling plugin (same category as `marketplace.json`), so Task 1 **widens the AGENTS.md "adding a sibling plugin" whitelist to include `scripts/sync-shared.mjs`**.
- Version lockstep: `plugins/grok/.claude-plugin/plugin.json` `version` must equal the `grok` entry `version` in `marketplace.json` (enforced by `tests/fleet-structure.test.mjs`; managed by `npm run bump-version grok ...`). Ship at `0.1.0`.

---

### Task 1: Plugin scaffold + marketplace registration + vendored shared runtime

**Files:**
- Create: `plugins/grok/.claude-plugin/plugin.json`
- Create: `tests/grok/helpers.mjs` (the hermetic test base every grok test imports — created here so Task 2's adapter test can import it)
- Modify: `.claude-plugin/marketplace.json` (add the `grok` entry)
- Modify: `tests/fleet-structure.test.mjs:29-30` (add `"grok"` to the expected plugin-name list)
- Modify: `package.json` (add `test:grok` script; insert it into the `test` chain)
- Modify: `scripts/sync-shared.mjs:12` (add `"grok"` to `TARGETS`)
- Modify: `AGENTS.md` (widen the "adding a sibling plugin" whitelist to include `scripts/sync-shared.mjs` — the approved governance decision)
- Test: `tests/fleet-structure.test.mjs` (existing file, extended)

**Interfaces:**
- Consumes: nothing.
- Produces: `plugins/grok/scripts/lib/shared/` — the vendored copy of `shared/lib/` that every later task imports as `./lib/shared/...` (from `scripts/`) or `../../plugins/grok/scripts/lib/shared/...` (from tests). `tests/grok/helpers.mjs` exporting `makeTempDir(prefix)` / `makeDataRoot()`. Plugin registered as `grok` at version `0.1.0`.

- [ ] **Step 1: Update the marketplace consistency test to expect `grok` (write the failing expectation first)**

In `tests/fleet-structure.test.mjs`, change the second test's assertion:

```javascript
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name).sort(),
    ["antigravity", "cc", "codex", "fleet", "grok"],
  );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/fleet-structure.test.mjs`
Expected: FAIL — the sorted list is missing `grok`, and the first test will also fail once the entry is added but the source dir/manifest are absent.

- [ ] **Step 3: Create the plugin manifest**

Create `plugins/grok/.claude-plugin/plugin.json`:

```json
{
  "name": "grok",
  "version": "0.1.0",
  "description": "Run tasks on a headless xAI Grok Build instance (grok-4.5) — launch, wait, tail, cancel, resume"
}
```

- [ ] **Step 4: Register the plugin in the marketplace**

In `.claude-plugin/marketplace.json`, append to the `plugins` array (after the `cc` entry, before `fleet` is fine — order is not asserted):

```json
    {
      "name": "grok",
      "source": "./plugins/grok",
      "description": "Use xAI Grok Build (grok) from Claude Code to delegate headless coding tasks — launch, wait, tail, cancel, resume.",
      "version": "0.1.0",
      "author": {
        "name": "xAI"
      }
    }
```

- [ ] **Step 5: Widen the whitelist, then add `grok` to the shared-runtime vendor targets**

First, in `AGENTS.md`, update the IRONCLAD section's "adding a sibling plugin" sentence to include `scripts/sync-shared.mjs` in the editable list. Change:

> When **adding** a sibling plugin, the only existing files you may edit are:
> `.claude-plugin/marketplace.json`, `tests/fleet-structure.test.mjs` (the marketplace
> consistency test), `package.json` (add a `test:<plugin>` script), and `README.md`.

to add `scripts/sync-shared.mjs` (the vendored-runtime target list — CI drift-checks it) to that list.

Then, in `scripts/sync-shared.mjs`, extend `TARGETS`:

```javascript
// cc + codex + antigravity + grok migrated onto shared/lib.
const TARGETS = ["cc", "codex", "antigravity", "grok"].map((p) =>
  path.join(root, "plugins", p, "scripts", "lib", "shared"),
);
```

- [ ] **Step 6: Vendor the shared runtime into the new plugin**

Run: `npm run sync-shared`
Expected: prints `synced shared/lib -> plugins/grok/scripts/lib/shared` (among the others). This creates `plugins/grok/scripts/lib/shared/` with `VENDORED.md`.

- [ ] **Step 7: Create the hermetic test base**

Create `tests/grok/helpers.mjs` (imported first by every grok test — redirects HOME/data to temp dirs and strips ambient `GROK_*` / `XAI_*` **and `FAKE_GROK_*`** so a stray `FAKE_GROK_MODE` in the dev environment can never perturb a test):

```javascript
// Hermetic test base: import this FIRST in every grok test file.
// Redirects HOME/data dirs to throwaway temp dirs and strips ambient
// GROK_*/XAI_*/FAKE_GROK_* so the suite never reads ~/.grok, never inherits real
// auth, and is never perturbed by a stray fake-engine mode in the environment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GROK_") || key.startsWith("XAI_") || key.startsWith("FAKE_GROK_")) {
    delete process.env[key];
  }
}
process.env.GROK_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "grok-test-data-"));

export function makeTempDir(prefix = "grok-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDataRoot() {
  return makeTempDir("grok-data-");
}
```

- [ ] **Step 8: Add the `test:grok` script and wire it into the chain**

In `package.json` `scripts`, add:

```json
    "test:grok": "node --test tests/grok/*.test.mjs",
```

and insert `&& npm run test:grok` into the `test` script immediately after `npm run test:codex`:

```json
    "test": "npm run test:structure && npm run test:shared && npm run test:cc && npm run test:antigravity && npm run test:codex && npm run test:grok && npm run test:fleet && npm run test:e2e",
```

- [ ] **Step 9: Run the structure test to verify it passes**

Run: `node --test tests/fleet-structure.test.mjs`
Expected: PASS (both tests green — the `grok` entry, its manifest, and its source dir now exist and versions match).

- [ ] **Step 10: Commit**

```bash
git add plugins/grok/.claude-plugin/plugin.json tests/grok/helpers.mjs .claude-plugin/marketplace.json tests/fleet-structure.test.mjs package.json scripts/sync-shared.mjs AGENTS.md plugins/grok/scripts/lib/shared
git commit -m "feat(grok): scaffold plugin — manifest, marketplace entry, vendored shared runtime, whitelist"
```

---

### Task 2: The ProcessAdapter (pure engine knowledge)

**Files:**
- Create: `plugins/grok/scripts/lib/adapter.mjs`
- Test: `tests/grok/adapter.test.mjs`

**Interfaces:**
- Consumes: `validateProcessAdapter` from `plugins/grok/scripts/lib/shared/adapter-api.mjs`.
- Produces:
  - `RECURSION_MARKER = "GROK_FLEET_ACTIVE"` (string)
  - `resolveDataRoot(env) -> string`
  - `workspaceStateDir(dataRoot, cwd) -> string`
  - `makeGrokAdapter() -> ProcessAdapter` with members: `name:"grok"`, `engine:"grok"`, `recursionMarker`, `wantsWatchdog:false`, `buildInvocation({job,prompt}) -> {argv, env, stdinPayload}`, `parseEvent(line) -> {kind:"text",text}|{kind:"end",sessionId,stopReason}|null`, `extractResult(events, exitCode) -> {ok, resultText, sessionId, usage}`, `classifyError(stderrTail, exitCode) -> string`, `resumeArgs(sessionId) -> string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/grok/adapter.test.mjs`:

```javascript
// tests/grok/adapter.test.mjs
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProcessAdapter } from "../../plugins/grok/scripts/lib/shared/adapter-api.mjs";
import { makeGrokAdapter } from "../../plugins/grok/scripts/lib/adapter.mjs";

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

test("parseEvent maps grok events and tolerates junk", () => {
  const a = makeGrokAdapter();
  assert.equal(a.parseEvent("not json"), null);
  assert.equal(a.parseEvent('{"type":"thought","data":"hmm"}'), null);
  assert.deepEqual(a.parseEvent('{"type":"text","data":"pong"}'), { kind: "text", text: "pong" });
  assert.deepEqual(
    a.parseEvent('{"type":"end","stopReason":"EndTurn","sessionId":"abc","requestId":"r"}'),
    { kind: "end", sessionId: "abc", stopReason: "EndTurn" },
  );
  assert.equal(a.parseEvent("{broken"), null);
});

test("extractResult joins text deltas and gates ok on EndTurn + exit 0", () => {
  const a = makeGrokAdapter();
  const events = [
    { kind: "text", text: "po" },
    { kind: "text", text: "ng" },
    { kind: "end", sessionId: "abc", stopReason: "EndTurn" },
  ];
  assert.deepEqual(a.extractResult(events, 0), { ok: true, resultText: "pong", sessionId: "abc", usage: null });
  // non-EndTurn terminal → not ok
  assert.equal(a.extractResult([{ kind: "end", sessionId: "x", stopReason: "Aborted" }], 0).ok, false);
  // non-zero exit → not ok even with EndTurn
  assert.equal(a.extractResult(events, 1).ok, false);
  // no text at all → null resultText
  assert.equal(a.extractResult([{ kind: "end", sessionId: "x", stopReason: "EndTurn" }], 0).resultText, null);
});

test("classifyError maps auth / endpoint / not-installed / unknown", () => {
  const a = makeGrokAdapter();
  assert.equal(a.classifyError("xai: 401 unauthorized", 1), "auth");
  assert.equal(a.classifyError("not logged in — run grok login", 1), "auth");
  assert.equal(a.classifyError("fetch failed ECONNREFUSED", 1), "endpoint");
  assert.equal(a.classifyError("command not found", 127), "not-installed");
  assert.equal(a.classifyError("boom", 1), "unknown");
});

test("resumeArgs yields -r <id>", () => {
  assert.deepEqual(makeGrokAdapter().resumeArgs("s1"), ["-r", "s1"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/grok/adapter.test.mjs`
Expected: FAIL — cannot import `makeGrokAdapter` (module not created yet). `tests/grok/helpers.mjs` already exists (created in Task 1 Step 7).

- [ ] **Step 3: Write the adapter**

Create `plugins/grok/scripts/lib/adapter.mjs`:

```javascript
// plugins/grok/scripts/lib/adapter.mjs
// GrokAdapter:grok — all engine knowledge for xAI Grok Build lives here.
// Job runtime (state/worker/cancel) is the vendored shared lib; this file
// touches no I/O lifecycle. Auth is delegated to the grok CLI (XAI_API_KEY or
// a cached token from `grok login`) — no secrets ever land in a job record.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const RECURSION_MARKER = "GROK_FLEET_ACTIVE";

export function resolveDataRoot(env = process.env) {
  if (env.GROK_PLUGIN_DATA) return env.GROK_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok");
}

export function workspaceStateDir(dataRoot, cwd) {
  const slug =
    path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32) || "ws";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function makeGrokAdapter() {
  return {
    name: "grok",
    engine: "grok",
    recursionMarker: RECURSION_MARKER,
    wantsWatchdog: false,
    buildInvocation({ job, prompt }) {
      const r = job.request ?? {};
      const head = r.binaryArgv ?? [process.env.GROK_BIN ?? "grok"];
      // ponytail: prompt inline via -p; ceiling is ARG_MAX (~2MB, getconf ARG_MAX).
      // Upgrade path if that ever bites: write prompt to a file, pass --prompt-file.
      const argv = [
        ...head,
        "-p", prompt,
        "--output-format", "streaming-json",
        "--always-approve",
        "--no-auto-update",
        "--no-alt-screen",
        "-m", r.model ?? process.env.GROK_DEFAULT_MODEL ?? "grok-4.5",
      ];
      const cwd = job.cwd ?? r.cwd;
      if (cwd) argv.push("--cwd", cwd);
      const effort = r.effort ?? process.env.GROK_DEFAULT_EFFORT;
      if (effort) argv.push("--reasoning-effort", effort);
      if (r.resumeSessionId) argv.push("-r", r.resumeSessionId);
      // env: conformance/e2e can inject via request.env; secrets are NOT set here.
      return { argv, env: r.env ?? {}, stdinPayload: null };
    },
    parseEvent(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return null; // junk — tolerate, never fatal
      }
      if (event.type === "text") {
        return { kind: "text", text: typeof event.data === "string" ? event.data : "" };
      }
      if (event.type === "end") {
        return {
          kind: "end",
          sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
          stopReason: event.stopReason ?? null,
        };
      }
      return null; // thought / tool / anything else → raw line stays in the log
    },
    extractResult(events, exitCode) {
      const end = events.find((e) => e.kind === "end");
      const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
      return {
        ok: exitCode === 0 && end?.stopReason === "EndTurn",
        resultText: text.length ? text : null,
        sessionId: end?.sessionId ?? null,
        usage: null, // grok streaming-json emits no token counts
      };
    },
    classifyError(stderrTail, exitCode) {
      const s = String(stderrTail ?? "");
      if (/401|unauthorized|not logged in|forbidden|XAI_API_KEY|authenticate|token expired/i.test(s)) return "auth";
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|relay/i.test(s)) return "endpoint";
      if (exitCode === 127 || /command not found|ENOENT/i.test(s)) return "not-installed";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["-r", sessionId];
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/grok/adapter.test.mjs`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add plugins/grok/scripts/lib/adapter.mjs tests/grok/adapter.test.mjs
git commit -m "feat(grok): ProcessAdapter — normalize grok streaming-json (thought/text/end)"
```

---

### Task 3: Fake engine fixture + shared conformance suite (the highest seam)

**Files:**
- Create: `tests/grok/fake-grok.mjs`
- Test: `tests/grok/grok.conformance.test.mjs`
- (Reuses `tests/grok/helpers.mjs` created in Task 1 Step 7.)

**Interfaces:**
- Consumes: `makeGrokAdapter` (Task 2); `runConformanceSuite` from `tests/shared/conformance/conformance.mjs`; `tests/grok/helpers.mjs` (Task 1).
- Produces: `tests/grok/fake-grok.mjs` (a scriptable `grok` stand-in driven by `FAKE_GROK_MODE`, emitting the real `thought`/`text`/`end` shapes). Reused by the e2e task.

- [ ] **Step 1: Create the fake grok binary**

Create `tests/grok/fake-grok.mjs`:

```javascript
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
```

- [ ] **Step 2: Write the conformance test (fails until the fixture wiring is correct)**

Create `tests/grok/grok.conformance.test.mjs`:

```javascript
// tests/grok/grok.conformance.test.mjs
import "./helpers.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConformanceSuite } from "../shared/conformance/conformance.mjs";
import { makeGrokAdapter } from "../../plugins/grok/scripts/lib/adapter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_GROK = path.join(here, "fake-grok.mjs");

// Map the abstract conformance mode to a fake-grok conf-* mode, and inject the
// fake binary + mode via request.binaryArgv / request.env (no profiles needed).
function makeAdapter({ mode = "ok", resumeSessionId = null } = {}) {
  const base = makeGrokAdapter();
  return {
    ...base,
    buildInvocation({ job, prompt }) {
      return base.buildInvocation({
        job: {
          ...job,
          request: {
            ...job.request,
            resumeSessionId,
            binaryArgv: [process.execPath, FAKE_GROK],
            env: { FAKE_GROK_MODE: `conf-${mode}` },
          },
        },
        prompt,
      });
    },
  };
}

runConformanceSuite({ makeAdapter });
```

- [ ] **Step 3: Run the conformance suite to verify it passes**

Run: `node --test tests/grok/grok.conformance.test.mjs`
Expected: PASS — all 10 scenarios green (normal completion echoes the prompt with `sessionId "fake-session-1"`, midway-drop fails with exit 1, noise tolerated → "survived noise", hang → timed-out, instant-exit → exit 7, cancel race preserved, resume → "resumed", huge output → `huge:262144`, mid-job 401 → `errorKind auth`, grandchild reaped).

- [ ] **Step 4: Run the adapter unit test again (guards the helpers wiring)**

Run: `node --test tests/grok/adapter.test.mjs`
Expected: PASS (still green — sanity check that the shared helpers import is intact).

- [ ] **Step 5: Commit**

```bash
git add tests/grok/fake-grok.mjs tests/grok/grok.conformance.test.mjs
git commit -m "test(grok): fake engine + shared conformance suite (10 lifecycle scenarios)"
```

---

### Task 4: Companion CLI + worker-entry + bin + render

**Files:**
- Create: `plugins/grok/scripts/lib/render.mjs`
- Create: `plugins/grok/scripts/grok-companion.mjs`
- Create: `plugins/grok/scripts/worker-entry.mjs`
- Create: `plugins/grok/bin/grok-companion`
- Test: `tests/grok/companion.test.mjs`

**Interfaces:**
- Consumes: `makeGrokAdapter`, `resolveDataRoot`, `workspaceStateDir` (Task 2); the vendored shared `runWorker`, `installCancelForwarder`, state-store, `parseArgs`/`UsageError`.
- Produces: `runCompanion(argv, deps) -> Promise<number>` (exported for in-process tests); `renderStatus(jobs)` / `renderResult(job, logTail)`.

- [ ] **Step 1: Write the failing companion test**

Create `tests/grok/companion.test.mjs`:

```javascript
// tests/grok/companion.test.mjs — in-process runCompanion() with injected seams.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCompanion } from "../../plugins/grok/scripts/grok-companion.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_GROK = path.join(HERE, "fake-grok.mjs");

function collect() {
  const lines = [];
  return { out: (l) => lines.push(l), lines };
}

test("setup reports the grok CLI version when the probe succeeds", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["setup"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA },
    out,
    deps: { spawnSyncImpl: () => ({ status: 0, stdout: "grok 9.9.9\n" }) },
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /✓ grok CLI: grok 9\.9\.9/.test(l)), lines.join("\n"));
});

test("setup fails when the grok CLI is not runnable", async () => {
  const { out } = collect();
  const code = await runCompanion(["setup"], {
    env: {}, out,
    deps: { spawnSyncImpl: () => ({ error: new Error("ENOENT") }) },
  });
  assert.equal(code, 1);
});

test("task (foreground) runs a job to completion via the fake engine and emits --json", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "hello there", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      // Inject the fake grok as the spawned binary via request.binaryArgv seam.
      deps: { binaryArgv: [process.execPath, FAKE_GROK] },
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.engine, "grok");
  assert.equal(json.status, "completed");
  assert.match(json.resultText, /^echo:hello there/);
});

test("recursion guard: refuses to run inside a grok job", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["status"], { env: { GROK_FLEET_ACTIVE: "1" }, out });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /recursion guard/.test(l)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/grok/companion.test.mjs`
Expected: FAIL — `runCompanion` not exported (module not created).

- [ ] **Step 3: Write render.mjs**

Create `plugins/grok/scripts/lib/render.mjs`:

```javascript
export function renderStatus(jobs) {
  if (!jobs.length) return "No grok jobs in this workspace.";
  return jobs
    .map((job) =>
      [
        job.id,
        (job.status ?? "?").padEnd(9),
        `model=${job.request?.model ?? "grok-4.5"}`,
        job.createdAt ?? "",
        job.title ? `"${job.title}"` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

export function renderResult(job, logTail = "") {
  const head = `[${job.id}] ${job.status} (model=${job.request?.model ?? "grok-4.5"})`;
  if (job.status === "completed") {
    return `${head}\n\n${job.resultText ?? "(no result text)"}`;
  }
  const lines = [job.errorKind ? `${head} [${job.errorKind}]` : head];
  if (job.error) lines.push(`error: ${job.error}`);
  if (logTail) lines.push("", "--- log tail ---", logTail);
  if (job.sessionId) {
    lines.push("", `Tip: continue this thread with: task --resume-job ${job.id} "<follow-up>"`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Write the companion CLI**

Create `plugins/grok/scripts/grok-companion.mjs`:

```javascript
#!/usr/bin/env node
// CLI entry. Commands: setup | task | status | result | cancel | wait | logs
// Testable via runCompanion(argv, deps) with injectable seams.
//
// Job runtime (state/worker/cancel/reconcile) lives in the vendored shared lib;
// grok-specific engine knowledge lives in ./lib/adapter.mjs. Auth is delegated
// to the grok CLI — this companion never handles secrets and has no profiles.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError } from "./lib/shared/args.mjs";
import { createJobRecord, TERMINAL_STATUSES } from "./lib/shared/core/job.mjs";
import {
  createJob,
  readJob,
  listJobs,
  pruneJobs,
  finalizeJob,
  logFilePath,
  jobDir,
} from "./lib/shared/core/state-store.mjs";
import { reconcileDeadPids } from "./lib/shared/core/reconcile.mjs";
import { cancelJob } from "./lib/shared/core/job-control.mjs";
import { waitForJob } from "./lib/shared/core/wait.mjs";
import { readEvents } from "./lib/shared/core/events.mjs";
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { makeGrokAdapter, resolveDataRoot, workspaceStateDir } from "./lib/adapter.mjs";
import { renderStatus, renderResult } from "./lib/render.mjs";

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const USAGE = `usage: grok-companion <command> [...]
  setup
  task <prompt...>|--prompt-file <path> [--model <id>] [--effort high|medium|low] [--background|--wait] [--json] [--resume-job <job>|--resume-last] [--timeout-ms <n>]
  status [--json]
  result [<job-id>|--last] [--json]
  cancel <job-id> [--json]
  wait <job-id> [--timeout-s <n>] [--json]
  logs <job-id> [--follow]`;

const TASK_FLAGS = {
  valueFlags: ["model", "effort", "resume-job", "timeout-ms", "prompt-file"],
  boolFlags: ["background", "wait", "resume-last", "json"],
};

function safeJobId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new UsageError(`Invalid job id: ${value}`);
  }
  return value;
}

function parseTimeoutMs(value, env) {
  if (value === undefined) {
    const raw = Number(env.GROK_JOB_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--timeout-ms must be a positive number, got: ${value}`);
  }
  return n;
}

function resultProjection(job) {
  return {
    engine: "grok",
    jobId: job.id,
    status: job.status,
    resultText: job.resultText ?? null,
    sessionId: job.sessionId ?? null,
    exitCode: job.exitCode ?? null,
    error: job.error ?? null,
    errorKind: job.errorKind ?? null,
    durationMs: job.durationMs ?? null,
  };
}

export async function runCompanion(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line) => process.stdout.write(line + "\n"));
  if (env.GROK_FLEET_ACTIVE === "1") {
    out("grok: disabled inside a grok session (recursion guard).");
    return 0;
  }
  const cwd = deps.cwd ?? process.cwd();
  const dataRoot = resolveDataRoot(env);
  const stateDir = workspaceStateDir(dataRoot, cwd);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "setup":
        return cmdSetup({ env, out, deps });
      case "task":
        return await cmdTask({ argv: rest, env, out, cwd, stateDir, deps });
      case "status":
        return cmdStatus({ argv: rest, out, stateDir });
      case "result":
        return cmdResult({ argv: rest, out, stateDir });
      case "cancel":
        return cmdCancel({ argv: rest, out, stateDir });
      case "wait":
        return await cmdWait({ argv: rest, out, stateDir });
      case "logs":
        return await cmdLogs({ argv: rest, out, stateDir });
      default:
        out(USAGE);
        return command ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      out(`grok: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

function cmdSetup({ env, out, deps }) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const binary = env.GROK_BIN ?? "grok";
  let healthy = true;
  const probe = spawnSyncImpl(binary, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    out(`✗ grok CLI not runnable (${binary}). Install Grok Build from https://x.ai/cli first.`);
    healthy = false;
  } else {
    out(`✓ grok CLI: ${String(probe.stdout).trim()}`);
  }
  // Auth is delegated to the grok CLI. Report the two accepted sources.
  const authFile = path.join(env.HOME ?? "", ".grok", "auth.json");
  if (env.XAI_API_KEY) {
    out("✓ auth: XAI_API_KEY is set");
  } else if (env.HOME && fs.existsSync(authFile)) {
    out(`✓ auth: cached token at ${authFile}`);
  } else {
    out("• auth: none detected — run `!grok login` (SuperGrok / X Premium+) or set XAI_API_KEY");
  }
  out(`default model: ${env.GROK_DEFAULT_MODEL ?? "grok-4.5"}`);
  return healthy ? 0 : 1;
}

function resolveResumeSource({ flags, stateDir }) {
  if (flags["resume-job"]) {
    const source = readJob(stateDir, safeJobId(flags["resume-job"]));
    if (!source) throw new UsageError(`No job ${flags["resume-job"]} to resume`);
    if (!source.sessionId) throw new UsageError(`Job ${source.id} has no session id to resume`);
    return source;
  }
  if (flags["resume-last"]) {
    const source = listJobs(stateDir).find(
      (j) => TERMINAL_STATUSES.has(j.status) && j.sessionId,
    );
    if (!source) throw new UsageError("No resumable job in this workspace");
    return source;
  }
  return null;
}

async function startJob({ prompt, flags, env, out, cwd, stateDir, deps }) {
  const source = resolveResumeSource({ flags, stateDir });
  const record = createJobRecord({
    engine: "grok",
    title: prompt.slice(0, 120),
    cwd,
    timeoutMs: parseTimeoutMs(flags["timeout-ms"], env),
    request: {
      model: flags.model ?? env.GROK_DEFAULT_MODEL ?? "grok-4.5",
      effort: flags.effort ?? env.GROK_DEFAULT_EFFORT ?? null,
      resumeSessionId: source?.sessionId ?? null,
      resumedFrom: source?.id ?? null,
      // test-only injection of a fake binary; undefined in production.
      binaryArgv: deps.binaryArgv,
    },
  });
  createJob(stateDir, record, prompt);
  pruneJobs(stateDir);

  if (flags.background) {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "worker-entry.mjs",
    );
    const spawnImpl = deps.workerSpawnImpl ?? spawn;
    let child;
    try {
      child = spawnImpl(process.execPath, [workerPath, stateDir, record.id], {
        detached: true,
        stdio: "ignore",
        env: { ...env },
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      finalizeJob(stateDir, record.id, { status: "failed", error: message, errorKind: "spawn" });
      const finished = readJob(stateDir, record.id);
      out(flags.json ? JSON.stringify(resultProjection(finished)) : `grok: failed to launch background worker: ${message}`);
      return 1;
    }
    child.unref();
    if (flags.json) {
      out(JSON.stringify({ engine: "grok", jobId: record.id, status: "queued" }));
    } else {
      out(`Started background job ${record.id} (model=${record.request.model}).`);
      out(`Check: status | result ${record.id} | cancel ${record.id}`);
    }
    return 0;
  }

  const forwarder = installCancelForwarder({});
  try {
    await runWorker({
      stateDir,
      jobId: record.id,
      adapter: makeGrokAdapter(),
      deps: {
        spawnImpl: deps.grokSpawnImpl,
        baseEnv: env,
        onChild: forwarder.onChild,
      },
    });
  } finally {
    forwarder.dispose();
  }
  const finished = readJob(stateDir, record.id);
  out(flags.json ? JSON.stringify(resultProjection(finished)) : renderResult(finished, readLogTail(stateDir, record.id)));
  return finished.status === "completed" ? 0 : 1;
}

async function cmdTask({ argv, env, out, cwd, stateDir, deps }) {
  const { flags, positionals } = parseArgs(argv, TASK_FLAGS);
  let prompt;
  if (flags["prompt-file"]) {
    try {
      prompt = fs.readFileSync(path.resolve(cwd, flags["prompt-file"]), "utf8");
    } catch {
      throw new UsageError(`prompt file not readable: ${flags["prompt-file"]}`);
    }
  } else {
    prompt = positionals.join(" ").trim();
  }
  if (!prompt) throw new UsageError("task requires a prompt or --prompt-file");
  if (flags.wait && flags.background) {
    throw new UsageError("--wait and --background are mutually exclusive");
  }
  return startJob({ prompt, flags, env, out, cwd, stateDir, deps });
}

function readLogTail(stateDir, jobId, lines = 30) {
  try {
    const text = fs.readFileSync(logFilePath(stateDir, jobId), "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function cmdStatus({ argv, out, stateDir }) {
  const { flags } = parseArgs(argv, { boolFlags: ["json"] });
  reconcileDeadPids(stateDir);
  const jobs = listJobs(stateDir);
  out(flags.json ? JSON.stringify(jobs.map(resultProjection)) : renderStatus(jobs));
  return 0;
}

function cmdResult({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["last", "json"] });
  reconcileDeadPids(stateDir);
  const job = positionals[0] ? readJob(stateDir, safeJobId(positionals[0])) : listJobs(stateDir)[0];
  if (!job) {
    out(flags.json ? JSON.stringify({ error: "no jobs" }) : "No grok jobs in this workspace.");
    return 1;
  }
  out(flags.json ? JSON.stringify(resultProjection(job)) : renderResult(job, job.status === "completed" ? "" : readLogTail(stateDir, job.id)));
  return job.status === "completed" ? 0 : 1;
}

function cmdCancel({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["json"] });
  if (!positionals[0]) throw new UsageError("cancel requires a job id");
  const result = cancelJob(stateDir, safeJobId(positionals[0]));
  out(flags.json ? JSON.stringify(result) : result.message);
  return result.ok ? 0 : 1;
}

const WAIT_TIMEOUT_EXIT = 10;
function waitExitCode(status) {
  if (status === "completed") return 0;
  if (status === "cancelled") return 2;
  return 1;
}

async function cmdWait({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { valueFlags: ["timeout-s"], boolFlags: ["json"] });
  if (!positionals[0]) throw new UsageError("wait requires a job id");
  const jobId = safeJobId(positionals[0]);
  if (!readJob(stateDir, jobId)) {
    out(flags.json ? JSON.stringify({ error: `no job ${jobId}` }) : `No job ${jobId} in this workspace.`);
    return 1;
  }
  const timeoutS = flags["timeout-s"] ? Number(flags["timeout-s"]) : 540;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    throw new UsageError(`--timeout-s must be a positive number, got: ${flags["timeout-s"]}`);
  }
  reconcileDeadPids(stateDir);
  const { done, job } = await waitForJob({
    stateDir,
    jobId,
    timeoutMs: timeoutS * 1000,
    reconcile: reconcileDeadPids,
    onEvent: (e) => {
      if (!flags.json) out(`[${e.ts}] ${e.type}${e.kind ? ":" + e.kind : ""}`);
    },
  });
  if (!job) {
    out(flags.json ? JSON.stringify({ error: `job ${jobId} no longer exists` }) : `Job ${jobId} no longer exists.`);
    return 1;
  }
  out(flags.json ? JSON.stringify(resultProjection(job)) : renderResult(job, ""));
  if (!done) return WAIT_TIMEOUT_EXIT;
  return waitExitCode(job.status);
}

async function cmdLogs({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["follow"] });
  if (!positionals[0]) throw new UsageError("logs requires a job id");
  const jobId = safeJobId(positionals[0]);
  if (!readJob(stateDir, jobId)) {
    out(`No job ${jobId} in this workspace.`);
    return 1;
  }
  if (!flags.follow) {
    // Story 10: show the RAW grok stream (thought/text/end), not just the
    // normalized lifecycle events — parseEvent drops `thought`, so the only place
    // the thinking survives is the raw stdout log the worker writes. Fall back to
    // the lifecycle events if the raw log was never written (engine never spawned).
    let raw = "";
    try {
      raw = fs.readFileSync(logFilePath(stateDir, jobId), "utf8");
    } catch {
      raw = "";
    }
    if (raw.trim()) {
      out(raw.replace(/\n$/, ""));
    } else {
      for (const e of readEvents(jobDir(stateDir, jobId))) out(JSON.stringify(e));
    }
    return 0;
  }
  const { job } = await waitForJob({
    stateDir,
    jobId,
    timeoutMs: 24 * 60 * 60 * 1000,
    reconcile: reconcileDeadPids,
    onEvent: (e) => out(JSON.stringify(e)),
  });
  return TERMINAL_STATUSES.has(job?.status) ? 0 : 1;
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  runCompanion(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`grok: ${error?.stack ?? error}\n`);
      process.exit(1);
    },
  );
}
```

> **Note for the implementer:** the `deps.binaryArgv` seam is read in `startJob` and stored on the job `request` so both foreground and background paths spawn the fake engine in tests. In production `deps.binaryArgv` is `undefined`, so the adapter falls back to `process.env.GROK_BIN ?? "grok"`.

- [ ] **Step 5: Write the detached worker entry**

Create `plugins/grok/scripts/worker-entry.mjs`:

```javascript
#!/usr/bin/env node
// Detached worker CLI entry: `node worker-entry.mjs <stateDir> <jobId>`.
// The companion's --background path spawns this detached; it drives the vendored
// shared runtime's full job lifecycle off-process, then exits with the worker's
// return code. The cancel forwarder turns a SIGTERM into a process-group kill of
// the grok child (+ grandchildren), with a hard self-exit fallback.
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { readJob, writeJob } from "./lib/shared/core/state-store.mjs";
import { TERMINAL_STATUSES } from "./lib/shared/core/job.mjs";
import { makeGrokAdapter } from "./lib/adapter.mjs";

const [stateDir, jobId] = process.argv.slice(2);

// Early race-free pid stamp so reconcile can recover a queued job if this
// launcher dies before markJobRunning.
const existing = readJob(stateDir, jobId);
if (existing && !TERMINAL_STATUSES.has(existing.status)) {
  writeJob(stateDir, { ...existing, pid: process.pid });
}

const forwarder = installCancelForwarder({ forceExitMs: 7000 });
runWorker({
  stateDir,
  jobId,
  adapter: makeGrokAdapter(),
  deps: { onChild: forwarder.onChild },
}).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
```

- [ ] **Step 6: Write the PATH launcher**

Create `plugins/grok/bin/grok-companion` (mode `0755`):

```bash
#!/usr/bin/env bash
# grok launcher — resolves its own real location (follows symlinks), then execs
# the adjacent ../scripts/grok-companion.mjs.
set -euo pipefail
src="${BASH_SOURCE[0]}"
while [ -h "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  [[ "$src" != /* ]] && src="$dir/$src"
done
here="$(cd -P "$(dirname "$src")" && pwd)"
exec node "$here/../scripts/grok-companion.mjs" "$@"
```

Then: `chmod 755 plugins/grok/bin/grok-companion`

- [ ] **Step 7: Run the companion test to verify it passes**

Run: `node --test tests/grok/companion.test.mjs`
Expected: PASS (setup ok/fail, foreground task completes with `echo:hello there`, recursion guard).

- [ ] **Step 8: Commit**

```bash
git add plugins/grok/scripts/grok-companion.mjs plugins/grok/scripts/worker-entry.mjs plugins/grok/scripts/lib/render.mjs plugins/grok/bin/grok-companion tests/grok/companion.test.mjs
git commit -m "feat(grok): companion CLI, detached worker, launcher, renderers"
```

---

### Task 5: Slash commands + structure test

**Files:**
- Create: `plugins/grok/commands/{setup,task,status,result,cancel,wait,logs}.md`
- Test: `tests/grok/plugin-structure.test.mjs`

**Interfaces:**
- Consumes: the companion verbs (Task 4).
- Produces: seven `/grok:*` slash commands.

- [ ] **Step 1: Write the failing structure test**

Create `tests/grok/plugin-structure.test.mjs`:

```javascript
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/grok");

test("plugin exposes the seven fleet commands", () => {
  const cmds = fs.readdirSync(path.join(ROOT, "commands")).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(cmds, ["cancel.md", "logs.md", "result.md", "setup.md", "status.md", "task.md", "wait.md"]);
});

test("every command shells the grok companion", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "commands"))) {
    const body = fs.readFileSync(path.join(ROOT, "commands", f), "utf8");
    assert.match(body, /scripts\/grok-companion\.mjs/, `${f} must invoke the companion`);
  }
});

test("bin launcher is executable", () => {
  const st = fs.statSync(path.join(ROOT, "bin", "grok-companion"));
  assert.ok(st.mode & 0o111, "bin/grok-companion must be executable");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/grok/plugin-structure.test.mjs`
Expected: FAIL — `commands/` directory does not exist.

- [ ] **Step 3: Create the command files**

`plugins/grok/commands/setup.md`:

```markdown
---
description: Check the grok CLI and report auth status (XAI_API_KEY or grok login)
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup
```

`grok:setup` verifies the `grok` binary is runnable and reports whether auth is
available. Grok Build handles auth itself — either set `XAI_API_KEY`, or run
`!grok login` (SuperGrok / X Premium+). This plugin never stores your key.
```

`plugins/grok/commands/task.md`:

```markdown
---
description: Run a headless Grok Build task (grok-4.5) — launch, then wait/poll for the result
argument-hint: "<prompt> [--prompt-file <path>] [--model <id>] [--effort high|medium|low] [--background|--wait] [--json] [--resume-job <job>|--resume-last] [--timeout-ms <n>]"
---

Run the grok companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task $ARGUMENTS
```

- The prompt must be a complete, self-contained instruction — spell out files,
  constraints, and the definition of done. It runs headlessly with tool
  execution auto-approved, against `grok-4.5` by default.
- For long tasks use `--background`, then poll with `/grok:status` (or, for an
  orchestrator, the companion `wait <id>` verb blocks until completion).
- Use `--json` for machine-readable output (job id, status, exit code).
- Use `--prompt-file <path>` to pass a prompt stored in a file.
- Use `--model <id>` (e.g. `grok-composer-2.5-fast`) or `--effort` to tune the run.
- Use `--resume-job <job>` or `--resume-last` to continue a previous Grok session.
- Never re-run a failed job — it may already have side effects.
- Report the companion's output back to the user verbatim.
```

`plugins/grok/commands/status.md`:

```markdown
---
description: List grok jobs in this workspace
argument-hint: "[--json]"
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status $ARGUMENTS
```
```

`plugins/grok/commands/result.md`:

```markdown
---
description: Fetch the result of a grok job
argument-hint: "[<job-id>|--last]"
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result $ARGUMENTS
```
```

`plugins/grok/commands/cancel.md`:

```markdown
---
description: Cancel a running grok job
argument-hint: "<job-id> [--json]"
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel $ARGUMENTS
```
```

`plugins/grok/commands/wait.md`:

```markdown
---
description: Wait for a grok job to finish
argument-hint: "<job-id> [--timeout-s <n>] [--json]"
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" wait $ARGUMENTS
```
```

`plugins/grok/commands/logs.md`:

```markdown
---
description: Print a grok job's raw event stream (Grok's thinking + text output)
argument-hint: "<job-id> [--follow]"
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" logs $ARGUMENTS
```
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/grok/plugin-structure.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/grok/commands tests/grok/plugin-structure.test.mjs
git commit -m "feat(grok): slash commands (setup/task/status/result/cancel/wait/logs) + structure test"
```

---

### Task 6: Black-box e2e (real subprocess, fake engine) + wire into `test:e2e`

**Files:**
- Create: `tests/grok/e2e-cli.test.mjs`
- Modify: `package.json` (`test:e2e` script — append the grok e2e file)

**Interfaces:**
- Consumes: the real `grok-companion.mjs` (Task 4), `fake-grok.mjs` (Task 3).
- Produces: end-to-end regression coverage of the CLI (real spawn, detached worker, cross-process cancel proving the engine pid dies, `--json` projections).

- [ ] **Step 1: Write the e2e test**

Create `tests/grok/e2e-cli.test.mjs`:

```javascript
// Black-box e2e: drives the REAL grok-companion.mjs CLI as a subprocess, with a
// real detached worker, a real store, and a real cancel asserted to REAP the
// engine process — using per-mode `grok` shims (no API key, runs in CI).
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.join(HERE, "../../plugins/grok/scripts/grok-companion.mjs");
const FAKE_GROK = path.join(HERE, "fake-grok.mjs");

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, ms = 8000) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(50);
  return !alive(pid);
};

// Write a `grok` shim that bakes FAKE_GROK_MODE (+ pidfile) and answers --version.
function writeShim(dir, name, mode, pidfile) {
  const shim = path.join(dir, name);
  const pf = pidfile ? `FAKE_GROK_PIDFILE="${pidfile}" ` : "";
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "grok 0.0.0-fake"; exit 0; fi\n` +
      `exec env FAKE_GROK_MODE=${mode} ${pf}"${process.execPath}" "${FAKE_GROK}" "$@"\n`,
    { mode: 0o755 },
  );
  return shim;
}

function makeWorkspace() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-data-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-ws-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-bin-"));
  const pidfile = path.join(data, "engine.pid");
  const shims = {
    ok: writeShim(bin, "grok-ok", "success"),
    hang: writeShim(bin, "grok-hang", "hang", pidfile),
    fail: writeShim(bin, "grok-fail", "fail"),
  };
  return {
    ws, data, pidfile, shims,
    cleanup() { for (const d of [data, ws, bin]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
  };
}

function cli(w, args, { mode = "ok", timeout = 20000 } = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: w.ws,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GROK_PLUGIN_DATA: w.data, GROK_BIN: w.shims[mode] },
    encoding: "utf8",
    timeout,
  });
}

function jsonOne(res) {
  const lines = (res.stdout ?? "").split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, `--json must emit exactly one clean line; stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  return JSON.parse(lines[0]);
}

function readJobJson(w, jobId) {
  const stateRoot = path.join(w.data, "state");
  for (const slug of fs.readdirSync(stateRoot)) {
    const f = path.join(stateRoot, slug, "jobs", jobId, "job.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  throw new Error(`job.json not found for ${jobId}`);
}

async function pollStatus(w, jobId, want, deadlineMs = 15000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const j = readJobJson(w, jobId);
    if (j.status === want) return j;
    if (["completed", "failed", "cancelled", "timed-out"].includes(j.status) && j.status !== want) return j;
    await sleep(100);
  }
  return readJobJson(w, jobId);
}

test("setup reports the grok CLI version", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["setup"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /✓ grok CLI: grok 0\.0\.0-fake/);
  } finally { w.cleanup(); }
});

test("foreground task completes and --json emits one clean projection", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["task", "hello world", "--wait", "--json"]);
    const j = jsonOne(res);
    assert.equal(res.status, 0);
    assert.equal(j.engine, "grok");
    assert.equal(j.status, "completed");
    assert.match(j.resultText, /^echo:hello world/);
  } finally { w.cleanup(); }
});

test("background task reaches completed and result --last returns it", async () => {
  const w = makeWorkspace();
  try {
    const start = jsonOne(cli(w, ["task", "bg job", "--background", "--json"]));
    assert.equal(start.status, "queued");
    const job = await pollStatus(w, start.jobId, "completed");
    assert.equal(job.status, "completed");
    const res = cli(w, ["result", "--last", "--json"]);
    assert.equal(jsonOne(res).status, "completed");
  } finally { w.cleanup(); }
});

test("logs exposes the raw grok stream including thinking (issue #2 story 10)", () => {
  const w = makeWorkspace();
  try {
    const jobId = jsonOne(cli(w, ["task", "log me", "--wait", "--json"])).jobId;
    const logs = cli(w, ["logs", jobId]);
    assert.equal(logs.status, 0);
    assert.match(logs.stdout, /"type":"thought"/, "raw log must expose Grok's thinking");
    assert.match(logs.stdout, /"type":"text"/);
  } finally { w.cleanup(); }
});

test("cancel reaps the engine process and marks the job cancelled", async () => {
  const w = makeWorkspace();
  try {
    const start = jsonOne(cli(w, ["task", "long job", "--background", "--json"], { mode: "hang" }));
    // wait for the fake engine to write its pid
    const end = Date.now() + 10000;
    while (!fs.existsSync(w.pidfile) && Date.now() < end) await sleep(50);
    const enginePid = Number(fs.readFileSync(w.pidfile, "utf8"));
    assert.ok(alive(enginePid), "engine should be running before cancel");
    const res = cli(w, ["cancel", start.jobId, "--json"]);
    assert.equal(res.status, 0);
    assert.ok(await waitGone(enginePid), "engine pid must be reaped by cancel");
    assert.equal((await pollStatus(w, start.jobId, "cancelled")).status, "cancelled");
  } finally { w.cleanup(); }
});

test("engine failure is classified (401 → auth) and surfaced", () => {
  const w = makeWorkspace();
  try {
    const res = cli(w, ["task", "will fail", "--wait", "--json"], { mode: "fail" });
    const j = jsonOne(res);
    assert.equal(res.status, 1);
    assert.equal(j.status, "failed");
    assert.equal(j.errorKind, "auth");
  } finally { w.cleanup(); }
});
```

- [ ] **Step 2: Run the e2e to verify it passes**

Run: `node --test tests/grok/e2e-cli.test.mjs`
Expected: PASS (setup, foreground+json, background+poll, cancel-reaps-pid, fail→auth).

- [ ] **Step 3: Wire the e2e into the `test:e2e` script**

In `package.json`, append the grok e2e file to `test:e2e`:

```json
    "test:e2e": "node --test tests/cc/e2e-cli.test.mjs tests/codex/e2e-cli.test.mjs tests/antigravity/e2e-cli.test.mjs tests/fleet/e2e-cli.test.mjs tests/grok/e2e-cli.test.mjs",
```

- [ ] **Step 4: Commit**

```bash
git add tests/grok/e2e-cli.test.mjs package.json
git commit -m "test(grok): black-box e2e — real CLI, cross-process cancel reap, --json contract"
```

---

### Task 7: README + CHANGELOG + full-suite verification

**Files:**
- Create: `plugins/grok/CHANGELOG.md`
- Modify: `README.md` (document the `grok` plugin)
- Test: the whole suite (`npm test`), lockstep (`npm run check-version`), drift (`npm run sync-shared` → clean git)

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs and a green full suite.

- [ ] **Step 1: Add the plugin CHANGELOG**

Create `plugins/grok/CHANGELOG.md`:

```markdown
# grok — changelog

## 0.1.0
- Initial release: headless xAI Grok Build engine adapter over the shared runtime.
  Commands: setup, task, status, wait, logs, result, cancel. Default model
  grok-4.5. Auth delegated to the grok CLI (XAI_API_KEY or `grok login`).
```

- [ ] **Step 2: Document the plugin in README**

In `README.md`, add `grok` to the plugin list/table alongside the other engines (mirror the existing entries' format). Include: what it does (delegate headless Grok Build coding tasks), the command set (`/grok:setup`, `/grok:task`, …), the auth requirement (`grok login` or `XAI_API_KEY`), and the default model (`grok-4.5`). Follow the surrounding prose style exactly.

- [ ] **Step 3: Verify version lockstep**

Run: `npm run check-version`
Expected: `✓ versions in lockstep (... grok@0.1.0)`.

- [ ] **Step 4: Verify no vendored-shared drift**

Run: `npm run sync-shared && git diff --exit-code plugins/grok/scripts/lib/shared`
Expected: no diff (exit 0) — the vendored copy matches `shared/lib/`.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — structure + shared + cc + antigravity + codex + grok + fleet + e2e all green. (If `tests/codex/runtime.test.mjs` or `tests/shared/worker.test.mjs` flake on event ordering, re-run once — a known intermittent per AGENTS.md, not a regression.)

- [ ] **Step 6: Commit**

```bash
git add plugins/grok/CHANGELOG.md README.md
git commit -m "docs(grok): README + CHANGELOG for the grok plugin (0.1.0)"
```

---

## Self-Review

**Spec coverage (issue #2):**
- Problem/Solution (grok as a first-class fleet engine) → Tasks 1–6 build the full plugin.
- Stories 1, 19–22, 25 (install, marketplace listing, single adapter module, reuse shared, lockstep, IRONCLAD) → Task 1 (registration, vendor, whitelist) + Task 2 (single adapter).
- Story 2–3 (setup + auth guidance) → Task 4 `cmdSetup` + Task 5 `setup.md`.
- Stories 4–7 (task, auto-approve, model, effort) → Task 4 `cmdTask`/`startJob` + adapter flags (Task 2).
- Stories 8–12 (status/wait/logs/result/cancel) → Task 4 verbs + Task 5 commands.
- Story 13 (resume) → adapter `resumeArgs` (Task 2), companion `resolveResumeSource` (Task 4), conformance scenario 7 (Task 3).
- Story 14 (error classification) → adapter `classifyError` (Task 2), conformance scenario 9 + e2e fail→auth (Tasks 3, 6).
- Story 15 (per-workspace state) → `workspaceStateDir` (Task 2).
- Story 16 (background survives session) → `--background` detached worker (Task 4).
- Stories 17–18 (`--no-auto-update`, no-fullscreen) → adapter argv (Task 2 Global Constraints).
- Stories 23–24 (conformance guarantees, hermetic fake engine) → Task 3.
- Stories 26–28 (no secrets, join text chunks, EndTurn success gate) → adapter `buildInvocation`/`extractResult` (Task 2), `resultProjection` (Task 4).
- Testing Decisions (adapter unit / conformance / e2e / structure / fleet-structure) → Tasks 2, 3, 5, 6, 1.

**Placeholder scan:** No TBDs. Every code step shows full code; every run step shows an exact command + expected result. The one prose-only step is Task 7 Step 2 (README), which points at the existing entries' format rather than inventing copy — acceptable since it is doc prose, not logic.

**Type consistency:** `makeGrokAdapter` members and return shapes (`{kind:"text"|"end"}`, `{ok,resultText,sessionId,usage}`) are identical across the adapter (Task 2), the conformance wrapper (Task 3), and the companion's `resultProjection` (Task 4). `request` fields (`model`, `effort`, `resumeSessionId`, `resumedFrom`, `binaryArgv`, `env`) match between `startJob` (Task 4) and `buildInvocation` (Task 2). Env names (`GROK_BIN`, `GROK_PLUGIN_DATA`, `GROK_DEFAULT_MODEL`, `GROK_DEFAULT_EFFORT`, `GROK_JOB_TIMEOUT_MS`, `GROK_FLEET_ACTIVE`) are used consistently.

## Review-gate outcome (Codex, session 019f44e5)

The Codex adversarial review confirmed the core contract fit (ProcessAdapter members + `runWorker` calls `extractResult(events, exitCode)`, uses adapter-returned env, treats `stdinPayload:null` as `""`), that all shared companion imports exist with matching signatures, that the 10 conformance scenarios pass as written (incl. `FAKE_GROK_MODE` reaching the child via `buildEngineEnv`), and that the e2e shim/cancel path is structurally sound. Four defects it raised are now folded into this plan:

- **BLOCKER — sync-shared whitelist** (resolved): the AGENTS.md whitelist is widened in Task 1 Step 5 to include `scripts/sync-shared.mjs`; CI's `sync-shared && git diff --exit-code` is now satisfied.
- **MAJOR — helpers ordering** (resolved): `tests/grok/helpers.mjs` is created in Task 1 Step 7, before Task 2's adapter test imports it.
- **MAJOR — logs must show thinking** (resolved): `cmdLogs` (non-follow) now prints the raw grok stream (`thought`/`text`/`end`) from `logFilePath`, with an e2e assertion (Task 6) that a `"type":"thought"` line appears — satisfying issue #2 story 10.
- **MINOR — env hygiene** (resolved): `helpers.mjs` also strips `FAKE_GROK_*`.

## Live-verified against real `grok` 0.2.93 (logged-in)
These were run end-to-end against the real CLI and returned correct results — the adapter's happy path is proven, not inferred:
- The **exact adapter argv** `grok -p "<prompt>" --output-format streaming-json --always-approve --no-auto-update --no-alt-screen -m grok-4.5 --cwd <cwd>` → exit 0, `{"type":"text",...}` then `{"type":"end","stopReason":"EndTurn","sessionId":...}`.
- **`--reasoning-effort low`** is accepted in headless `-p` mode (not just `grok agent`).
- **Resume**: `-r <sessionId>` carries prior context (established "42", resumed, model answered "42") and reuses the *same* sessionId — confirms `resumeArgs(id) => ["-r", id]`.
- streaming-json `thought`/`text`/`end` schema, `--prompt-file`, `--output-format json`, `--version`, `--help`.

## Remaining calibration items (still unverified — verify during implementation)
1. **Prompt delivery:** inline `-p "<prompt>"` (ceiling ~2MB ARG_MAX) is accepted for v1; `--prompt-file` is the upgrade path.
2. **Auth heuristic in `setup`:** `XAI_API_KEY` or `~/.grok/auth.json` existence is a heuristic, not proof of a valid session. Refine only if `grok` exposes a cheap official auth-probe subcommand.
3. **`classifyError` auth signature — NOT yet observed** (verification was done logged-in, so no real 401/not-logged-in stderr was seen). Log out (or use a bad `XAI_API_KEY`) once and capture the real failure stderr to calibrate the regex.
4. **Failing / interrupted `stopReason` — NOT yet observed** (only `EndTurn` seen). The "any non-`EndTurn` = failure" gate is a safe default; confirm the actual values on a real aborted/failed turn.
5. **`--always-approve` on a real tool-executing task — NOT yet proven.** The verified runs used trivial no-tool prompts. Before release, run one real `grok -p` task that must edit a file, and confirm `--always-approve` prevents any interactive approval hang in a background job.
