# /fleet:setup Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new minimal `fleet` plugin whose `/fleet:setup` command asks which engines you want, runs a deterministic network-free `fleet-doctor.mjs` readiness check on the chosen subset, and **guides** the user to fix every gap by running each engine's own `/<engine>:setup` themselves. `ready` means local prerequisites are present — auth/login is never verified.

**Architecture:** `plugins/fleet/` is a self-contained sibling plugin = `commands/setup.md` (a prompt-driven, one-decision-at-a-time **guide-only** flow) + `scripts/fleet-doctor.mjs` (a zero-dependency ESM checker exposing `runDoctor(argv, deps)` over an injectable spawn seam, env seam, and existsSync seam). `fleet-doctor` checks binary-on-PATH + `--version` for `codex`/`antigravity`/`delegate`, plus a second local `codex app-server --help` probe for codex, an inline `resolveAgyBin` binary resolution for antigravity, and local profile validation for `delegate`; it never imports sibling-plugin code, never probes auth, and never makes a network call. Every `EngineStatus` carries a constant `authVerified: false`.

**Tech Stack:** Node >= 22.3, zero-dependency ESM `.mjs`, Node's built-in `node --test` with `node:assert/strict`, `node:child_process` (`spawnSync`), `node:fs`, `node:path`, `node:url`.

## Global Constraints
- Node `>=22.3`; every new script is zero-dependency, pure ESM `.mjs` (no third-party imports, no CommonJS).
- Tests use only `node:test` + `node:assert/strict` (no third-party test deps); test files are `.mjs`.
- `fleet-doctor.mjs` exposes `export function runDoctor(argv, deps = {})` with `deps.spawnSyncImpl` (default `spawnSync`), `deps.env` (default `process.env`), and `deps.existsSyncImpl` (default `fs.existsSync`) injectable; a CLI wrapper is guarded by ``if (import.meta.url === `file://${process.argv[1]}`)``.
- Every binary probe goes through the seam: `spawnSyncImpl(binary, [...args], { encoding: "utf8", timeout: 5000, input: "" })`. The version probe passes `["--version"]`; the codex secondary probe passes `["app-server", "--help"]`. No bare `child_process` call. No `cwd` set.
- `fleet-doctor` is self-contained: it does NOT `import` or path-couple to `plugins/{codex,antigravity,delegate}/`; the check recipes — including a re-implementation of antigravity's `resolveAgyBin` resolution order — are encoded inline.
- `fleet-doctor` NEVER probes auth/login/OAuth and NEVER makes a network call. The `codex app-server --help` probe is a local, network-free usage-printing spawn, **not** an auth check. No caching, no state store, no background jobs, no subcommands — behavior is fixed; only `--json` and `--only <csv>` flags exist.
- **Honest readiness:** every `EngineStatus` carries a constant `authVerified: false` (never `true`). `ready` means "local prerequisites present," NOT "authenticated / usable now." Both the JSON contract and the human output must say so.
- Exit codes: `0` for any completed check run (ready or not); `2` for usage errors (unknown flag, unknown engine in `--only`, empty `--only`). No exit `1`.
- `--json` ALWAYS prints exactly one JSON object to stdout, including for usage errors (`{"error": "<message>"}`). Without `--json`, usage errors write plain text to stderr (nothing to stdout).
- Hermetic tests: unit tests call `runDoctor(argv, { spawnSyncImpl, env, existsSyncImpl })` with a stub spawn returning `{status, stdout, stderr, error, signal}`, an explicit `env` object, and (for antigravity) a stubbed `existsSyncImpl`. NO real binaries, NO real filesystem for binary resolution, NO network. The delegate `dataRoot` is derived from `deps.env.HOME`, never `os.homedir()`.
- `tests/fleet/helpers.mjs` must FIRST strip ambient `ANTHROPIC_*`/`CLAUDE_*`/`CLAUDECODE*`/`DELEGATE_*`/`AGY_BIN` from `process.env`, THEN set temp `HOME` + `DELEGATE_PLUGIN_DATA`; it exports `writeProfile(dataRoot, name, contents)`.
- IRONCLAD no-touch: the ONLY existing files this plan may modify are `.claude-plugin/marketplace.json` (+`fleet` entry), `tests/fleet-structure.test.mjs` (+`"fleet"` in the sorted list and the renamed test), `package.json` (+`test:fleet` script & append to `test`), `README.md` (+fleet row and +install instructions). Everything else is NEW under `plugins/fleet/` and `tests/fleet/`. Do NOT touch `plugins/{codex,antigravity,delegate}/` or `tests/{codex,antigravity,delegate}/`.
- All work lands on the already-created branch `feat/fleet-setup`. Do NOT create branches.
- Commit trailer on EVERY commit: end the message with a blank line then exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

| Path | New/Modified | Single responsibility |
|---|---|---|
| `plugins/fleet/.claude-plugin/plugin.json` | New | Minimal plugin manifest `{ name, version, description }`; `name`/`version` match the marketplace `fleet` entry. |
| `plugins/fleet/scripts/fleet-doctor.mjs` | New | Deterministic, network-free readiness checker; `runDoctor(argv, deps)` + CLI wrapper; `--json`/`--only`; spawn + env + existsSync seams; inline per-engine recipes (incl. codex app-server probe + antigravity `resolveAgyBin`) + JSON schema assembly. |
| `plugins/fleet/commands/setup.md` | New | Prompt-driven, GUIDE-ONLY `/fleet:setup` flow: pick engines → run doctor once → explain + recommend the user run `/<engine>:setup` themselves → ready-summary with auth-not-verified caveat + delegate real-smoke hint. |
| `tests/fleet/helpers.mjs` | New | Hermetic test base: strip ambient provider env (+`AGY_BIN`), redirect temp `HOME`/`DELEGATE_PLUGIN_DATA`, export `writeProfile` + temp-dir helpers. |
| `tests/fleet/plugin-structure.test.mjs` | New | Structure parity: `plugin.json` shape + marketplace agreement; `setup.md` frontmatter/flow assertions (guide-only); `fleet-doctor.mjs` exists. |
| `tests/fleet/fleet-doctor.test.mjs` | New | Unit tests via the spawn + existsSync seams for arg parsing, per-engine detection, profile validation, schema invariants, `--only`, error paths. |
| `.claude-plugin/marketplace.json` | Modified | Add the `fleet` entry to `plugins[]`. |
| `tests/fleet-structure.test.mjs` | Modified (lines 24-31) | Add `"fleet"` to the expected sorted plugin-name list AND rename the second test to "marketplace lists exactly the engine plugins plus fleet". |
| `package.json` | Modified (lines 9, 15-16 area) | Add `test:fleet` script and append `&& npm run test:fleet` to `test`. |
| `README.md` | Modified (table + install section) | Add a single `fleet` row to the plugin table AND add `/plugin install fleet@agent-fleet` to the install instructions plus the engine-plugin-dependency note. |

---

### Task 1: Plugin scaffold + wiring (structure suite goes red, then green)

Creates the plugin manifest and all wiring so the structure tests pass. `fleet-doctor.mjs` and `setup.md` are created as minimal-but-real stubs here so the structure assertions about their existence hold; their behavior is built out in later tasks. The `plugin-structure.test.mjs` created here asserts ONLY existence + manifest/marketplace agreement; the deeper `setup.md` content assertions are added in Task 11.

**Files:**
- Create: `plugins/fleet/.claude-plugin/plugin.json`, `plugins/fleet/scripts/fleet-doctor.mjs` (stub), `plugins/fleet/commands/setup.md` (stub), `tests/fleet/helpers.mjs`, `tests/fleet/plugin-structure.test.mjs`.
- Modify: `.claude-plugin/marketplace.json`, `tests/fleet-structure.test.mjs` (lines 24-31).
- Modify: `package.json` (lines 9, 15-16 area).

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `plugins/fleet/.claude-plugin/plugin.json` with `name: "fleet"`, `version: "0.1.0"`; a `fleet` marketplace entry with `source: "./plugins/fleet"`; `npm run test:fleet` script; `tests/fleet/helpers.mjs` exporting `makeTempDir(prefix?)`, `makeDataRoot()`, `writeProfile(dataRoot, name, contents)`.

Steps:

- [ ] Modify `tests/fleet-structure.test.mjs` (the second test block, lines 24-31) to add `"fleet"` to the expected list AND rename the test. The Edit is anchored on the full old test block (unique in the file), so it is robust to the exact line numbers. Replace:
  ```js
  test("marketplace lists exactly the three engine plugins", () => {
    const marketplace = readJson(path.join(ROOT, ".claude-plugin/marketplace.json"));
    assert.deepEqual(
      marketplace.plugins.map((p) => p.name).sort(),
      ["antigravity", "codex", "delegate"],
    );
  });
  ```
  with:
  ```js
  test("marketplace lists exactly the engine plugins plus fleet", () => {
    const marketplace = readJson(path.join(ROOT, ".claude-plugin/marketplace.json"));
    assert.deepEqual(
      marketplace.plugins.map((p) => p.name).sort(),
      ["antigravity", "codex", "delegate", "fleet"],
    );
  });
  ```

- [ ] Run the structure test to verify it FAILS (the `fleet` marketplace entry does not exist yet — only the expected list + test name were edited):
  ```bash
  node --test tests/fleet-structure.test.mjs
  ```
  Expected: FAIL with `ℹ fail 1`. Exactly the second test ("marketplace lists exactly the engine plugins plus fleet") fails with an `AssertionError` comparing `["antigravity","codex","delegate"]` against the expected `["antigravity","codex","delegate","fleet"]`. The first (consistency) test still PASSES because the `fleet` marketplace entry is not added until the next step (the consistency test only iterates entries that exist). Summary: `ℹ pass 1`, `ℹ fail 1`.

- [ ] Add the `fleet` entry to `.claude-plugin/marketplace.json`. Insert this object as the last element of the `plugins` array (after the `delegate` entry, adding a comma after the delegate entry's closing brace):
  ```json
    {
      "name": "fleet",
      "source": "./plugins/fleet",
      "description": "Guided onboarding for the agent-fleet engines — pick the ones you want and fix only those.",
      "version": "0.1.0"
    }
  ```

- [ ] Create `plugins/fleet/.claude-plugin/plugin.json`:
  ```json
  {
    "name": "fleet",
    "version": "0.1.0",
    "description": "Guided onboarding for the agent-fleet engines — pick the ones you want and fix only those."
  }
  ```

- [ ] Create `plugins/fleet/scripts/fleet-doctor.mjs` as a real minimal stub (built out in Tasks 2-10). The structure test only requires this file to exist; keep it valid ESM:
  ```js
  // fleet-doctor.mjs — deterministic, network-free readiness checks for the
  // agent-fleet engines (codex, antigravity, delegate). Self-contained: it does
  // NOT import sibling-plugin code and NEVER probes auth or makes a network call.
  // Behavior is built out incrementally; see runDoctor below.

  export function runDoctor(argv = [], deps = {}) {
    // Placeholder — implemented in subsequent tasks.
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  function main() {
    const { stdout, stderr, exitCode } = runDoctor(process.argv.slice(2));
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(exitCode);
  }

  if (import.meta.url === `file://${process.argv[1]}`) {
    main();
  }
  ```

- [ ] Create `plugins/fleet/commands/setup.md` as a real minimal stub (built out in Task 11). Keep valid frontmatter so the Task 11 assertions have a base to extend:
  ```markdown
  ---
  description: Guided onboarding for the agent-fleet engines (pick the ones you want, fix only those)
  allowed-tools: Bash(node:*), AskUserQuestion
  ---

  This command is built out in a later task.
  ```

- [ ] Create `tests/fleet/helpers.mjs` (strip-then-redirect order is load-bearing). NOTE: unlike `tests/delegate/helpers.mjs`, this `writeProfile` passes a string through verbatim (does NOT `JSON.stringify` it) so Task 7 can write deliberately-unparseable JSON via the string branch; do not "fix" it back to object-only. The strip pattern also clears `AGY_BIN` so an ambient antigravity override cannot leak into any fallback-to-`process.env` path:
  ```js
  // Hermetic test base: import this FIRST in every fleet test file.
  // Strips ambient ANTHROPIC_*/CLAUDE_*/CLAUDECODE*/DELEGATE_*/AGY_BIN THEN
  // redirects HOME and DELEGATE_PLUGIN_DATA to throwaway temp dirs, so the suite
  // never reads the real ~/.claude and never inherits the developer's provider env.
  import fs from "node:fs";
  import os from "node:os";
  import path from "node:path";

  // 1) STRIP ambient provider env first.
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("CLAUDE_") ||
      key.startsWith("CLAUDECODE") ||
      key.startsWith("DELEGATE_") ||
      key === "AGY_BIN"
    ) {
      delete process.env[key];
    }
  }

  // 2) THEN set the test-controlled values so they win over the strip pattern.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.DELEGATE_PLUGIN_DATA = fs.mkdtempSync(
    path.join(os.tmpdir(), "fleet-test-data-"),
  );

  export function makeTempDir(prefix = "fleet-test-") {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  export function makeDataRoot() {
    return makeTempDir("fleet-data-");
  }

  export function writeProfile(dataRoot, name, contents) {
    const dir = path.join(dataRoot, "profiles");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    // contents may be a string (written VERBATIM, to allow raw/invalid JSON)
    // or an object (JSON-stringified). This differs from tests/delegate/helpers.mjs
    // on purpose so Task 7 can write an unparseable-JSON fixture.
    const body = typeof contents === "string" ? contents : JSON.stringify(contents, null, 2);
    fs.writeFileSync(file, body);
    return file;
  }
  ```

- [ ] Create `tests/fleet/plugin-structure.test.mjs` (existence + manifest/marketplace agreement only; deep `setup.md` flow assertions are added in Task 11):
  ```js
  import "./helpers.mjs";
  import test from "node:test";
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import path from "node:path";
  import { fileURLToPath } from "node:url";

  const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

  function readJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  test("fleet plugin.json has the minimal shape and agrees with the marketplace", () => {
    const plugin = readJson(
      path.join(REPO_ROOT, "plugins/fleet/.claude-plugin/plugin.json"),
    );
    assert.equal(plugin.name, "fleet");
    assert.equal(typeof plugin.version, "string");
    assert.ok(plugin.description && plugin.description.length > 0);

    const marketplace = readJson(
      path.join(REPO_ROOT, ".claude-plugin/marketplace.json"),
    );
    const entry = marketplace.plugins.find((p) => p.name === "fleet");
    assert.ok(entry, "fleet missing from marketplace");
    assert.equal(entry.source, "./plugins/fleet");
    assert.equal(entry.version, plugin.version);
  });

  test("fleet plugin ships setup.md and fleet-doctor.mjs", () => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "plugins/fleet/commands/setup.md")),
      "setup.md missing",
    );
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "plugins/fleet/scripts/fleet-doctor.mjs")),
      "fleet-doctor.mjs missing",
    );
  });
  ```

- [ ] Modify `package.json`. Replace the `test` script (line 9) value with the version ending in `&& npm run test:fleet`:
  ```json
      "test": "npm run test:structure && npm run test:shared && npm run test:delegate && npm run test:antigravity && npm run test:codex && npm run test:fleet",
  ```
  and add the `test:fleet` script after the `test:codex` line:
  ```json
      "test:fleet": "node --test \"tests/fleet/*.test.mjs\"",
  ```

- [ ] Run the fleet structure + plugin-structure tests to verify they PASS:
  ```bash
  node --test tests/fleet-structure.test.mjs tests/fleet/plugin-structure.test.mjs
  ```
  Expected: PASS. Summary shows `ℹ pass 4`, `ℹ fail 0` (2 tests in fleet-structure + 2 in plugin-structure).

- [ ] Commit:
  ```bash
  git add plugins/fleet/.claude-plugin/plugin.json plugins/fleet/scripts/fleet-doctor.mjs plugins/fleet/commands/setup.md tests/fleet/helpers.mjs tests/fleet/plugin-structure.test.mjs .claude-plugin/marketplace.json tests/fleet-structure.test.mjs package.json
  git commit -m "$(cat <<'EOF'
  feat(fleet): scaffold fleet plugin + wiring (marketplace, test:fleet, structure tests)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: Arg parsing — `--json`, `--only` canonical-sort/dedup, usage errors

Builds the front of `runDoctor`: flag parsing, the canonical engine order, `--only` filtering with dedup + canonical re-sort, and usage-error handling (exit `2`, `{"error":...}` under `--json`, plain text to stderr otherwise). The check engine itself is stubbed to a fixed not-ready object for now; real per-engine checks come in Tasks 3-9.

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs` (replace the Task 1 stub body).
- Test: `tests/fleet/fleet-doctor.test.mjs` (new).

**Interfaces:**
- Consumes: nothing from earlier tasks (rewrites the stub).
- Produces: `runDoctor(argv, deps = {})` returning `{ stdout: string, stderr: string, exitCode: number }`. Internal constants `CANONICAL = ["codex", "antigravity", "delegate"]`. `--only <csv>` selects a deduped, canonical-sorted subset; unknown flag / unknown engine / empty `--only` → exit `2`. Under `--json` the run emits a JSON object (`{"error": ...}` for usage errors).

Steps:

- [ ] Write the failing test. Create `tests/fleet/fleet-doctor.test.mjs`:
  ```js
  import "./helpers.mjs";
  import test from "node:test";
  import assert from "node:assert/strict";
  import { runDoctor } from "../../plugins/fleet/scripts/fleet-doctor.mjs";

  // A spawn stub that returns "ready" for any binary, so arg-parsing tests
  // are independent of per-engine logic. Returns exit 0 with a version line.
  function readySpawn() {
    return { status: 0, stdout: "stub 1.0.0\n", stderr: "", error: undefined, signal: null };
  }

  function baseEnv(extra = {}) {
    return { HOME: "/tmp/fleet-noexist-home", ...extra };
  }

  test("--only delegate,codex canonical re-sorts to codex,delegate", () => {
    const r = runDoctor(["--json", "--only", "delegate,codex"], {
      spawnSyncImpl: readySpawn,
      env: baseEnv(),
    });
    assert.equal(r.exitCode, 0);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.checkedEngines, ["codex", "delegate"]);
    assert.deepEqual(Object.keys(doc.engines), ["codex", "delegate"]);
    assert.ok(!("antigravity" in doc.engines), "antigravity must be absent");
  });

  test("--only codex,codex dedupes to a single codex", () => {
    const r = runDoctor(["--json", "--only", "codex,codex"], {
      spawnSyncImpl: readySpawn,
      env: baseEnv(),
    });
    assert.deepEqual(JSON.parse(r.stdout).checkedEngines, ["codex"]);
  });

  test("no --only checks all three in canonical order", () => {
    const r = runDoctor(["--json"], { spawnSyncImpl: readySpawn, env: baseEnv() });
    assert.deepEqual(JSON.parse(r.stdout).checkedEngines, ["codex", "antigravity", "delegate"]);
  });

  test("unknown engine under --json writes {error} to stdout and exits 2", () => {
    const r = runDoctor(["--json", "--only", "foo"], {
      spawnSyncImpl: readySpawn,
      env: baseEnv(),
    });
    assert.equal(r.exitCode, 2);
    assert.equal(r.stderr, "");
    assert.deepEqual(JSON.parse(r.stdout), {
      error: "unknown engine: foo; allowed: codex,antigravity,delegate",
    });
  });

  test("unknown engine without --json writes to stderr, stdout empty, exit 2", () => {
    const r = runDoctor(["--only", "foo"], { spawnSyncImpl: readySpawn, env: baseEnv() });
    assert.equal(r.exitCode, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /unknown engine: foo; allowed: codex,antigravity,delegate/);
  });

  test("empty --only is a usage error (exit 2)", () => {
    const r = runDoctor(["--json", "--only", ""], { spawnSyncImpl: readySpawn, env: baseEnv() });
    assert.equal(r.exitCode, 2);
    assert.match(JSON.parse(r.stdout).error, /--only requires/);
  });

  test("unknown flag is a usage error (exit 2)", () => {
    const r = runDoctor(["--json", "--bogus"], { spawnSyncImpl: readySpawn, env: baseEnv() });
    assert.equal(r.exitCode, 2);
    assert.match(JSON.parse(r.stdout).error, /unknown flag: --bogus/);
  });
  ```

- [ ] Run the test to verify it FAILS (the stub `runDoctor` ignores argv and returns `{ stdout: "", ... }`):
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: FAIL. `JSON.parse(r.stdout)` throws on empty string ("Unexpected end of JSON input") for the parsing tests; `ℹ fail 7`.

- [ ] Write minimal implementation. Replace the entire body of `plugins/fleet/scripts/fleet-doctor.mjs` with arg-parsing + a stubbed per-engine checker:
  ```js
  // fleet-doctor.mjs — deterministic, network-free readiness checks for the
  // agent-fleet engines (codex, antigravity, delegate). Self-contained: it does
  // NOT import sibling-plugin code and NEVER probes auth or makes a network call.
  import { spawnSync } from "node:child_process";

  const CANONICAL = ["codex", "antigravity", "delegate"];

  class UsageError extends Error {}

  // Parse argv into { json, only }. Throws UsageError on bad input.
  function parseArgs(argv) {
    let json = false;
    let only = null; // null => all engines
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--json") {
        json = true;
      } else if (arg === "--only") {
        const csv = argv[++i];
        if (csv === undefined || csv === "") {
          throw new UsageError("--only requires a comma-separated engine list");
        }
        only = csv;
      } else if (arg.startsWith("--only=")) {
        const csv = arg.slice("--only=".length);
        if (csv === "") {
          throw new UsageError("--only requires a comma-separated engine list");
        }
        only = csv;
      } else {
        throw new UsageError(`unknown flag: ${arg}`);
      }
    }
    return { json, only };
  }

  // Resolve the engines to check: canonical order, deduped, filtered by --only.
  function resolveEngines(only) {
    if (only === null) return [...CANONICAL];
    const requested = only.split(",").map((s) => s.trim());
    for (const name of requested) {
      if (!CANONICAL.includes(name)) {
        throw new UsageError(
          `unknown engine: ${name}; allowed: ${CANONICAL.join(",")}`,
        );
      }
    }
    // Canonical re-sort + dedup: walk CANONICAL, keep those that were requested.
    return CANONICAL.filter((name) => requested.includes(name));
  }

  // Per-engine checker — stubbed for now; real recipes added in later tasks.
  function checkEngine(engine, deps) {
    return {
      engine,
      status: "not-ready",
      authVerified: false,
      reason: null,
      summary: "stub",
      deepFixCommand: null,
    };
  }

  export function runDoctor(argv = [], deps = {}) {
    let parsed;
    let engines;
    try {
      parsed = parseArgs(argv);
      engines = resolveEngines(parsed.only);
    } catch (err) {
      if (err instanceof UsageError) {
        const wantJson = argv.includes("--json");
        if (wantJson) {
          return { stdout: JSON.stringify({ error: err.message }), stderr: "", exitCode: 2 };
        }
        return { stdout: "", stderr: err.message + "\n", exitCode: 2 };
      }
      throw err;
    }

    const enginesMap = {};
    for (const engine of engines) {
      enginesMap[engine] = checkEngine(engine, deps);
    }
    const allReady = engines.every((e) => enginesMap[e].status === "ready");
    const doc = { checkedEngines: engines, allReady, engines: enginesMap };

    if (parsed.json) {
      return { stdout: JSON.stringify(doc), stderr: "", exitCode: 0 };
    }
    // Human output is implemented in a later task; emit a placeholder for now.
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  function main() {
    const { stdout, stderr, exitCode } = runDoctor(process.argv.slice(2));
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(exitCode);
  }

  if (import.meta.url === `file://${process.argv[1]}`) {
    main();
  }
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS. Summary `ℹ pass 7`, `ℹ fail 0`.

- [ ] Commit:
  ```bash
  git add plugins/fleet/scripts/fleet-doctor.mjs tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet-doctor): arg parsing — --json, --only canonical-sort/dedup, usage errors

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: Shared probe + ORDERED detection rule (ENOENT/error/signal/status → reason + version)

Adds the uniform probe helper and the probe-result **ORDERED detection rule** from spec §5.3. This is the single source of truth for "ran the binary, what happened," evaluated **top-to-bottom; first match wins**:

1. `r.error && r.error.code === "ENOENT"` ⇒ **not found** (`found: false`, `reason: "missing"`, `version: null`).
2. else if `r.error` (any code, **including `ETIMEDOUT`**) OR `r.signal` OR `r.status !== 0` ⇒ **present-but-failed** (`found: true`, `reason: "version-failed"`, `version: null`).
3. else (`r.status === 0`) ⇒ **ok** (`found: true`, `version` = first trimmed non-empty stdout line).

**Only `ENOENT` means missing.** A timeout (Node shape `{ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }`) has `error.code === "ETIMEDOUT"` (not `ENOENT`), so clause 1 does not match and it falls through to clause 2 ⇒ `version-failed`. The probe is parameterized by `args` so the codex secondary probe (`["app-server","--help"]`) reuses the exact same rule. Tested directly via an exported helper.

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs`.
- Test: `tests/fleet/fleet-doctor.test.mjs` (append).

**Interfaces:**
- Consumes: `runDoctor` shape from Task 2.
- Produces: `export function probeBinary(binary, deps, args = ["--version"])` returning `{ ok: boolean, found: boolean, reason: "missing" | "version-failed" | null, version: string | null }`. `ok` ⇔ `status === 0`. `found` is `false` ONLY for `ENOENT` (clause 1). `version` = first trimmed non-empty stdout line when `ok`, else `null`. Calls `deps.spawnSyncImpl(binary, args, { encoding: "utf8", timeout: 5000, input: "" })`.

Steps:

- [ ] Write the failing test. Append to `tests/fleet/fleet-doctor.test.mjs`:
  ```js
  import { probeBinary } from "../../plugins/fleet/scripts/fleet-doctor.mjs";

  function spawnReturning(result) {
    const calls = [];
    const fn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return result;
    };
    fn.calls = calls;
    return fn;
  }

  test("probeBinary: status 0 → ok, found, version is first non-empty trimmed line", () => {
    const spawn = spawnReturning({ status: 0, stdout: "\n  codex-cli 0.42.1 \n\n", stderr: "" });
    const r = probeBinary("codex", { spawnSyncImpl: spawn });
    assert.deepEqual(r, { ok: true, found: true, reason: null, version: "codex-cli 0.42.1" });
    assert.deepEqual(spawn.calls[0].args, ["--version"]);
    assert.equal(spawn.calls[0].opts.timeout, 5000);
    assert.equal(spawn.calls[0].opts.input, "");
    assert.equal(spawn.calls[0].opts.encoding, "utf8");
  });

  test("probeBinary: args are passed through (app-server probe shape)", () => {
    const spawn = spawnReturning({ status: 0, stdout: "usage...\n", stderr: "" });
    const r = probeBinary("codex", { spawnSyncImpl: spawn }, ["app-server", "--help"]);
    assert.equal(r.ok, true);
    assert.deepEqual(spawn.calls[0].args, ["app-server", "--help"]);
  });

  test("probeBinary clause 1: ENOENT → not found, reason missing, version null", () => {
    const spawn = spawnReturning({ error: { code: "ENOENT" }, status: null });
    const r = probeBinary("codex", { spawnSyncImpl: spawn });
    assert.deepEqual(r, { ok: false, found: false, reason: "missing", version: null });
  });

  test("probeBinary clause 2: ETIMEDOUT (Node timeout shape) → found but version-failed (NOT missing)", () => {
    // Measured Node spawnSync timeout shape.
    const spawn = spawnReturning({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } });
    const r = probeBinary("codex", { spawnSyncImpl: spawn });
    assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
  });

  test("probeBinary clause 2: a non-ENOENT error with null status → found but version-failed", () => {
    const spawn = spawnReturning({ error: { code: "EACCES" }, status: null });
    const r = probeBinary("codex", { spawnSyncImpl: spawn });
    assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
  });

  test("probeBinary clause 2: signal set → found but version-failed", () => {
    const spawn = spawnReturning({ status: null, signal: "SIGKILL" });
    const r = probeBinary("codex", { spawnSyncImpl: spawn });
    assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
  });

  test("probeBinary clause 2: status 1 (no error) → found but version-failed", () => {
    const spawn = spawnReturning({ status: 1, stdout: "boom", stderr: "" });
    const r = probeBinary("codex", { spawnSyncImpl: spawn });
    assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
  });
  ```

- [ ] Run the test to verify it FAILS (`probeBinary` is not exported yet):
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: FAIL — `SyntaxError: The requested module ... does not provide an export named 'probeBinary'`, so the whole file errors to load. `ℹ fail` > 0.

- [ ] Write minimal implementation. In `plugins/fleet/scripts/fleet-doctor.mjs`, add the probe helper just above `checkEngine`:
  ```js
  // Uniform binary probe + ORDERED detection rule (spec §5.3).
  // Evaluate clauses top-to-bottom; first match wins:
  //   1. r.error && r.error.code === "ENOENT"                 → not found ("missing")
  //   2. r.error (any code incl ETIMEDOUT) || r.signal
  //      || r.status !== 0                                    → found, "version-failed"
  //   3. r.status === 0                                       → ok, version = first line
  // Only ENOENT means missing; a timeout/any-other-error/signal/non-zero is
  // present-but-failed. `args` is parameterized so the codex secondary probe
  // (["app-server","--help"]) reuses this exact rule.
  export function probeBinary(binary, deps = {}, args = ["--version"]) {
    const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
    const r = spawnSyncImpl(binary, args, {
      encoding: "utf8",
      timeout: 5000,
      input: "",
    });
    // Clause 1: ENOENT (and only ENOENT) means the binary was not found.
    if (r && r.error && r.error.code === "ENOENT") {
      return { ok: false, found: false, reason: "missing", version: null };
    }
    // Clause 2: any other error (incl ETIMEDOUT), any signal, or non-zero status
    // means the binary launched but the probe failed.
    if ((r && r.error) || (r && r.signal) || !r || r.status !== 0) {
      return { ok: false, found: true, reason: "version-failed", version: null };
    }
    // Clause 3: status === 0 → ok.
    return { ok: true, found: true, reason: null, version: firstNonEmptyLine(r.stdout) };
  }

  function firstNonEmptyLine(stdout) {
    if (typeof stdout !== "string") return null;
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (line) return line;
    }
    return null;
  }
  ```
  Note on ordering: ENOENT is matched FIRST (clause 1) so a timeout (`error.code === "ETIMEDOUT"`, `status: null`, `signal: "SIGTERM"`) cannot be misclassified as missing — it falls through to clause 2.

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS. Summary `ℹ fail 0` (the 7 Task-2 tests + 7 new probe tests all pass).

- [ ] Commit:
  ```bash
  git add plugins/fleet/scripts/fleet-doctor.mjs tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet-doctor): shared probe + ORDERED detection rule (ENOENT=missing; timeout=version-failed)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: codex check (two probes — `--version` + `app-server --help`)

Wires the codex recipe into `checkEngine`. codex needs TWO local probes via the seam: `codex --version` AND `codex app-server --help` (args `["app-server","--help"]`). `ready` requires BOTH to exit `0`. Map to `ready`/`binary-missing`/`version-failed`/`app-server-failed` with `binaryName`, `onPath`, `appServerAvailable`, `version`, `authVerified: false`, `summary`, `deepFixCommand`. The app-server probe is SKIPPED when `codex --version` is `binary-missing` or `version-failed`.

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs` (replace the `checkEngine` stub for the `codex` branch; add `checkCodex`).
- Test: `tests/fleet/fleet-doctor.test.mjs` (append).

**Interfaces:**
- Consumes: `probeBinary(binary, deps, args)` from Task 3; `runDoctor` from Task 2.
- Produces: `checkCodex(deps)` returning an `EngineStatus` with fields `engine:"codex"`, `status`, `authVerified:false`, `reason`, `summary`, `deepFixCommand`, `binaryName:"codex"`, `onPath`, `appServerAvailable`, `version`. `checkEngine("codex", deps)` delegates to it.

Steps:

- [ ] Write the failing test. Append to `tests/fleet/fleet-doctor.test.mjs`. The stub distinguishes the two codex probes by inspecting `args` (`["--version"]` vs `["app-server","--help"]`) and records whether the app-server probe was spawned:
  ```js
  // Drives a codex-only run with separate results for the two probes.
  // versionResult answers ["--version"]; appServerResult answers ["app-server","--help"].
  // Returns { doc, appServerSpawned } so tests can assert the probe was/ wasn't run.
  function onlyCodexTwoProbe(versionResult, appServerResult) {
    let appServerSpawned = false;
    const spawn = (bin, args) => {
      if (Array.isArray(args) && args[0] === "app-server") {
        appServerSpawned = true;
        return appServerResult ?? { status: 0, stdout: "usage\n", stderr: "" };
      }
      return versionResult;
    };
    const doc = JSON.parse(
      runDoctor(["--json", "--only", "codex"], {
        spawnSyncImpl: spawn,
        env: { HOME: "/tmp/fleet-noexist-home" },
      }).stdout,
    );
    return { doc, appServerSpawned: () => appServerSpawned };
  }

  test("codex ready requires BOTH probes exit 0", () => {
    const { doc, appServerSpawned } = onlyCodexTwoProbe(
      { status: 0, stdout: "codex-cli 0.42.1\n", stderr: "" },
      { status: 0, stdout: "usage\n", stderr: "" },
    );
    const c = doc.engines.codex;
    assert.equal(c.engine, "codex");
    assert.equal(c.status, "ready");
    assert.equal(c.reason, null);
    assert.equal(c.binaryName, "codex");
    assert.equal(c.onPath, true);
    assert.equal(c.appServerAvailable, true);
    assert.equal(c.version, "codex-cli 0.42.1");
    assert.equal(c.authVerified, false);
    assert.equal(c.deepFixCommand, null);
    assert.ok(c.summary.length > 0);
    assert.equal(appServerSpawned(), true);
  });

  test("codex binary-missing → app-server probe SKIPPED", () => {
    const { doc, appServerSpawned } = onlyCodexTwoProbe({ error: { code: "ENOENT" }, status: null });
    const c = doc.engines.codex;
    assert.equal(c.status, "not-ready");
    assert.equal(c.reason, "binary-missing");
    assert.equal(c.onPath, false);
    assert.equal(c.appServerAvailable, false);
    assert.equal(c.version, null);
    assert.equal(c.authVerified, false);
    assert.equal(c.deepFixCommand, "/codex:setup");
    assert.equal(appServerSpawned(), false, "app-server probe must be skipped when binary-missing");
  });

  test("codex version-failed (status 1) → app-server probe SKIPPED", () => {
    const { doc, appServerSpawned } = onlyCodexTwoProbe({ status: 1, stdout: "", stderr: "boom" });
    const c = doc.engines.codex;
    assert.equal(c.status, "not-ready");
    assert.equal(c.reason, "version-failed");
    assert.equal(c.onPath, true);
    assert.equal(c.appServerAvailable, false);
    assert.equal(c.version, null);
    assert.equal(c.deepFixCommand, "/codex:setup");
    assert.equal(appServerSpawned(), false, "app-server probe must be skipped when version-failed");
  });

  test("codex version-failed (timeout shape) → app-server probe SKIPPED", () => {
    const { doc, appServerSpawned } = onlyCodexTwoProbe({
      status: null,
      signal: "SIGTERM",
      error: { code: "ETIMEDOUT" },
    });
    assert.equal(doc.engines.codex.reason, "version-failed");
    assert.equal(doc.engines.codex.onPath, true);
    assert.equal(doc.engines.codex.appServerAvailable, false);
    assert.equal(appServerSpawned(), false);
  });

  test("codex app-server-failed: --version ok but app-server --help status 1", () => {
    const { doc, appServerSpawned } = onlyCodexTwoProbe(
      { status: 0, stdout: "codex-cli 0.42.1\n", stderr: "" },
      { status: 1, stdout: "", stderr: "x" },
    );
    const c = doc.engines.codex;
    assert.equal(c.status, "not-ready");
    assert.equal(c.reason, "app-server-failed");
    assert.equal(c.onPath, true);
    assert.equal(c.appServerAvailable, false);
    assert.equal(c.version, "codex-cli 0.42.1"); // version populated (--version succeeded)
    assert.equal(c.authVerified, false);
    assert.equal(c.deepFixCommand, "/codex:setup");
    assert.equal(appServerSpawned(), true);
  });

  test("codex app-server-failed on ETIMEDOUT and ENOENT of the app-server probe", () => {
    for (const appResult of [
      { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } },
      { error: { code: "ENOENT" }, status: null },
    ]) {
      const { doc } = onlyCodexTwoProbe(
        { status: 0, stdout: "codex-cli 0.42.1\n", stderr: "" },
        appResult,
      );
      const c = doc.engines.codex;
      assert.equal(c.status, "not-ready");
      assert.equal(c.reason, "app-server-failed");
      assert.equal(c.appServerAvailable, false);
      assert.equal(c.version, "codex-cli 0.42.1");
    }
  });
  ```

- [ ] Run the test to verify it FAILS (the stub `checkEngine` returns `{ ..., summary:"stub", ... }`, no `binaryName`/`onPath`/`appServerAvailable`/`version`):
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: FAIL on the codex assertions (`c.binaryName` is `undefined`, `c.status` is `not-ready` for ready case, `c.appServerAvailable` undefined). `ℹ fail` ≥ 6.

- [ ] Write minimal implementation. In `plugins/fleet/scripts/fleet-doctor.mjs`, add `checkCodex` and route `checkEngine`:
  ```js
  function checkCodex(deps) {
    const version = probeBinary("codex", deps); // ["--version"]
    // binary-missing / version-failed: skip the app-server probe entirely.
    if (!version.ok) {
      const reason = version.found ? "version-failed" : "binary-missing";
      const summary = version.found
        ? "codex found but 'codex --version' failed"
        : "codex not found on PATH — install the OpenAI Codex CLI";
      return {
        engine: "codex",
        status: "not-ready",
        authVerified: false,
        reason,
        summary,
        deepFixCommand: "/codex:setup",
        binaryName: "codex",
        onPath: version.found,
        appServerAvailable: false,
        version: null,
      };
    }
    // --version ok → run the second local probe.
    const appServer = probeBinary("codex", deps, ["app-server", "--help"]);
    if (appServer.ok) {
      return {
        engine: "codex",
        status: "ready",
        authVerified: false,
        reason: null,
        summary: `codex CLI ready (${version.version}) — auth not checked, run /codex:setup to log in`,
        deepFixCommand: null,
        binaryName: "codex",
        onPath: true,
        appServerAvailable: true,
        version: version.version,
      };
    }
    // --version ok but app-server probe failed (any non-zero / error / signal).
    return {
      engine: "codex",
      status: "not-ready",
      authVerified: false,
      reason: "app-server-failed",
      summary: `codex --version ok but 'codex app-server --help' failed — codex isn't fully ready`,
      deepFixCommand: "/codex:setup",
      binaryName: "codex",
      onPath: true,
      appServerAvailable: false,
      version: version.version,
    };
  }
  ```
  Then replace the `checkEngine` stub body:
  ```js
  function checkEngine(engine, deps) {
    if (engine === "codex") return checkCodex(deps);
    // Other engines stubbed until their tasks.
    return {
      engine,
      status: "not-ready",
      authVerified: false,
      reason: null,
      summary: "stub",
      deepFixCommand: null,
    };
  }
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS. `ℹ fail 0`.

- [ ] Commit:
  ```bash
  git add plugins/fleet/scripts/fleet-doctor.mjs tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet-doctor): codex readiness check — two probes (version + app-server)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: antigravity check (inline resolveAgyBin + existsSync seam + installUrl)

Wires the antigravity recipe. `fleet-doctor` **re-implements** the engine's binary resolution order INLINE (it does NOT import `plugins/antigravity/scripts/lib/agent-runtime.mjs`), using `deps.env` and a test-stubbable `deps.existsSyncImpl` (default `fs.existsSync`). Resolution order (first match wins):

1. **`env.AGY_BIN`** — consulted ONLY when truthy/non-empty: `env.AGY_BIN && existsSyncImpl(env.AGY_BIN)`. An empty/unset `AGY_BIN` short-circuits WITHOUT calling `existsSyncImpl("")`. ⇒ `resolvedFrom: "AGY_BIN"`.
2. **PATH scan** — else split `(env.PATH || env.Path || "")` on `":"`, skip falsy/empty segments (`.filter(Boolean)`), and pick the first dir `d` where `existsSyncImpl(join(d, "agy"))`. ⇒ `resolvedFrom: "PATH"`.
3. **home fallback** — else if `existsSyncImpl(join(env.HOME, ".local/bin/agy"))`. ⇒ `resolvedFrom: "home-fallback"`.
4. **default** — else the bare string `"agy"`. ⇒ `resolvedFrom: "default"`.

Then probe the resolved `binPath` with `--version` via the seam. Adds `binPath`, `resolvedFrom`, `binaryName:"agy"`, `onPath`, `version`, `installUrl`, `authVerified:false`. `binary-missing` arises ONLY when no candidate existed (`resolvedFrom: "default"`) AND the bare spawn ENOENT'd (clause 1); `installUrl` is included then. Fully hermetic via stubbed `existsSyncImpl` + `spawnSyncImpl` — no real fs, no real binary.

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs` (add `import fs from "node:fs";` + `import path from "node:path";` to the top import block; add `resolveAgyBin`; add `checkAntigravity`; route in `checkEngine`).
- Test: `tests/fleet/fleet-doctor.test.mjs` (append).

**Interfaces:**
- Consumes: `probeBinary` (Task 3), `runDoctor` (Task 2), `deps.env` + `deps.existsSyncImpl` seams.
- Produces: `export function resolveAgyBin(env, existsSyncImpl)` returning `{ binPath: string, resolvedFrom: "AGY_BIN"|"PATH"|"home-fallback"|"default" }`. `checkAntigravity(deps)` returning an `EngineStatus` with `engine:"antigravity"`, `binaryName:"agy"`, `binPath`, `resolvedFrom`, `onPath`, `version`, `installUrl:"https://antigravity.google/download"`, `authVerified:false`, plus the common fields. `checkEngine("antigravity", deps)` delegates to it.

Steps:

- [ ] Write the failing test. Append to `tests/fleet/fleet-doctor.test.mjs`. Every antigravity case stubs BOTH `existsSyncImpl` and `spawnSyncImpl` — no real fs/binary:
  ```js
  // Drives an antigravity-only run with stubbed existence + spawn. `exists` is a
  // Set of paths that "exist"; `spawnByBin` maps the resolved binPath → spawn result.
  function onlyAgy({ env = {}, exists = [], spawnByBin = {}, defaultSpawn } = {}) {
    const existsSet = new Set(exists);
    let spawnedBin = null;
    const spawn = (bin) => {
      spawnedBin = bin;
      return spawnByBin[bin] ?? defaultSpawn ?? { status: 0, stdout: "agy 1.0\n", stderr: "" };
    };
    const doc = JSON.parse(
      runDoctor(["--json", "--only", "antigravity"], {
        spawnSyncImpl: spawn,
        existsSyncImpl: (p) => existsSet.has(p),
        env: { HOME: "/home/u", ...env },
      }).stdout,
    );
    return { a: doc.engines.antigravity, spawnedBin: () => spawnedBin };
  }

  test("antigravity resolves via AGY_BIN", () => {
    const { a, spawnedBin } = onlyAgy({
      env: { AGY_BIN: "/opt/agy", PATH: "/usr/bin" },
      exists: ["/opt/agy"],
      spawnByBin: { "/opt/agy": { status: 0, stdout: "agy 2.3.0\n", stderr: "" } },
    });
    assert.equal(a.status, "ready");
    assert.equal(a.binPath, "/opt/agy");
    assert.equal(a.resolvedFrom, "AGY_BIN");
    assert.equal(a.binaryName, "agy");
    assert.equal(a.onPath, true);
    assert.equal(a.version, "agy 2.3.0");
    assert.equal(a.authVerified, false);
    assert.equal(a.installUrl, "https://antigravity.google/download");
    assert.equal(spawnedBin(), "/opt/agy");
  });

  test("antigravity resolves via PATH (first existing dir wins)", () => {
    const { a } = onlyAgy({
      env: { PATH: "/a:/b" }, // no AGY_BIN
      exists: ["/b/agy"], // /a/agy does not exist
      spawnByBin: { "/b/agy": { status: 0, stdout: "agy 1.1\n", stderr: "" } },
    });
    assert.equal(a.status, "ready");
    assert.equal(a.binPath, "/b/agy");
    assert.equal(a.resolvedFrom, "PATH");
  });

  test("antigravity PATH empty-segment safety — leading/trailing/double colon is skipped", () => {
    // A bare-'agy' match via an empty segment would be join('', 'agy') === 'agy'.
    // The .filter(Boolean) must skip empty segments so we never test existsSync('agy').
    const seenExistsArgs = [];
    const doc = JSON.parse(
      runDoctor(["--json", "--only", "antigravity"], {
        spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
        existsSyncImpl: (p) => {
          seenExistsArgs.push(p);
          return false;
        },
        env: { HOME: "/home/u", PATH: ":/x::/y" },
      }).stdout,
    );
    assert.ok(!seenExistsArgs.includes("agy"), "must not probe a bare 'agy' from an empty PATH segment");
    assert.equal(doc.engines.antigravity.resolvedFrom, "default");
  });

  test("antigravity resolves via HOME ~/.local/bin/agy fallback", () => {
    const { a } = onlyAgy({
      env: { HOME: "/home/u", PATH: "/a" }, // no AGY_BIN, no agy on PATH
      exists: ["/home/u/.local/bin/agy"],
      spawnByBin: { "/home/u/.local/bin/agy": { status: 0, stdout: "agy 1.4\n", stderr: "" } },
    });
    assert.equal(a.status, "ready");
    assert.equal(a.binPath, "/home/u/.local/bin/agy");
    assert.equal(a.resolvedFrom, "home-fallback");
  });

  test("antigravity AGY_BIN that does not exist falls through (not AGY_BIN)", () => {
    const { a } = onlyAgy({
      env: { AGY_BIN: "/opt/agy", PATH: "/a" },
      exists: ["/a/agy"], // AGY_BIN path NOT in exists; /a/agy is
      spawnByBin: { "/a/agy": { status: 0, stdout: "agy 1.0\n", stderr: "" } },
    });
    assert.equal(a.resolvedFrom, "PATH");
    assert.equal(a.binPath, "/a/agy");
  });

  test("antigravity empty/unset AGY_BIN never calls existsSync('')", () => {
    const seenExistsArgs = [];
    const doc = JSON.parse(
      runDoctor(["--json", "--only", "antigravity"], {
        spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
        existsSyncImpl: (p) => {
          seenExistsArgs.push(p);
          return false;
        },
        env: { HOME: "/home/u", AGY_BIN: "", PATH: "/a" },
      }).stdout,
    );
    assert.ok(!seenExistsArgs.includes(""), "must not call existsSync('') for empty AGY_BIN");
    assert.equal(doc.engines.antigravity.resolvedFrom, "default");
  });

  test("antigravity binary-missing when none — default + ENOENT carries installUrl", () => {
    const { a } = onlyAgy({
      env: { HOME: "/home/u", PATH: "/a:/b" },
      exists: [], // nothing exists anywhere
      defaultSpawn: { error: { code: "ENOENT" }, status: null },
    });
    assert.equal(a.status, "not-ready");
    assert.equal(a.reason, "binary-missing");
    assert.equal(a.binPath, "agy");
    assert.equal(a.resolvedFrom, "default");
    assert.equal(a.onPath, false);
    assert.equal(a.version, null);
    assert.equal(a.installUrl, "https://antigravity.google/download");
    assert.equal(a.deepFixCommand, "/antigravity:setup");
    assert.equal(a.authVerified, false);
  });

  test("antigravity version-failed: resolved path launched but --version failed", () => {
    const { a } = onlyAgy({
      env: { PATH: "/a" },
      exists: ["/a/agy"],
      spawnByBin: { "/a/agy": { status: 7, stdout: "", stderr: "x" } },
    });
    assert.equal(a.status, "not-ready");
    assert.equal(a.reason, "version-failed");
    assert.equal(a.onPath, true);
    assert.equal(a.binPath, "/a/agy");
    assert.equal(a.resolvedFrom, "PATH");
    assert.equal(a.version, null);
    assert.equal(a.deepFixCommand, "/antigravity:setup");
  });

  test("antigravity version-failed: resolved real path but spawn ENOENT (NOT binary-missing)", () => {
    // existsSync resolved /a/agy, but the spawn ENOENTs. Because a real path was
    // resolved (resolvedFrom !== "default"), this is version-failed, NOT binary-missing.
    const { a } = onlyAgy({
      env: { PATH: "/a" },
      exists: ["/a/agy"],
      spawnByBin: { "/a/agy": { error: { code: "ENOENT" }, status: null } },
    });
    assert.equal(a.status, "not-ready");
    assert.equal(a.reason, "version-failed");
    assert.equal(a.resolvedFrom, "PATH");
    assert.equal(a.onPath, true);
    assert.equal(a.binPath, "/a/agy");
    assert.equal(a.deepFixCommand, "/antigravity:setup");
  });
  ```

- [ ] Run the test to verify it FAILS (antigravity is still the stub branch; `resolveAgyBin` not exported):
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: FAIL on the new antigravity assertions (`a.binPath` undefined, `a.status` is `not-ready` with `summary:"stub"`). `ℹ fail` ≥ 8.

- [ ] Write minimal implementation. First add `import fs from "node:fs";` and `import path from "node:path";` to the existing import block at the TOP of the file (next to `import { spawnSync } from "node:child_process";`). Do NOT re-import `spawnSync`; each module is imported exactly once. Then add `resolveAgyBin`, `checkAntigravity`, and route:
  ```js
  const ANTIGRAVITY_INSTALL_URL = "https://antigravity.google/download";

  // Re-implements the antigravity engine's resolveAgyBin order INLINE (no import
  // of plugins/antigravity/.../agent-runtime.mjs). Order, first match wins:
  //   1. env.AGY_BIN (only when truthy AND existsSync) → "AGY_BIN"
  //   2. first 'agy' in (env.PATH || env.Path).split(':').filter(Boolean) → "PATH"
  //   3. <env.HOME>/.local/bin/agy if it exists → "home-fallback"
  //   4. bare "agy" → "default"
  export function resolveAgyBin(env = {}, existsSyncImpl = fs.existsSync) {
    if (env.AGY_BIN && existsSyncImpl(env.AGY_BIN)) {
      return { binPath: env.AGY_BIN, resolvedFrom: "AGY_BIN" };
    }
    const dirs = (env.PATH || env.Path || "").split(":").filter(Boolean);
    for (const d of dirs) {
      const candidate = path.join(d, "agy");
      if (existsSyncImpl(candidate)) {
        return { binPath: candidate, resolvedFrom: "PATH" };
      }
    }
    if (env.HOME) {
      const home = path.join(env.HOME, ".local", "bin", "agy");
      if (existsSyncImpl(home)) {
        return { binPath: home, resolvedFrom: "home-fallback" };
      }
    }
    return { binPath: "agy", resolvedFrom: "default" };
  }

  function checkAntigravity(deps) {
    const env = deps.env ?? process.env;
    const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
    const { binPath, resolvedFrom } = resolveAgyBin(env, existsSyncImpl);
    const probe = probeBinary(binPath, deps);
    if (probe.ok) {
      return {
        engine: "antigravity",
        status: "ready",
        authVerified: false,
        reason: null,
        summary: `agy CLI ready (${probe.version}) — auth not checked, run /antigravity:setup to authorize`,
        deepFixCommand: null,
        binaryName: "agy",
        binPath,
        resolvedFrom,
        onPath: true,
        version: probe.version,
        installUrl: ANTIGRAVITY_INSTALL_URL,
      };
    }
    // binary-missing ONLY when nothing was resolved on disk (resolvedFrom "default")
    // AND the bare spawn ENOENT'd. A resolved real path (AGY_BIN/PATH/home-fallback)
    // that fails to launch is version-failed, not missing — existsSync already proved
    // the file was there, so the gap is "present but broken," matching §5.3's rule.
    const missing = resolvedFrom === "default" && !probe.found;
    const reason = missing ? "binary-missing" : "version-failed";
    const summary = missing
      ? `agy not found — install from ${ANTIGRAVITY_INSTALL_URL}`
      : `agy found (${binPath}) but '${binPath} --version' failed`;
    return {
      engine: "antigravity",
      status: "not-ready",
      authVerified: false,
      reason,
      summary,
      deepFixCommand: "/antigravity:setup",
      binaryName: "agy",
      binPath,
      resolvedFrom,
      onPath: !missing,
      version: null,
      installUrl: ANTIGRAVITY_INSTALL_URL,
    };
  }
  ```
  Then extend `checkEngine`:
  ```js
  function checkEngine(engine, deps) {
    if (engine === "codex") return checkCodex(deps);
    if (engine === "antigravity") return checkAntigravity(deps);
    // delegate stubbed until its task.
    return {
      engine,
      status: "not-ready",
      authVerified: false,
      reason: null,
      summary: "stub",
      deepFixCommand: null,
    };
  }
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS. `ℹ fail 0`.

- [ ] Commit:
  ```bash
  git add plugins/fleet/scripts/fleet-doctor.mjs tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet-doctor): antigravity readiness check (inline resolveAgyBin + existsSync seam)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: delegate CLI check (DELEGATE_CLAUDE_BIN override, cliRunnable)

Wires the first half of the delegate recipe: resolve `DELEGATE_CLAUDE_BIN ?? "claude"`, probe `<binary> --version`, and produce the CLI-related delegate fields (`binaryName`, `cliRunnable`, `cliVersion`, `authVerified:false`) with the `cli-missing`/`cli-version-failed` reasons. Profile discovery comes in Task 7, so the readiness gate here treats "CLI ok" as ready-pending-profiles; the test asserts CLI fields plus the §5.4 delegate field shape (`dataRoot`/`profiles`/`validProfileCount`/`firstValidProfile`) for now (profile-gated readiness is finalized in Task 7).

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs` (add `checkDelegate`; route in `checkEngine`).
- Test: `tests/fleet/fleet-doctor.test.mjs` (append).

**Interfaces:**
- Consumes: `probeBinary` (Task 3), `runDoctor` (Task 2). `path` and `fs` are already imported (Task 5).
- Produces: `checkDelegate(deps)` returning a delegate `EngineStatus` carrying at least `engine:"delegate"`, `authVerified:false`, `binaryName`, `cliRunnable`, `cliVersion`, `deepFixCommand:"/delegate:setup"`, plus the common fields and the delegate field shape `dataRoot`/`profiles`/`validProfileCount`/`firstValidProfile`. When the CLI is not runnable the reason is `cli-missing`/`cli-version-failed`; profile discovery is wired in Task 7.

Steps:

- [ ] Write the failing test. Append to `tests/fleet/fleet-doctor.test.mjs`:
  ```js
  function onlyDelegate(spawnResult, env = {}) {
    const spawn = (bin, args, opts) => {
      onlyDelegate._lastBin = bin;
      return spawnResult;
    };
    return {
      doc: JSON.parse(
        runDoctor(["--json", "--only", "delegate"], {
          spawnSyncImpl: spawn,
          env: { HOME: "/tmp/fleet-noexist-home", ...env },
        }).stdout,
      ),
      lastBin: () => onlyDelegate._lastBin,
    };
  }

  test("delegate cli-missing (ENOENT) → cliRunnable false", () => {
    const { doc } = onlyDelegate({ error: { code: "ENOENT" }, status: null });
    const d = doc.engines.delegate;
    assert.equal(d.status, "not-ready");
    assert.equal(d.reason, "cli-missing");
    assert.equal(d.cliRunnable, false);
    assert.equal(d.cliVersion, null);
    assert.equal(d.binaryName, "claude");
    assert.equal(d.authVerified, false);
    assert.equal(d.deepFixCommand, "/delegate:setup");
    // §5.4 delegate field shape must stay uniform even on the cli-missing leg
    // (no profile discovery happens, but the keys must be present).
    assert.equal(typeof d.dataRoot, "string");
    assert.ok(Array.isArray(d.profiles));
    assert.equal(d.validProfileCount, 0);
    assert.equal(d.firstValidProfile, null);
  });

  test("delegate cli-version-failed (status 1) → cliRunnable false, cliVersion null", () => {
    const { doc } = onlyDelegate({ status: 1, stdout: "", stderr: "x" });
    const d = doc.engines.delegate;
    assert.equal(d.reason, "cli-version-failed");
    assert.equal(d.cliRunnable, false);
    assert.equal(d.cliVersion, null);
  });

  test("delegate honors DELEGATE_CLAUDE_BIN override for binaryName and spawn", () => {
    const { doc, lastBin } = onlyDelegate(
      { error: { code: "ENOENT" }, status: null },
      { DELEGATE_CLAUDE_BIN: "/opt/bin/claude" },
    );
    assert.equal(doc.engines.delegate.binaryName, "/opt/bin/claude");
    assert.equal(lastBin(), "/opt/bin/claude");
  });
  ```

- [ ] Run the test to verify it FAILS (delegate is still the stub branch):
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: FAIL — `d.cliRunnable` undefined, `d.reason` is `null` (stub). `ℹ fail` ≥ 3.

- [ ] Write minimal implementation. `path` and `fs` are already imported at the top (Task 5) — do NOT re-import. Add the `dataRoot` resolver (used here and in Task 7) — derive `<HOME>` from `env.HOME`, NOT `os.homedir()`:
  ```js
  function resolveDataRoot(env) {
    if (env.DELEGATE_PLUGIN_DATA) return env.DELEGATE_PLUGIN_DATA;
    if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
    const home = env.HOME ?? process.env.HOME ?? "";
    return path.join(home, ".claude", "plugins", "data", "delegate");
  }
  ```
  Then add `checkDelegate` (profile fields are filled in Task 7; for now stub them so the object shape is stable):
  ```js
  function checkDelegate(deps) {
    const env = deps.env ?? process.env;
    const binaryName = env.DELEGATE_CLAUDE_BIN ?? "claude";
    const probe = probeBinary(binaryName, deps);
    const cliRunnable = probe.ok;
    const cliVersion = probe.ok ? probe.version : null;

    if (!cliRunnable) {
      const reason = probe.found ? "cli-version-failed" : "cli-missing";
      const summary = probe.found
        ? `${binaryName} found but '--version' failed`
        : `${binaryName} CLI not found — delegate needs the claude CLI`;
      return {
        engine: "delegate",
        status: "not-ready",
        authVerified: false,
        reason,
        summary,
        deepFixCommand: "/delegate:setup",
        binaryName,
        cliRunnable: false,
        cliVersion: null,
        dataRoot: resolveDataRoot(env),
        profiles: [],
        validProfileCount: 0,
        firstValidProfile: null,
      };
    }

    // CLI ok. Profile discovery is added in Task 7; for now report not-ready with
    // zero profiles as a placeholder (finalized next task).
    return {
      engine: "delegate",
      status: "not-ready",
      authVerified: false,
      reason: "no-profiles",
      summary: "delegate CLI ready (profile discovery pending)",
      deepFixCommand: "/delegate:setup",
      binaryName,
      cliRunnable: true,
      cliVersion,
      dataRoot: resolveDataRoot(env),
      profiles: [],
      validProfileCount: 0,
      firstValidProfile: null,
    };
  }
  ```
  Route it in `checkEngine`:
  ```js
  function checkEngine(engine, deps) {
    if (engine === "codex") return checkCodex(deps);
    if (engine === "antigravity") return checkAntigravity(deps);
    if (engine === "delegate") return checkDelegate(deps);
    return {
      engine,
      status: "not-ready",
      authVerified: false,
      reason: null,
      summary: "stub",
      deepFixCommand: null,
    };
  }
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS. `ℹ fail 0`.

- [ ] Commit:
  ```bash
  git add plugins/fleet/scripts/fleet-doctor.mjs tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet-doctor): delegate CLI check (DELEGATE_CLAUDE_BIN override, cliRunnable)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 7: delegate profile discovery + validation + readiness gate

Finalizes the delegate recipe: enumerate `dataRoot/profiles/*.json`, run the basename `PROFILE_NAME_RE` check (skip-before-parse), the JSON parse check, and the env-scalar check — which **rejects `Array.isArray(parsed.env)`** (an array `env` is not a valid object) with `error: "non-scalar-env"`. Populate `profiles` (invalid-only), `validProfileCount`, `firstValidProfile` (basename-sorted); and gate `ready` on `cliRunnable && validProfileCount >= 1`. Also confirms the default `dataRoot` is derived from `env.HOME`. The `env: ["x"]` fixture proves the array-env rejection.

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs` (add `PROFILE_NAME_RE`, `discoverProfiles`; finalize ONLY the CLI-ok branch of `checkDelegate`).
- Test: `tests/fleet/fleet-doctor.test.mjs` (append; uses `writeProfile` + temp `dataRoot`).

**Interfaces:**
- Consumes: `checkDelegate` CLI half (Task 6), `resolveDataRoot` (Task 6), `writeProfile`/`makeDataRoot` (Task 1 helpers). `fs`/`path` already imported (Task 5).
- Produces: `export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/`; `discoverProfiles(dataRoot)` returning `{ invalid: Array<{name, error}>, validNames: string[] }`. Finalized delegate `EngineStatus` sets `status:"ready"` iff `cliRunnable && validProfileCount >= 1`, with reasons `no-profiles` (zero files) / `no-valid-profiles` (files exist, none valid).

Steps:

- [ ] Write the failing test. Append to `tests/fleet/fleet-doctor.test.mjs`. NOTE: fixtures use the documented `ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` env keys (matching README/delegate setup.md). The env-scalar check is key-agnostic, so key names do not affect validity; this just keeps fixtures realistic. The `env: ["x"]` fixture is load-bearing — it proves `Array.isArray(parsed.env)` is rejected:
  ```js
  import { writeProfile, makeDataRoot } from "./helpers.mjs";
  import { PROFILE_NAME_RE } from "../../plugins/fleet/scripts/fleet-doctor.mjs";

  function delegateWith(dataRoot, spawnResult = { status: 0, stdout: "claude 1.2.3\n", stderr: "" }) {
    return JSON.parse(
      runDoctor(["--json", "--only", "delegate"], {
        spawnSyncImpl: () => spawnResult,
        env: { HOME: "/tmp/fleet-noexist-home", DELEGATE_PLUGIN_DATA: dataRoot },
      }).stdout,
    ).engines.delegate;
  }

  test("PROFILE_NAME_RE rejects leading . _ - and spaces; accepts normal names", () => {
    assert.ok(PROFILE_NAME_RE.test("work"));
    assert.ok(PROFILE_NAME_RE.test("work.prod-1_x"));
    assert.ok(!PROFILE_NAME_RE.test(".hidden"));
    assert.ok(!PROFILE_NAME_RE.test("_foo"));
    assert.ok(!PROFILE_NAME_RE.test("-foo"));
    assert.ok(!PROFILE_NAME_RE.test("a b"));
  });

  test("delegate ready: CLI ok + 1 valid profile (authVerified false)", () => {
    const dataRoot = makeDataRoot();
    writeProfile(dataRoot, "work", { env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_MODEL: "m" } });
    const d = delegateWith(dataRoot);
    assert.equal(d.status, "ready");
    assert.equal(d.reason, null);
    assert.equal(d.cliRunnable, true);
    assert.equal(d.cliVersion, "claude 1.2.3");
    assert.equal(d.validProfileCount, 1);
    assert.equal(d.firstValidProfile, "work");
    assert.deepEqual(d.profiles, []);
    assert.equal(d.deepFixCommand, null);
    assert.equal(d.authVerified, false);
  });

  test("delegate no-profiles: CLI ok, empty dir", () => {
    const dataRoot = makeDataRoot();
    const d = delegateWith(dataRoot);
    assert.equal(d.status, "not-ready");
    assert.equal(d.reason, "no-profiles");
    assert.equal(d.validProfileCount, 0);
    assert.equal(d.firstValidProfile, null);
  });

  test("delegate no-valid-profiles: nested-object env, ARRAY env, unparseable JSON", () => {
    const dataRoot = makeDataRoot();
    writeProfile(dataRoot, "nested", { env: { X: {} } });
    writeProfile(dataRoot, "arr", { env: ["x"] }); // an ARRAY env is invalid
    writeProfile(dataRoot, "broken", "{ not json");
    const d = delegateWith(dataRoot);
    assert.equal(d.status, "not-ready");
    assert.equal(d.reason, "no-valid-profiles");
    assert.equal(d.validProfileCount, 0);
    const byName = Object.fromEntries(d.profiles.map((p) => [p.name, p.error]));
    assert.equal(byName.nested, "non-scalar-env");
    assert.equal(byName.arr, "non-scalar-env"); // Array.isArray(env) rejected
    assert.equal(byName.broken, "unparseable-json");
  });

  test("delegate invalid-name: leading-underscore basename skipped before parse", () => {
    const dataRoot = makeDataRoot();
    writeProfile(dataRoot, "_foo", { env: { X: "ok" } }); // would be valid if parsed
    writeProfile(dataRoot, "good", { env: { X: "ok" } });
    const d = delegateWith(dataRoot);
    assert.equal(d.status, "ready"); // "good" is valid
    assert.equal(d.validProfileCount, 1);
    assert.equal(d.firstValidProfile, "good");
    const bad = d.profiles.find((p) => p.name === "_foo");
    assert.equal(bad.error, "invalid-name");
  });

  test("delegate firstValidProfile is basename-sorted", () => {
    const dataRoot = makeDataRoot();
    writeProfile(dataRoot, "zeta", { env: { X: "ok" } });
    writeProfile(dataRoot, "alpha", { env: { X: "ok" } });
    const d = delegateWith(dataRoot);
    assert.equal(d.firstValidProfile, "alpha");
    assert.equal(d.validProfileCount, 2);
  });

  test("delegate scalar env values (string/number/boolean/null) are valid", () => {
    const dataRoot = makeDataRoot();
    writeProfile(dataRoot, "scalars", { env: { S: "x", N: 1, B: true, Z: null } });
    const d = delegateWith(dataRoot);
    assert.equal(d.status, "ready");
    assert.equal(d.validProfileCount, 1);
  });

  test("delegate default dataRoot derives from env.HOME, not os.homedir()", () => {
    const fakeHome = makeDataRoot(); // any temp dir path
    const d = JSON.parse(
      runDoctor(["--json", "--only", "delegate"], {
        spawnSyncImpl: () => ({ status: 0, stdout: "claude 1\n", stderr: "" }),
        env: { HOME: fakeHome }, // no DELEGATE_PLUGIN_DATA / CLAUDE_PLUGIN_DATA
      }).stdout,
    ).engines.delegate;
    assert.equal(d.dataRoot, `${fakeHome}/.claude/plugins/data/delegate`);
  });
  ```

- [ ] Run the test to verify it FAILS (profile discovery is the Task-6 placeholder: ready case still reports `no-profiles`):
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: FAIL — "delegate ready" expects `status:"ready"` but gets `not-ready`/`no-profiles`; `PROFILE_NAME_RE` not exported. `ℹ fail` ≥ 6.

- [ ] Write minimal implementation. `fs` and `path` are already imported at the top (Task 5) — do NOT re-import. Add the profile machinery near the top:
  ```js
  // Mirrors plugins/delegate/scripts/lib/profiles.mjs PROFILE_NAME_RE — re-declared
  // inline so fleet-doctor stays self-contained (no sibling-plugin import).
  export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

  // A top-level `env`, if present, must be a PLAIN object whose every value is a
  // scalar (string|number|boolean|null). An ARRAY env is invalid (Array.isArray
  // rejected); so is any nested object/array value.
  function envIsScalarOnly(parsed) {
    if (!parsed || parsed.env === undefined || parsed.env === null) return true;
    if (typeof parsed.env !== "object" || Array.isArray(parsed.env)) return false;
    for (const value of Object.values(parsed.env)) {
      if (value !== null && typeof value === "object") return false; // object or array value
    }
    return true;
  }

  // Enumerate <dataRoot>/profiles/*.json. Returns invalid entries (name+error)
  // and the sorted names of valid profiles. Validation order per spec §5.3:
  //   1) basename regex (skip before parse), 2) JSON parse, 3) env scalar-only.
  function discoverProfiles(dataRoot) {
    const dir = path.join(dataRoot, "profiles");
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return { invalid: [], validNames: [] };
    }
    const names = entries
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .sort();

    const invalid = [];
    const validNames = [];
    for (const name of names) {
      if (!PROFILE_NAME_RE.test(name)) {
        invalid.push({ name, error: "invalid-name" });
        continue; // skip before parse
      }
      const file = path.join(dir, `${name}.json`);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        invalid.push({ name, error: "unparseable-json" });
        continue;
      }
      if (!envIsScalarOnly(parsed)) {
        invalid.push({ name, error: "non-scalar-env" });
        continue;
      }
      validNames.push(name);
    }
    return { invalid, validNames };
  }
  ```
  Then replace ONLY the CLI-ok placeholder `return` in `checkDelegate` (the one with `reason: "no-profiles"`, `summary: "delegate CLI ready (profile discovery pending)"`) with the finalized assembly below. Leave the `if (!cliRunnable)` branch exactly as written in Task 6 (its `authVerified: false`, `dataRoot: resolveDataRoot(env)`, `profiles: []`, `validProfileCount: 0`, `firstValidProfile: null` are already correct and need no edit):
  ```js
    // CLI ok — discover + validate local profiles (no network).
    const dataRoot = resolveDataRoot(env);
    const { invalid, validNames } = discoverProfiles(dataRoot);
    const validProfileCount = validNames.length;
    const firstValidProfile = validProfileCount ? validNames[0] : null;
    const anyFiles = invalid.length + validProfileCount > 0;

    if (validProfileCount >= 1) {
      return {
        engine: "delegate",
        status: "ready",
        authVerified: false,
        reason: null,
        summary: `delegate ready (${binaryName} ${cliVersion}, ${validProfileCount} valid profile(s)) — token not checked`,
        deepFixCommand: null,
        binaryName,
        cliRunnable: true,
        cliVersion,
        dataRoot,
        profiles: invalid,
        validProfileCount,
        firstValidProfile,
      };
    }

    const reason = anyFiles ? "no-valid-profiles" : "no-profiles";
    const summary = anyFiles
      ? "claude CLI ready but no valid profiles (fix the listed file(s))"
      : `claude CLI ready but no profiles found in ${path.join(dataRoot, "profiles")}`;
    return {
      engine: "delegate",
      status: "not-ready",
      authVerified: false,
      reason,
      summary,
      deepFixCommand: "/delegate:setup",
      binaryName,
      cliRunnable: true,
      cliVersion,
      dataRoot,
      profiles: invalid,
      validProfileCount,
      firstValidProfile: null,
    };
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS. `ℹ fail 0`.

- [ ] Commit:
  ```bash
  git add plugins/fleet/scripts/fleet-doctor.mjs tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet-doctor): delegate profile discovery + validation (array env rejected) + readiness gate

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 8: top-level assembly — `allReady`, `--only` map filtering, schema invariants (guardrail task)

Locks the top-level JSON contract: `checkedEngines` (canonical+filtered), the `engines` map containing exactly those keys, `allReady` aggregation, and the schema invariants (common fields present; `authVerified` always present and `false`; `reason`/`deepFixCommand` null iff ready; no `schemaVersion`; per-engine fields present on every verdict — codex `appServerAvailable`, antigravity `binPath`/`resolvedFrom`, delegate `cliRunnable`). The assembly already exists from Task 2 and the per-engine objects from Tasks 4-7. This is a **characterization/guardrail task: it pins already-passing behavior with explicit contract gates and has NO red step** — do not hunt for a missing RED.

**Files:**
- Test: `tests/fleet/fleet-doctor.test.mjs` (append).

**Interfaces:**
- Consumes: `runDoctor` + all three `checkEngine` branches (Tasks 4-7).
- Produces: no new exports — pins the documented `--json` top-level shape from spec §5.4.

Steps:

- [ ] Write the contract-pinning test. Append to `tests/fleet/fleet-doctor.test.mjs`. The schema-invariant test runs the SAME invariant loop over TWO docs — one all-ready (exercises the `ready` branch) and one all-not-ready (exercises the `reason !== null && deepFixCommand !== null` branch) — so the "null iff ready" invariant is proven in BOTH directions. The all-ready spawn returns `status: 0` for ALL probes including the codex app-server probe, so codex reaches `ready`:
  ```js
  function allReadyDoc() {
    // codex (both probes) + antigravity probe ready; delegate ready needs a valid profile.
    // antigravity resolves via the bare default; spawn returns status 0 so it is ready.
    const dataRoot = makeDataRoot();
    writeProfile(dataRoot, "work", { env: { ANTHROPIC_AUTH_TOKEN: "t" } });
    return JSON.parse(
      runDoctor(["--json"], {
        spawnSyncImpl: () => ({ status: 0, stdout: "v 1.0\n", stderr: "" }),
        existsSyncImpl: () => false, // antigravity falls through to bare "agy", which spawns ok
        env: { HOME: "/tmp/fleet-noexist-home", DELEGATE_PLUGIN_DATA: dataRoot },
      }).stdout,
    );
  }

  function allNotReadyDoc() {
    // Every probe ENOENT (codex/antigravity binary-missing, delegate cli-missing);
    // delegate dataRoot empty. No engine is ready.
    const emptyRoot = makeDataRoot();
    return JSON.parse(
      runDoctor(["--json"], {
        spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
        existsSyncImpl: () => false,
        env: { HOME: "/tmp/fleet-noexist-home", DELEGATE_PLUGIN_DATA: emptyRoot },
      }).stdout,
    );
  }

  test("allReady is true only when every checked engine is ready", () => {
    const doc = allReadyDoc();
    assert.equal(doc.allReady, true);
    assert.deepEqual(doc.checkedEngines, ["codex", "antigravity", "delegate"]);

    // Flip delegate to not-ready by withholding profiles.
    const emptyRoot = makeDataRoot();
    const doc2 = JSON.parse(
      runDoctor(["--json"], {
        spawnSyncImpl: () => ({ status: 0, stdout: "v 1.0\n", stderr: "" }),
        existsSyncImpl: () => false,
        env: { HOME: "/tmp/fleet-noexist-home", DELEGATE_PLUGIN_DATA: emptyRoot },
      }).stdout,
    );
    assert.equal(doc2.allReady, false);
  });

  test("--only filters the engines map to exactly the checked keys (canonical insertion order)", () => {
    const doc = JSON.parse(
      runDoctor(["--json", "--only", "codex,delegate"], {
        spawnSyncImpl: () => ({ status: 0, stdout: "v 1.0\n", stderr: "" }),
        env: { HOME: "/tmp/fleet-noexist-home", DELEGATE_PLUGIN_DATA: makeDataRoot() },
      }).stdout,
    );
    assert.deepEqual(doc.checkedEngines, ["codex", "delegate"]);
    // unsorted: pins the canonical INSERTION order of the engines map keys.
    assert.deepEqual(Object.keys(doc.engines), ["codex", "delegate"]);
    assert.ok(!("antigravity" in doc.engines));
  });

  function assertSchemaInvariants(doc) {
    assert.ok(!("schemaVersion" in doc));
    for (const name of doc.checkedEngines) {
      const e = doc.engines[name];
      assert.equal(e.engine, name);
      assert.ok(e.status === "ready" || e.status === "not-ready");
      // authVerified is ALWAYS present and ALWAYS false (never true, even when ready).
      assert.equal(e.authVerified, false);
      assert.equal(typeof e.summary, "string");
      assert.ok(e.summary.length > 0);
      if (e.status === "ready") {
        assert.equal(e.reason, null);
        assert.equal(e.deepFixCommand, null);
      } else {
        assert.notEqual(e.reason, null);
        assert.notEqual(e.deepFixCommand, null);
      }
      // Per-engine fields present on EVERY verdict (catches undefined regressions).
      if (name === "codex") assert.equal(typeof e.appServerAvailable, "boolean");
      if (name === "antigravity") {
        assert.equal(typeof e.binPath, "string");
        assert.equal(typeof e.resolvedFrom, "string");
      }
      if (name === "delegate") assert.equal(typeof e.cliRunnable, "boolean");
    }
  }

  test("schema invariants hold for an all-ready doc (ready branch — authVerified still false)", () => {
    const doc = allReadyDoc();
    assert.equal(doc.allReady, true);
    assertSchemaInvariants(doc);
  });

  test("schema invariants hold for an all-not-ready doc (not-ready branch — proves 'iff' both ways)", () => {
    const doc = allNotReadyDoc();
    assert.equal(doc.allReady, false);
    // Every engine is not-ready, so the reason/deepFixCommand-non-null leg runs.
    for (const name of doc.checkedEngines) {
      assert.equal(doc.engines[name].status, "not-ready");
    }
    assertSchemaInvariants(doc);
  });

  test("exit code is 0 for a completed not-ready run", () => {
    const r = runDoctor(["--json", "--only", "codex"], {
      spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
      env: { HOME: "/tmp/fleet-noexist-home" },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(JSON.parse(r.stdout).engines.codex.status, "not-ready");
  });
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS, `ℹ fail 0` — these pin the contract already produced by Tasks 2-7; no implementation change is needed.

- [ ] Commit:
  ```bash
  git add tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  test(fleet-doctor): pin top-level schema — allReady, --only map, authVerified, invariants

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 9: human (non-json) output

Implements the default (no-`--json`) human-readable report so the CLI is friendly when run by hand. Each checked engine prints a one-line status using its `summary`; not-ready engines append the `deepFixCommand`. The report also prints an **auth-not-verified caveat** so the human output makes clear that `ready` means local prerequisites only and auth was never checked (mirroring the constant `authVerified: false`). Exit `0`.

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs` (replace the human-output placeholder in `runDoctor`).
- Test: `tests/fleet/fleet-doctor.test.mjs` (append).

**Interfaces:**
- Consumes: `runDoctor` assembly (Task 8); `EngineStatus.summary` / `status` / `deepFixCommand`.
- Produces: `renderHuman(doc)` returning a multi-line string including the auth caveat; `runDoctor` returns it as `stdout` when `--json` is absent.

Steps:

- [ ] Write the failing test. Append to `tests/fleet/fleet-doctor.test.mjs`:
  ```js
  test("human output: one line per engine, marks ready, routes not-ready, prints auth caveat", () => {
    const dataRoot = makeDataRoot();
    writeProfile(dataRoot, "work", { env: { ANTHROPIC_AUTH_TOKEN: "t" } });
    // codex ready (both probes status 0), antigravity missing, delegate ready.
    const spawn = (bin) =>
      bin === "agy"
        ? { error: { code: "ENOENT" }, status: null }
        : { status: 0, stdout: `${bin} 1.0\n`, stderr: "" };
    const r = runDoctor([], {
      spawnSyncImpl: spawn,
      existsSyncImpl: () => false, // antigravity resolves to bare "agy" → ENOENT
      env: { HOME: "/tmp/fleet-noexist-home", DELEGATE_PLUGIN_DATA: dataRoot },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /codex/);
    assert.match(r.stdout, /antigravity/);
    assert.match(r.stdout, /delegate/);
    // not-ready antigravity surfaces its deep-fix route.
    assert.match(r.stdout, /\/antigravity:setup/);
    // the auth-not-verified caveat must be present (ready != logged in).
    assert.match(r.stdout, /auth.*not.*(checked|verified)/i);
  });
  ```

- [ ] Run the test to verify it FAILS (human output is the empty placeholder):
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: FAIL — `r.stdout` is `""`, so `assert.match` throws. `ℹ fail 1`.

- [ ] Write minimal implementation. In `plugins/fleet/scripts/fleet-doctor.mjs`, add `renderHuman` and wire it into `runDoctor`. NOTE: the `✔`/`✘` glyphs below are illustrative only — spec §5.2/§5.4 leave most human output unconstrained and the test does NOT assert them, so an implementer may use plain ASCII (e.g. `[ok]`/`[--]`) without breaking the test; the ONLY pinned human substrings are the engine names, the not-ready `deepFixCommand`, and the auth caveat. The auth caveat line is a SINGLE physical line carrying both "auth" and "not checked" so the test regex `/auth.*not.*(checked|verified)/i` matches (RegExp `.` does not cross newlines):
  ```js
  function renderHuman(doc) {
    const lines = [];
    for (const name of doc.checkedEngines) {
      const e = doc.engines[name];
      if (e.status === "ready") {
        lines.push(`✔ ${name}: ${e.summary}`);
      } else {
        lines.push(`✘ ${name}: ${e.summary} — run ${e.deepFixCommand} yourself`);
      }
    }
    lines.push(doc.allReady ? "All checked engines are ready." : "Some engines need attention.");
    // Honest readiness: auth/login/token was NEVER verified (authVerified: false).
    // Keep "auth ... not checked" on ONE physical line (the test matches it with a
    // single-line regex; RegExp '.' does not match a newline).
    lines.push(
      "Note: auth was NOT checked — 'ready' means local prerequisites are present, not that the engine is logged in.",
    );
    lines.push("Run /<engine>:setup on first use to complete auth.");
    return lines.join("\n") + "\n";
  }
  ```
  Replace the human-output placeholder return in `runDoctor`:
  ```js
    if (parsed.json) {
      return { stdout: JSON.stringify(doc), stderr: "", exitCode: 0 };
    }
    return { stdout: renderHuman(doc), stderr: "", exitCode: 0 };
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS. `ℹ fail 0`.

- [ ] Commit:
  ```bash
  git add plugins/fleet/scripts/fleet-doctor.mjs tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet-doctor): human-readable default report + auth-not-verified caveat

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 10: error-path / spawn-failure hardening (guardrail task)

Confirms `fleet-doctor` never throws on a probe `{error}` (it is classified by the ordered rule, not an uncaught crash) across all three engines, pins the clause-2 leg for a non-ENOENT error-with-status (binary launched → `version-failed`), and that a usage error under `--json` is valid JSON the prompt can parse (so the prompt's "empty/non-JSON stdout = crash" heuristic stays correct). This is a **characterization/guardrail task: it pins already-passing behavior produced by Tasks 3-9 and has NO red step** — do not hunt for a missing RED.

**Files:**
- Test: `tests/fleet/fleet-doctor.test.mjs` (append).

**Interfaces:**
- Consumes: `runDoctor`, `probeBinary`.
- Produces: no new exports — pins error-path behavior from spec §7.

Steps:

- [ ] Write the contract-pinning test. Append to `tests/fleet/fleet-doctor.test.mjs`:
  ```js
  test("a probe ENOENT never throws — classified as missing across all engines", () => {
    const spawn = () => ({ error: { code: "ENOENT" }, status: null });
    const r = runDoctor(["--json"], {
      spawnSyncImpl: spawn,
      existsSyncImpl: () => false,
      env: { HOME: "/tmp/fleet-noexist-home" },
    });
    assert.equal(r.exitCode, 0);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.engines.codex.reason, "binary-missing");
    assert.equal(doc.engines.antigravity.reason, "binary-missing");
    assert.equal(doc.engines.delegate.reason, "cli-missing");
    assert.equal(doc.allReady, false);
  });

  test("clause 2: a non-ENOENT error with null status → version-failed (binary launched), not missing", () => {
    // EACCES is not ENOENT, so clause 1 does not match → clause 2 (version-failed).
    const r = runDoctor(["--json", "--only", "codex"], {
      spawnSyncImpl: () => ({ error: { code: "EACCES" }, status: null }),
      env: { HOME: "/tmp/fleet-noexist-home" },
    });
    assert.equal(r.exitCode, 0);
    const c = JSON.parse(r.stdout).engines.codex;
    assert.equal(c.reason, "version-failed");
    assert.equal(c.onPath, true);
  });

  test("clause 2: error truthy WITH a non-null status + non-ENOENT code → version-failed", () => {
    // Pins probeBinary (Task 3) so a future refactor cannot flip error-with-status to missing.
    const r = runDoctor(["--json", "--only", "codex"], {
      spawnSyncImpl: () => ({ error: { code: "EACCES" }, status: 1, stdout: "", stderr: "" }),
      env: { HOME: "/tmp/fleet-noexist-home" },
    });
    assert.equal(r.exitCode, 0);
    const c = JSON.parse(r.stdout).engines.codex;
    assert.equal(c.reason, "version-failed");
    assert.equal(c.onPath, true);
  });

  test("usage error under --json is parseable JSON with an error key (not a crash)", () => {
    const r = runDoctor(["--json", "--only", "nope"], {
      spawnSyncImpl: () => ({ status: 0, stdout: "v\n" }),
      env: { HOME: "/tmp/fleet-noexist-home" },
    });
    assert.equal(r.exitCode, 2);
    const parsed = JSON.parse(r.stdout); // must not throw
    assert.ok(typeof parsed.error === "string" && parsed.error.length > 0);
    assert.ok(!("engines" in parsed));
  });
  ```

- [ ] Run the test to verify it PASSES:
  ```bash
  node --test tests/fleet/fleet-doctor.test.mjs
  ```
  Expected: PASS, `ℹ fail 0` — these pin the error-path contract already produced by Tasks 3-9; no implementation change is needed.

- [ ] Commit:
  ```bash
  git add tests/fleet/fleet-doctor.test.mjs
  git commit -m "$(cat <<'EOF'
  test(fleet-doctor): error-path guardrails — probe {error} never throws

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 11: `commands/setup.md` authoring (GUIDE-ONLY) + expand `plugin-structure.test.mjs`

Replaces the Task 1 `setup.md` stub with the full prompt-driven, **GUIDE-ONLY** flow (spec §6) and expands `plugin-structure.test.mjs` to assert the prompt references `fleet-doctor.mjs` via the `${CLAUDE_PLUGIN_ROOT}` path convention, uses `AskUserQuestion`, pins the `Bash(node:*)` frontmatter allowed-tool, lists the three engines, enforces the §6.1 zero-selection stop guard, and — per the revised spec — **recommends the user run `/<engine>:setup` themselves** (with the `/plugin install <engine>@agent-fleet` fallback), prints the **auth-not-verified note** even when allReady, and includes the delegate real-smoke hint using the **real slash command** `/delegate:task "hello" --profile`. The prompt must NOT claim to run another slash command in-flow or consume its re-check output.

**Files:**
- Modify: `plugins/fleet/commands/setup.md` (replace stub), `tests/fleet/plugin-structure.test.mjs` (append assertions).

**Interfaces:**
- Consumes: `fleet-doctor.mjs` CLI surface (`--json --only <csv>`) and the §5.4 schema (Tasks 2-10).
- Produces: a `/fleet:setup` command whose body satisfies the structure assertions and matches the revised spec §6.

Steps:

- [ ] Write the failing test. Append to `tests/fleet/plugin-structure.test.mjs`. NOTE: the `re-run \`/fleet:setup\`` and `not.*(verified|checked)` assertions both rely on a SINGLE physical line in the body (RegExp `.` does not cross newlines, and the file is read whole by `fs.readFileSync`) — the Step-4 caveat and the Step-3.5 confirm sentence below are authored as un-wrapped single lines so these assertions match GREEN:
  ```js
  test("setup.md drives the GUIDE-ONLY flow per spec §6", () => {
    const text = fs.readFileSync(
      path.join(REPO_ROOT, "plugins/fleet/commands/setup.md"),
      "utf8",
    );
    assert.ok(text.startsWith("---"), "setup.md missing frontmatter");
    assert.match(text, /description:/, "missing description");
    // §6 frontmatter contract: both allowed-tools must be present.
    assert.match(text, /allowed-tools:.*Bash\(node:\*\)/, "must allow Bash(node:*)");
    assert.match(text, /AskUserQuestion/, "must use AskUserQuestion");
    // §4/§6.2 path convention: doctor invoked via ${CLAUDE_PLUGIN_ROOT}/scripts/...
    assert.match(
      text,
      /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/fleet-doctor\.mjs/,
      "must invoke fleet-doctor.mjs via ${CLAUDE_PLUGIN_ROOT}/scripts/",
    );
    assert.match(text, /fleet-doctor\.mjs/, "must reference fleet-doctor.mjs");
    assert.match(text, /--json/, "must invoke doctor with --json");
    assert.match(text, /--only/, "must invoke doctor with --only");
    // §6.1 HARD zero-selection guard: stop message + do-not-run-doctor + multi-select.
    assert.match(text, /nothing to set up/, "must carry the zero-selection stop message");
    assert.match(text, /multi-select/i, "must instruct a multi-select first question");
    assert.match(
      text,
      /do NOT (run|invoke)[^\n]*fleet-doctor/i,
      "must instruct NOT to run the doctor on zero selections",
    );
    // lists the three engines
    assert.match(text, /codex/);
    assert.match(text, /antigravity/);
    assert.match(text, /delegate/);
    // GUIDE-ONLY: routes each deep fix to the engine's OWN setup, run by the USER.
    assert.match(text, /\/codex:setup/);
    assert.match(text, /\/antigravity:setup/);
    assert.match(text, /\/delegate:setup/);
    // §6.3 plugin-not-installed fallback.
    assert.match(text, /\/plugin install <engine>@agent-fleet/);
    // §6.3 confirm-by-re-running guidance (single-line, backtick adjacent to "re-run ").
    assert.match(text, /re-run `\/fleet:setup`/);
    // §6.4 auth-not-verified note (even when allReady) — single physical line.
    assert.match(text, /not.*(verified|checked)/i, "must state auth was not verified");
    // §6.4 delegate real-smoke hint uses the REAL slash command.
    assert.match(text, /\/delegate:task "hello" --profile/);
    // GUIDE-ONLY guardrail: must NOT promise to invoke /<engine>:setup itself or
    // consume its re-check output. Pin the absence of the old in-flow phrasings.
    assert.doesNotMatch(text, /rely on its re-check output/i);
    assert.doesNotMatch(text, /delegate-companion\.mjs/);
  });
  ```

- [ ] Run the test to verify it FAILS. The Task 1 stub already ships `allowed-tools: Bash(node:*), AskUserQuestion` and a `description:`, so the new test does NOT fail on the AskUserQuestion / Bash(node:*) frontmatter assertions; it fails on the first genuinely-absent substring — `must invoke fleet-doctor.mjs via ${CLAUDE_PLUGIN_ROOT}/scripts/` (and, behind it, the `--json`/`--only` flags, the engine routes, the zero-selection guard, the install fallback, the `re-run \`/fleet:setup\`` confirm line, the auth note, and the `/delegate:task` hint):
  ```bash
  node --test tests/fleet/plugin-structure.test.mjs
  ```
  Expected: FAIL on the new test, first asserting `must invoke fleet-doctor.mjs via ${CLAUDE_PLUGIN_ROOT}/scripts/`. `ℹ fail 1`.

- [ ] Write the implementation. Replace the entire contents of `plugins/fleet/commands/setup.md` with the full GUIDE-ONLY flow. NOTE: the ONLY `node` invocation is the Step-2 fleet-doctor call via `${CLAUDE_PLUGIN_ROOT}`. The delegate hint is the REAL installed slash command `/delegate:task "hello" --profile <name> --json` (spec §6.4) — NOT a `node ... delegate-companion.mjs` invocation; the structure test pins the literal substring `/delegate:task "hello" --profile` and asserts `delegate-companion.mjs` is ABSENT. The prompt must NOT promise to run any other slash command in-flow. Two lines are authored as single un-wrapped physical lines so the single-line regexes (`re-run \`/fleet:setup\``, `not.*(verified|checked)`) match: the Step-3.5 confirm sentence and the Step-4 plain auth caveat:
  ```markdown
  ---
  description: Guided onboarding for the agent-fleet engines (pick the ones you want, fix only those)
  allowed-tools: Bash(node:*), AskUserQuestion
  ---

  You are guiding the user through getting the agent-fleet engines ready. Be
  Matt-Pocock-style: assume the user does not know the jargon, show sensible
  defaults, ask exactly ONE decision at a time, and never dump everything at once.
  Only ever check the engines the user picks.

  **This command is GUIDE-ONLY.** You run `fleet-doctor` exactly ONCE (Step 2) and
  you NEVER invoke another slash command yourself. For every gap you EXPLAIN the
  problem and RECOMMEND the user run `/<engine>:setup` themselves, then they re-run
  `/fleet:setup` to confirm. Do not claim to dispatch, run, or consume the output
  of any other slash command.

  ## Step 1 — Pick engines (do this FIRST)

  Your very first action is a single `AskUserQuestion` (multi-select) asking which
  engines the user wants to set up. Offer exactly these options (plain-language
  labels with the binary named):

  - `codex` — OpenAI Codex CLI (review / delegate tasks)
  - `antigravity` — Google Antigravity CLI (`agy`)
  - `delegate` — cheap-model headless Claude Code via profiles

  Only the chosen engines proceed.

  **If the user selects nothing:** do NOT run `fleet-doctor`. Print exactly:
  "nothing to set up — re-run `/fleet:setup` when you want to add an engine." and
  stop.

  ## Step 2 — Explore (run the doctor ONCE)

  Run this ONCE with the chosen engines comma-joined (canonical order does not
  matter — the doctor re-sorts). This is the ONLY time you invoke fleet-doctor:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-doctor.mjs" --json --only <comma-joined-chosen-engines>
  ```

  Parse the JSON from stdout. If stdout is empty or is not valid JSON, the check
  could not run: tell the user plainly, show the raw stderr, and suggest
  re-running `/fleet:setup`. (A usage error still returns a JSON `{"error": ...}`
  object — surface its `error` message; that is not a crash.)

  Remember: every engine's `authVerified` is `false`. Even `allReady: true` does
  NOT mean the engines are logged in. If `allReady` is `true`, skip to Step 4
  (which must still print the auth caveat).

  ## Step 3 — Explain + RECOMMEND the user-run fix, one decision at a time

  For each `not-ready` engine, in the order they appear in `checkedEngines`:

  1. Explain the gap in plain language from `summary` / `reason`
     (e.g. "Codex isn't installed yet — that's the OpenAI CLI this plugin drives.",
     or for `app-server-failed`: "Codex is installed but its app-server interface
     isn't responding, so it's not fully ready yet.").
  2. Ask ONE `AskUserQuestion` to decide whether the user wants guidance to fix
     THIS engine now. Options: `Show me how to fix <engine> (Recommended)` /
     `Skip <engine>`. Do not ask about the next engine until this one is resolved.
  3. On "show me how," GUIDE the user — state the gap and tell them the exact
     slash command THEY should run themselves. Do NOT invoke that command and do
     NOT wait on or consume its output:
     - **codex** (`binary-missing` / `version-failed` / `app-server-failed`):
       recommend the user run `/codex:setup` themselves (it offers
       `npm install -g @openai/codex`, re-checks, and preserves `!codex login`
       guidance). For `app-server-failed`, explain that `codex --version` worked
       but `codex app-server --help` did not, so codex is installed but not fully
       wired up — `/codex:setup` is still the right place to repair it. Do not
       install codex or run `codex login` yourself.
     - **antigravity** (`binary-missing` / `version-failed`): if `binary-missing`,
       tell the user to install from the engine's `installUrl`
       (`https://antigravity.google/download`), then run `/antigravity:setup`
       themselves. If `version-failed`, mention the resolved `binPath` /
       `resolvedFrom` so they know which binary failed, then point them at
       `/antigravity:setup`. Never run `agy --print` yourself.
     - **delegate** (`cli-missing` / `cli-version-failed` / `no-profiles` /
       `no-valid-profiles`): recommend the user run `/delegate:setup` themselves.
       For `no-valid-profiles`, surface the specific `profiles[].error`
       (`invalid-name` / `unparseable-json` / `non-scalar-env`) and the offending
       `name` so the user knows which file to fix, then tell them to run
       `/delegate:setup`.
  4. **Plugin-not-installed fallback.** If the engine's plugin may not be installed
     (its `/<engine>:setup` slash command does not exist in this session), tell the
     user to FIRST run `/plugin install <engine>@agent-fleet`, THEN `/<engine>:setup`.
  5. **Confirm by re-running.** After guiding, tell the user to re-run `/fleet:setup` once they have finished the deep fix, to confirm the engine is now `ready`. Do NOT re-run `fleet-doctor` — Step 2 was its only invocation, and you do not consume any nested re-check output.

  On `Skip <engine>`, leave it `not-ready`, continue to the next engine, and list
  it in the final summary. No nagging, no auto-retry, no in-flow dispatch.

  ## Step 4 — Ready-summary

  Print a compact summary: for each chosen engine, either `ready` or
  `still not-ready (run /<engine>:setup yourself, then re-run /fleet:setup)`.

  **Auth caveat (ALWAYS print, even when every engine is `ready`).** Tell the user plainly: auth was NOT verified by fleet-doctor, so `ready` means local prerequisites only — not that the engine is logged in or usable right now. Because `fleet-doctor` never verifies auth (`authVerified: false` on every engine), on first use the user should run the engine's own setup to complete auth:
  - codex → `/codex:setup` (guides `codex login`),
  - antigravity → `/antigravity:setup` (runs the OAuth flow),
  - delegate → `/delegate:setup` (the token lives in each profile's `env`;
    `fleet-doctor` only checked shape, never the token).

  Do NOT present `ready` as "usable now."

  **When `delegate` is `ready`** (claude CLI present + ≥1 valid profile),
  additionally print this manual real-smoke one-liner as an informational hint,
  using the REAL installed slash command and substituting `firstValidProfile`
  for `<name>`:

  ```text
  /delegate:task "hello" --profile <name> --json
  ```

  This is a hint the user may run manually. Never run it yourself — that would be
  a real-API smoke, which is out of scope.
  ```

- [ ] Run the test to verify it PASSES. (Confirm GREEN before committing — the `re-run \`/fleet:setup\`` and `not.*(verified|checked)` assertions both depend on the single-line authoring of the Step-3.5 confirm sentence and the Step-4 plain auth caveat above.):
  ```bash
  node --test tests/fleet/plugin-structure.test.mjs
  ```
  Expected: PASS. `ℹ fail 0` (3 tests in plugin-structure).

- [ ] Commit:
  ```bash
  git add plugins/fleet/commands/setup.md tests/fleet/plugin-structure.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(fleet): author GUIDE-ONLY /fleet:setup flow + structure assertions

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 12: README fleet row + install instructions + full-suite green (closing verification)

Adds the single `fleet` row to the README plugin table AND the `/plugin install fleet@agent-fleet` install instructions plus the engine-plugin-dependency note (both within the allowed README scope), then runs the entire `npm test` suite (now including `test:fleet`) as the closing verification gate.

**Files:**
- Modify: `README.md` (line 9 area — insert one table row after the `delegate` row; and the Install section around lines 18-23).

**Interfaces:**
- Consumes: everything (final integration).
- Produces: nothing new — final wiring + green suite.

Steps:

- [ ] Add the `fleet` row to the `README.md` plugin table. Insert this line immediately after the `delegate` row (current line 9):
  ```
  | `fleet` | `/fleet:setup` | Guided onboarding — pick the engines you want, check readiness, then guide each deep fix to that engine's `/<engine>:setup` (the recommended starting point) |
  ```

- [ ] Update the README Install section to add `/plugin install fleet@agent-fleet` and note the engine-plugin dependency. Replace the existing install block:
  ```bash
  /plugin marketplace add audichuang/agent-fleet-cc
  /plugin install codex@agent-fleet
  /plugin install antigravity@agent-fleet
  /plugin install delegate@agent-fleet
  /reload-plugins
  ```
  with:
  ```bash
  /plugin marketplace add audichuang/agent-fleet-cc

  # Recommended starting point — install fleet and run the guided onboarding:
  /plugin install fleet@agent-fleet
  /fleet:setup

  # fleet only *guides* the deep fixes; install the engine plugins you chose so
  # their /<engine>:setup commands exist:
  /plugin install codex@agent-fleet
  /plugin install antigravity@agent-fleet
  /plugin install delegate@agent-fleet
  /reload-plugins
  ```
  (Exact prose/formatting is at the implementer's discretion, but the README MUST mention `/plugin install fleet@agent-fleet` and state that the engine plugins must also be installed for `/<engine>:setup` to exist.)

- [ ] Run the full test suite to verify everything is green:
  ```bash
  npm test
  ```
  Expected: PASS for every sub-suite. The final `test:fleet` run shows `ℹ pass` covering all `tests/fleet/*.test.mjs` tests and `ℹ fail 0`; the overall `npm test` exits `0`.

- [ ] Run the fleet suite alone once more to confirm the per-engine glob works under the shell:
  ```bash
  npm run test:fleet
  ```
  Expected: PASS — `node --test "tests/fleet/*.test.mjs"` runs both `fleet-doctor.test.mjs` and `plugin-structure.test.mjs`, `ℹ fail 0`.

- [ ] Commit:
  ```bash
  git add README.md
  git commit -m "$(cat <<'EOF'
  docs(readme): add fleet row + /plugin install fleet@agent-fleet install instructions

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  EOF
  )"
  ```
