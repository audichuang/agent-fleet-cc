# /fleet:setup — guided fleet onboarding

A prompt-driven `/fleet:setup` command that asks which engine plugins you want, runs cheap network-free readiness checks, then guides you to fix only the gaps for the engines you chose — one decision at a time.

## 1. Summary

`/fleet:setup` is a new minimal `fleet` plugin that gives a single, friendly entry point to get the agent-fleet engines (`codex`, `antigravity`, `delegate`) ready to use. It is **user-choice-first**: the first thing it does is ask which engines you want (multi-select), and it only checks and fixes the ones you pick — "不一定要一開始都安裝好。" A deterministic helper, `fleet-doctor.mjs`, runs cheap, network-free checks (binary-on-PATH + `--version`, plus local profile validation for `delegate`); every deeper fix (auth, OAuth, install) is routed to the engine's own existing `/<engine>:setup` command. No real-API smoke is ever run by the tooling.

## 2. Goals / Non-goals

### Goals
- One guided command to get a **chosen subset** of fleet engines ready.
- Matt-Pocock-style flow: explore → explain in plain language → ask **one** decision at a time → guide the fix → confirm → done summary.
- A self-contained, deterministic readiness checker (`fleet-doctor.mjs`) with a stable `--json` contract, an `--only <csv>` filter, and a human-readable default output.
- Hermetic, fast, network-free tests via a spawn seam.

### Non-goals (YAGNI — explicitly excluded)
- **No real-API smoke.** The tooling never sends a live request to any engine. The only "smoke" is a manual, informational one-liner printed for `delegate` when it is ready (see §6.4).
- **No auth/login probing in `fleet-doctor`.** Auth state for all three engines requires a network round-trip; probing it would contradict "no real-API smoke." Auth is always routed to the engine's own `/<engine>:setup`.
- **No modification of sibling plugins.** `plugins/codex/`, `plugins/antigravity/`, `plugins/delegate/`, `tests/codex/`, `tests/antigravity/`, `tests/delegate/` are untouched (see §9 ironclad rule).
- **No `fleet-doctor` import of / path-coupling to sibling plugins.** It checks dependencies directly; it does not `import` or reach into `plugins/<engine>/`.
- **No separate "verify mode" / no `fleet-doctor verify` subcommand.** `fleet-doctor` has exactly one behavior (run the checks); modes are expressed only via `--json` and `--only`.
- **No background jobs, no state store, no watchdog.** `fleet` is a stateless, read-only checker plus a prompt.
- **No caching of check results.** Every invocation re-checks from scratch.

## 3. Locked decisions (recap)

- **Scope:** fleet-wide across all three engine plugins, but the user picks a **subset**.
- **Form (Approach A):** a new minimal plugin `plugins/fleet/` = `commands/setup.md` (prompt-driven) + `scripts/fleet-doctor.mjs` (deterministic checks; `--json`, `--only <list>`, hermetic spawn seam).
- **`fleet-doctor` is self-contained:** checks dependencies directly; does not import or path-couple to sibling plugins. Deep fixes route to each plugin's existing `/<plugin>:setup`.
- **Checks are cheap, deterministic, network-free:**
  - `codex`: `codex` on PATH + `codex --version`.
  - `antigravity`: `agy` on PATH + `agy --version`.
  - `delegate`: `claude` runnable (override binary via `DELEGATE_CLAUDE_BIN`) + `claude --version`, **plus** local profile validation (parse `profiles/*.json`; an `env` block, if present, must be scalar-only).
- **Auth is never probed by `fleet-doctor`** — always routed to `/<engine>:setup`.
- **When `delegate` is ready** (claude CLI present + ≥1 valid profile), the `/fleet:setup` summary prints the manual real-smoke one-liner as an informational hint:
  `node plugins/delegate/scripts/delegate-companion.mjs task "hello" --profile <name> --json`

## 4. Architecture: `plugins/fleet/` layout

```
plugins/fleet/
  .claude-plugin/
    plugin.json            # { "name": "fleet", "version": "0.1.0", "description": "..." }
  commands/
    setup.md               # prompt-driven /fleet:setup (the guided flow)
  scripts/
    fleet-doctor.mjs       # deterministic, network-free readiness checks; --json / --only; spawn seam
```

- `plugin.json` uses the minimal shape `{ name, version, description }` and matches the marketplace entry's `name` + `version` exactly (see §9).
- `/fleet:setup` resolves to the `fleet` plugin's `commands/setup.md`. Inside that command, `fleet-doctor.mjs` is invoked via `node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-doctor.mjs" ...` (the same `${CLAUDE_PLUGIN_ROOT}` convention used by the sibling setup commands).

## 5. Component: `scripts/fleet-doctor.mjs`

### 5.1 Responsibilities
- Run cheap, deterministic, **network-free** readiness checks for some or all of the three engines.
- Emit a stable machine-readable report (`--json`) for the prompt to consume, and a friendly human report by default.
- Be **self-contained**: it knows the three engines' check recipes inline; it does **not** `import` sibling-plugin code, and it does **not** depend on sibling plugins being installed.
- **Never** probe auth/login/OAuth and **never** make a network call.

### 5.2 CLI surface
- `node scripts/fleet-doctor.mjs` — checks all three engines; prints human-readable output to stdout.
- `node scripts/fleet-doctor.mjs --json` — prints a single JSON document (schema in §5.4) to stdout; no human prose.
- `node scripts/fleet-doctor.mjs --only <csv>` — restricts checks to the named engines. `<csv>` is a comma-separated subset of `codex,antigravity,delegate` (e.g. `--only codex,delegate`). Combine freely with `--json`.
- Unknown flags or an unknown engine name in `--only` are errors (see §7).

**Exit codes:**
- `0` — a check run completed (regardless of the readiness verdict). The readiness verdict lives in the JSON (`allReady` + per-engine `status`), which is what the prompt reads. Exit `0` is emitted whether engines are `ready` or `not-ready`.
- `2` — usage/argument error (unknown flag, unknown engine in `--only`, empty `--only`).

There is no exit `1` "not-ready" code: the readiness result is never expressed through the exit status. There is no other subcommand or mode. `--json` and `--only` are the only flags.

**Error output contract:** Under `--json`, `fleet-doctor` **always** emits a JSON object to stdout — even for usage errors, where it writes `{"error": "<message>"}` (e.g. `{"error":"unknown engine: foo; allowed: codex,antigravity,delegate"}`) to stdout and exits `2`. Without `--json`, a usage error writes a plain-text message to **stderr** and nothing to stdout, then exits `2`. The prompt always invokes with `--json`, so it only ever parses JSON from stdout (see §7).

### 5.3 Per-engine checks (exact recipes)

Each engine produces one status object. A check is performed by the injectable spawn seam (§5.5), never by a bare `child_process` call.

**Probe invocation (all engines).** Every binary probe is:

```
spawnSyncImpl(binary, ['--version'], { encoding: 'utf8', timeout: 5000, input: '' })
```

`input: ''` closes stdin so a binary that reads stdin cannot hang the doctor; `timeout: 5000` (5000 ms) bounds a hung `--version`. No `cwd` is set (inherits the process cwd).

**Probe-result detection table (uniform across all engines).** From a single probe result `r = spawnSyncImpl(binary, ['--version'], …)`:

| Condition | onPath / cliRunnable | reason | version |
|---|---|---|---|
| `r.error` truthy with `code === 'ENOENT'`, or `r.error` truthy and `r.status == null` | `false` | `binary-missing` / `cli-missing` | `null` |
| `r.error` truthy with `code === 'ETIMEDOUT'`, or `r.signal` set, or (`r.error` absent and `r.status !== 0`) | `true` for codex/antigravity (`onPath`); `false` for delegate (`cliRunnable`, see below) | `version-failed` / `cli-version-failed` | `null` |
| `r.error` absent and `r.status === 0` | `true` | `null` (ready leg) | first trimmed non-empty line of `r.stdout` |

A timeout (`r.error.code === 'ETIMEDOUT'`) or a signal (`r.signal`) maps to `version-failed` / `cli-version-failed` — it is never a crash.

The boolean is derived **purely from the probe result** (ENOENT ⇒ not found; status 0 ⇒ found-and-runnable) — `fleet-doctor` does **not** do a separate `command -v` / PATH lookup. For all three engines the binary is found-or-not by whether `spawnSyncImpl` could launch it. "On PATH" is therefore shorthand for "the configured binary was resolvable and spawnable" (for delegate the binary may be an absolute path via `DELEGATE_CLAUDE_BIN`, so the `cliRunnable` name is used instead of `onPath`).

**codex**
- Run `codex --version` via the seam.
- `ready` iff `codex --version` exits `0` (per the detection table); `onPath: true`, `version` = first trimmed non-empty stdout line.
- `not-ready` reasons: `binary-missing` (ENOENT ⇒ `onPath: false`, `version: null`) or `version-failed` (launched but non-zero/timeout/signal ⇒ `onPath: true`, `version: null`).
- Deep-fix route: `/codex:setup`. Auth (if needed later) is handled there via `!codex login` — **not** by `fleet-doctor`.

**antigravity**
- Run `agy --version` via the seam. (Mirrors `plugins/antigravity/scripts/smoke.sh`: `command -v agy` + `agy --version`. The engine itself resolves `$AGY_BIN → PATH → ~/.local/bin/agy` at runtime; `fleet-doctor` only attempts to spawn `agy` and reports the install URL when the spawn yields ENOENT.)
- `ready` iff `agy --version` exits `0`; `onPath: true`, `version` populated.
- `not-ready` reasons: `binary-missing` (`onPath: false`, `installUrl: "https://antigravity.google/download"`) or `version-failed` (`onPath: true`).
- Deep-fix route: `/antigravity:setup` (runs the interactive OAuth via `agy --print`). **No auth probe** in `fleet-doctor` — `agy --print` would trigger a network OAuth flow.

**delegate**
- Resolve the CLI binary name: `DELEGATE_CLAUDE_BIN ?? "claude"`. Run `<binary> --version` via the seam.
- **`cliRunnable` semantics:** `cliRunnable: true` iff `<binary> --version` exited `0`. For `cli-missing` (ENOENT) and `cli-version-failed` (launched but non-zero/timeout/signal), `cliRunnable: false` and `cliVersion: null`. Both not-ready legs set `cliRunnable: false` for the readiness gate; `cli-version-failed` differs from `cli-missing` only in that the binary **was** found and spawned (it just failed `--version`).
- Validate local profiles (no network):
  - `dataRoot = DELEGATE_PLUGIN_DATA ?? CLAUDE_PLUGIN_DATA ?? <HOME>/.claude/plugins/data/delegate/`, where `<HOME>` is expanded from `deps.env.HOME` (falling back to `process.env.HOME`) — **not** `os.homedir()` — so the test `HOME` redirect is honored hermetically (§5.5, §8).
  - Enumerate `dataRoot/profiles/*.json`. The **profile name is the `.json` file basename** with the extension stripped (there is **no** in-file `name` field; the name is always the basename).
  - For each discovered file, in order:
    1. **Name check:** apply `PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/` to the basename. A basename that fails the regex (e.g. begins with `.`, `_`, or `-`, or contains a space) yields `error: "invalid-name"`, and the file is **skipped before JSON parse**.
    2. **Parse check:** otherwise read and `JSON.parse` the file; a parse failure yields `error: "unparseable-json"`.
    3. **Env-scalar check:** otherwise, if a top-level `env` object is present, **every** value must be a scalar (`string` | `number` | `boolean` | `null`); any nested object or array yields `error: "non-scalar-env"`.
  - A profile is **valid** iff it passes all applicable checks (`error: null`). (These rules mirror `plugins/delegate/scripts/lib/profiles.mjs`, re-implemented inline so `fleet-doctor` stays self-contained — it does not import that module. Note: the real `listProfiles` enumerates `*.json` and does not regex-check discovered basenames; `fleet-doctor` adds the basename regex check explicitly so a leading-`.`/`_`/`-` or space-bearing filename is reported as `invalid-name` rather than silently parsed.)
- **Readiness gate:** `ready` iff `cliRunnable` (`--version` exits `0`) **and** there is **≥1 valid profile**.
- `not-ready` reasons: `cli-missing` / `cli-version-failed` (CLI not runnable), `no-profiles` (zero `.json` files found), `no-valid-profiles` (files exist but none valid). When the CLI works but profiles are the problem, `cliVersion` is still populated.
- Deep-fix route: `/delegate:setup` (the `delegate-companion.mjs setup` verb does this same CLI + profile check and walks profile creation). Auth lives inside each profile's `env` (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`); `fleet-doctor` only checks shape, never tests the token.

`fleet-doctor` does **not** read sibling plugin code to learn these recipes — they are encoded directly in `fleet-doctor.mjs`.

### 5.4 Exact `--json` output schema

`--json` prints **one** JSON object to stdout. Top-level shape:

```json
{
  "checkedEngines": ["codex", "antigravity", "delegate"],
  "allReady": false,
  "engines": {
    "codex":       { /* EngineStatus */ },
    "antigravity": { /* EngineStatus */ },
    "delegate":    { /* EngineStatus */ }
  }
}
```

- `checkedEngines` (`string[]`): the engines actually checked this run, **always** in canonical order `codex, antigravity, delegate` regardless of the order tokens appear in `--only`; duplicate tokens are deduped. The `engines` map contains **exactly** these keys (engines excluded by `--only` are absent, not present-with-null).
- `allReady` (`boolean`): `true` iff every entry in `checkedEngines` has `status === "ready"`.
- `engines` (`object`): map of engine name → `EngineStatus`. The keys are inserted in canonical order (`codex`, `antigravity`, `delegate`) filtered by `--only`; consumers MUST index by key and MUST NOT rely on key order.

(There is no `schemaVersion` field. The prompt and the script ship and are tested together; a version stamp is unnecessary. A one-line code comment in `fleet-doctor.mjs` documents the shape if needed.)

**`EngineStatus` (common fields, every engine):**
- `engine` (`string`): one of `"codex" | "antigravity" | "delegate"`.
- `status` (`string`): `"ready" | "not-ready"`.
- `reason` (`string | null`): machine code for the gap when `not-ready`; `null` when `ready`. Enumerated per engine:
  - codex: `"binary-missing" | "version-failed"`
  - antigravity: `"binary-missing" | "version-failed"`
  - delegate: `"cli-missing" | "cli-version-failed" | "no-profiles" | "no-valid-profiles"`
- `summary` (`string`): one human-readable sentence (always present). The exact strings are **free-form and NOT contract-tested** — the structure test (§8) asserts only that `summary` is a non-empty string. The canonical phrasings below are the recommended defaults the prompt surfaces in §6.3; an implementer may reword them without breaking tests:

  | engine | status / reason | canonical `summary` |
  |---|---|---|
  | codex | ready | `codex CLI ready (<version>)` |
  | codex | binary-missing | `codex not found on PATH — install the OpenAI Codex CLI` |
  | codex | version-failed | `codex found but 'codex --version' failed` |
  | antigravity | ready | `agy CLI ready (<version>)` |
  | antigravity | binary-missing | `agy not found on PATH — install from https://antigravity.google/download` |
  | antigravity | version-failed | `agy found but 'agy --version' failed` |
  | delegate | ready | `delegate ready (<binaryName> <cliVersion>, <validProfileCount> valid profile(s))` |
  | delegate | cli-missing | `<binaryName> CLI not found — delegate needs the claude CLI` |
  | delegate | cli-version-failed | `<binaryName> found but '--version' failed` |
  | delegate | no-profiles | `claude CLI ready but no profiles found in <profilesDir>` |
  | delegate | no-valid-profiles | `claude CLI ready but no valid profiles (fix the listed file(s))` |

- `deepFixCommand` (`string | null`): the slash command to run for a deep fix when `not-ready`; `null` when `ready`. Per engine: `"/codex:setup"`, `"/antigravity:setup"`, `"/delegate:setup"`.

**codex `EngineStatus` adds:**
- `binaryName` (`string`): `"codex"`.
- `onPath` (`boolean`): whether `codex` was resolvable/spawnable (see §5.3). `version-failed` ⇒ `onPath: true`; `binary-missing` ⇒ `onPath: false`.
- `version` (`string | null`): trimmed first non-empty line of `codex --version`, or `null`.

**antigravity `EngineStatus` adds:**
- `binaryName` (`string`): `"agy"`.
- `onPath` (`boolean`): whether `agy` was resolvable/spawnable (see §5.3). `version-failed` ⇒ `onPath: true`; `binary-missing` ⇒ `onPath: false`.
- `version` (`string | null`): trimmed first non-empty line of `agy --version`, or `null`.
- `installUrl` (`string`): `"https://antigravity.google/download"` (constant; useful when `binary-missing`).

**delegate `EngineStatus` adds:**
- `binaryName` (`string`): value of `DELEGATE_CLAUDE_BIN ?? "claude"`.
- `cliRunnable` (`boolean`): `true` iff `<binary> --version` exited `0`. `cli-missing` ⇒ `false`; `cli-version-failed` ⇒ `false` (but the binary was found — see §5.3). (Named `cliRunnable`, not `cliOnPath`, because the binary may be an absolute path via `DELEGATE_CLAUDE_BIN` and so need not be "on PATH"; the field tracks the readiness gate, which is `--version` success.)
- `cliVersion` (`string | null`): trimmed first non-empty line of `<binary> --version`, or `null`.
- `dataRoot` (`string`): the resolved profiles data root (absolute path). `profilesDir` is derivable as `<dataRoot>/profiles` and is **not** emitted as a separate field.
- `profiles` (`array`): one object **per INVALID discovered `.json` file only** (valid profiles are not enumerated — the prompt never reads per-file detail for valid profiles). Each entry:
  - `name` (`string`): file basename without `.json`.
  - `error` (`string`): why it is invalid — `"invalid-name" | "unparseable-json" | "non-scalar-env"`. (Always set; the array contains only invalid profiles, so there is no `valid` boolean and no `null` error.)
- `validProfileCount` (`number`): count of valid profiles discovered.
- `firstValidProfile` (`string | null`): name of the first valid profile in basename-sorted order (used by the prompt to fill the real-smoke hint), or `null`.

> **Note (delegate companion projection is unrelated).** This `fleet-doctor` schema is distinct from the delegate companion's own `--json` `resultProjection`. That projection lists these fields verbatim: `{engine, jobId, status, resultText, sessionId, exitCode, error, errorKind, durationMs}` — a **9-field** shape (the LOCKED decision's "10-field" wording is an off-by-one count discrepancy in the source note; the verified shape in `delegate-companion.mjs` is exactly the 9 fields listed). This spec uses the verified count of **9**. `fleet-doctor` does **not** reuse or import that projection regardless of its exact count; it has its own readiness-oriented shape defined above.

### 5.5 Spawn seam (hermetic tests)

- `fleet-doctor.mjs` exposes a pure entry function `runDoctor(argv, deps = {})`, where `deps` includes an injectable spawn function (`deps.spawnSyncImpl ?? spawnSync`) and an injectable environment (`deps.env ?? process.env`, honoring `DELEGATE_PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA` / `DELEGATE_CLAUDE_BIN` / `HOME`).
- All binary probes (`codex --version`, `agy --version`, `<delegate-binary> --version`) go through `deps.spawnSyncImpl` so tests can stub presence/absence and exit codes **without any real binary**. This matches the delegate companion's `deps.spawnSyncImpl` convention in `cmdSetup`.
- The delegate `dataRoot` is computed from `deps.env` (with the `~`/`<HOME>` expansion taken from `deps.env.HOME`, falling back to `process.env.HOME`), so tests that pass an explicit `env` object are fully isolated from the ambient process environment.
- The CLI wrapper (`if (import.meta.url === ...)` / `main()`) calls `runDoctor(process.argv.slice(2))` with no `deps`, defaulting to the real `spawnSync` and `process.env`.

## 6. Component: `commands/setup.md` (the `/fleet:setup` flow)

Prompt-driven command. Frontmatter: `description: Guided onboarding for the agent-fleet engines (pick the ones you want, fix only those)`; `allowed-tools: Bash(node:*), AskUserQuestion`. The body instructs the model through the steps below. The guiding principle is Matt-Pocock-style: assume the user doesn't know the jargon, show sensible defaults, ask **one** decision at a time, and never dump everything at once. Give an explicit `/<engine>:setup` pointer only for the hard deep-fixes.

### 6.1 Step 1 — Pick engines (user-choice-first, HARD requirement)

The **very first** action is a single `AskUserQuestion` (multi-select) asking which engines the user wants to set up. Options (plain-language labels, with the binary named):
- `codex` — OpenAI Codex CLI (review / delegate tasks)
- `antigravity` — Google Antigravity CLI (`agy`)
- `delegate` — cheap-model headless Claude Code via profiles

Only the chosen engines proceed.

**On zero selections, do NOT invoke `fleet-doctor` at all.** Print the friendly stop message — "nothing to set up — re-run `/fleet:setup` when you want to add an engine." — and end. `fleet-doctor` is only ever called with a **non-empty** `--only` list, which is why empty `--only` is a usage error (exit `2`) at the CLI layer (§5.2, §7) — the prompt never produces it.

### 6.2 Step 2 — Explore (run the doctor)

Run, once, with the chosen subset:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-doctor.mjs" --json --only <comma-joined-chosen-engines>
```

Parse the JSON. Do **not** re-run per engine. If `allReady` is `true`, skip straight to the ready-summary (§6.4). This Step-2 call is the **only** `fleet-doctor` invocation in the flow.

### 6.3 Step 3 — Explain + guided fix, one decision at a time

For each `not-ready` engine (in canonical order), the prompt:
1. **Explains the gap in plain language** from `summary` / `reason` (e.g. "Codex isn't installed yet — that's the OpenAI CLI this plugin drives.").
2. Asks **one** `AskUserQuestion` to decide whether to fix this engine now (options like `Fix <engine> now (Recommended)` / `Skip <engine>`). Only one engine is in flight at a time; the next engine's question is not asked until the current one is resolved.
3. On "fix now," **guides the fix** with the exact command, routing every deep fix to the engine's own `/<engine>:setup`:

**codex** (`binary-missing` / `version-failed`):
- Route: run `/codex:setup`. (That command itself offers to `npm install -g @openai/codex` via its own one-time `AskUserQuestion`, then re-checks, and preserves `!codex login` guidance if installed-but-unauthenticated.)
- `/fleet:setup` does **not** install codex or run `codex login` itself — it hands off to `/codex:setup`.

**antigravity** (`binary-missing` / `version-failed`):
- If `binary-missing`: tell the user to install from `installUrl` (`https://antigravity.google/download`), then run `/antigravity:setup`.
- Route auth/OAuth entirely to `/antigravity:setup` (it triggers the interactive OAuth via `agy --print`). `/fleet:setup` never runs `agy --print` itself.

**delegate** (`cli-missing` / `cli-version-failed` / `no-profiles` / `no-valid-profiles`):
- Route: run `/delegate:setup` (which re-runs the same CLI + profile check and walks profile creation: a standard Claude Code settings JSON at `<dataRoot>/profiles/<name>.json` whose `env` block carries `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `model`).
- For `no-valid-profiles`, surface the specific `profiles[].error` (`invalid-name` / `unparseable-json` / `non-scalar-env`) and the offending `name` so the user knows which file to fix, then hand off to `/delegate:setup`.

4. **Confirm**: rely on the routed `/<engine>:setup`'s own re-check output to confirm the fix (codex and delegate setup commands re-check by design; antigravity is reactive). `/fleet:setup` does **not** re-run `fleet-doctor` — the Step-2 call (§6.2) is the doctor's only invocation in the flow.

### 6.4 Step 4 — Ready-summary

After all chosen engines are resolved, print a compact summary: for each chosen engine, `ready` or `still not-ready (run /<engine>:setup)`.

**When `delegate` is `ready`** (claude CLI present + ≥1 valid profile), additionally print the manual real-smoke one-liner as an informational hint, substituting `firstValidProfile` for `<name>`:

```bash
node plugins/delegate/scripts/delegate-companion.mjs task "hello" --profile <name> --json
```

This is a hint the user may run manually; `/fleet:setup` never runs it (that would be a real-API smoke, which is out of scope).

## 7. Error handling

- **Missing binary** (`codex` / `agy` / `claude`): not a crash — `fleet-doctor` reports `status: "not-ready"` with `reason: "binary-missing"` / `"cli-missing"`, `onPath`/`cliRunnable: false`, and a `summary`. For antigravity, `installUrl` is included. The prompt explains and routes to `/<engine>:setup`. (Detection: `spawnSyncImpl` returns `r.error` with `code === 'ENOENT'`, or `r.error` truthy with no `r.status` — see §5.3.)
- **`--version` fails despite binary present** (non-zero exit, timeout, or signal): `reason: "version-failed"` / `"cli-version-failed"`; `onPath: true` (codex/antigravity) / `cliRunnable: false` (delegate); treated as `not-ready`. Same routing.
- **Invalid / zero profiles (delegate)**: zero `.json` → `reason: "no-profiles"`; files present but none valid → `reason: "no-valid-profiles"` with per-invalid-file `profiles[].error`. CLI section still reported independently (so the user sees "CLI fine, profiles are the problem").
- **`fleet-doctor` spawn failure** (e.g. `node` itself fails, or the script throws): the prompt detects **empty or non-JSON stdout** (or a thrown error) and tells the user plainly that the readiness check couldn't run, shows the raw stderr, and suggests re-running `/fleet:setup`. Because the prompt always passes `--json`, a usage error (exit `2`) still emits a JSON `{"error": …}` object to stdout (§5.2), so the prompt's "empty/non-JSON stdout = crash" heuristic stays correct — a usage error is parsed as JSON and surfaced as its `error` message, never misclassified as a crash. Inside `fleet-doctor`, a `spawnSyncImpl` returning `{error}` for a probe is handled as "binary not runnable," not an uncaught throw — only genuinely unexpected errors propagate (exit non-zero / throw).
- **User declines a fix** (chooses `Skip <engine>`): that engine is left `not-ready`; the flow continues to the next engine and the final summary lists it as `still not-ready (run /<engine>:setup)`. No nagging, no auto-retry.
- **Unknown engine in `--only`** (or empty `--only`, or an unknown flag): `fleet-doctor` exits `2`. Under `--json` it writes `{"error": "unknown engine: <name>; allowed: codex,antigravity,delegate"}` (or the analogous empty/`unknown-flag` message) to stdout; without `--json` it writes the plain-text message to stderr. The prompt only ever passes engines it sourced from the Step-1 multi-select, so this is primarily a guardrail for direct CLI use.

## 8. Testing — `tests/fleet/` hermetic suite

New directory `tests/fleet/`, run by `npm run test:fleet` (`node --test "tests/fleet/*.test.mjs"`, glob quoted so node — not the shell — expands it, robust under fish/zsh).

**Hermetic conventions** mirror the existing per-plugin suites, with one load-bearing ordering rule:

- A `helpers.mjs` is imported **first**. It **FIRST** strips ambient `ANTHROPIC_*` / `CLAUDE_*` / `CLAUDECODE*` / `DELEGATE_*` env, **THEN** sets the temp-dir values for `HOME` and `DELEGATE_PLUGIN_DATA` (and, when a test exercises it, `DELEGATE_CLAUDE_BIN`). The redirect always runs **after** the strip so the test-controlled values win — the strip pattern `DELEGATE_*` / `CLAUDE_*` would otherwise erase the very vars (`DELEGATE_PLUGIN_DATA`, `DELEGATE_CLAUDE_BIN`, `CLAUDE_PLUGIN_DATA`) the test needs.
- **Mechanism:** unit tests drive `runDoctor(argv, { spawnSyncImpl, env })` and pass an **explicit `env` object** as `deps.env`; this bypasses `process.env` entirely, so the suite controls `HOME` / `DELEGATE_PLUGIN_DATA` / `DELEGATE_CLAUDE_BIN` deterministically without mutating the ambient process environment. The strip/redirect in `helpers.mjs` governs the ambient env for any path that falls back to `process.env`.
- A `writeProfile(dataRoot, name, contents)` helper writes delegate profile fixtures under `<dataRoot>/profiles/<name>.json`.

**`tests/fleet/fleet-doctor.test.mjs`** — unit tests via the spawn seam (`runDoctor(argv, { spawnSyncImpl, env })`), no real binaries:
- **codex ready**: stub `codex --version` → `{status: 0, stdout: "codex-cli 0.x.y\n"}` ⇒ `engines.codex.status === "ready"`, `reason === null`, `onPath === true`, `version` populated.
- **codex not-ready (binary-missing)**: stub returns `{error: {code: 'ENOENT'}}` ⇒ `status "not-ready"`, `reason "binary-missing"`, `onPath === false`, `version === null`, `deepFixCommand "/codex:setup"`.
- **codex version-failed**: launched but `{status: 1}` (and a separate case `{error: {code: 'ETIMEDOUT'}}`) ⇒ `reason "version-failed"`, `onPath === true`, `version === null`.
- **antigravity ready / binary-missing / version-failed**: same matrix; assert `installUrl` present and `deepFixCommand "/antigravity:setup"` when not-ready.
- **delegate ready**: stub `claude --version` → `{status: 0, …}` **and** a temp `dataRoot` (passed via `env.DELEGATE_PLUGIN_DATA`) with one valid profile (via `writeProfile`) ⇒ `status "ready"`, `cliRunnable === true`, `validProfileCount === 1`, `firstValidProfile` set, `profiles` array empty (no invalid files).
- **delegate no-profiles**: CLI ok, empty profiles dir ⇒ `reason "no-profiles"`, `validProfileCount === 0`.
- **delegate no-valid-profiles**: CLI ok, fixtures: a profile with `env: { nested: {} }`, one with an array `env` value, and one with unparseable JSON ⇒ `reason "no-valid-profiles"`; `profiles[].error` set to `non-scalar-env` (object), `non-scalar-env` (array), and `unparseable-json` respectively; each entry carries the offending `name`.
- **delegate invalid-name**: a fixture file whose basename fails `PROFILE_NAME_RE` (e.g. `_foo.json` or `.hidden.json`) ⇒ that entry has `error "invalid-name"`, is skipped before parse, and does not count toward `validProfileCount`.
- **delegate cli-missing**: stub `claude --version` → `{error: {code: 'ENOENT'}}` ⇒ `reason "cli-missing"`, `cliRunnable === false`, regardless of profiles.
- **delegate cli-version-failed**: stub `claude --version` → `{status: 1}` ⇒ `reason "cli-version-failed"`, `cliRunnable === false`, `cliVersion === null`.
- **delegate honors `DELEGATE_CLAUDE_BIN`**: set `env.DELEGATE_CLAUDE_BIN` to an absolute path; assert `binaryName` reflects the override and `spawnSyncImpl` is called with that binary.
- **delegate honors `env.HOME` for default dataRoot**: with no `DELEGATE_PLUGIN_DATA`/`CLAUDE_PLUGIN_DATA`, assert `dataRoot` is derived from `env.HOME` (`<env.HOME>/.claude/plugins/data/delegate`), proving `os.homedir()` is not used.
- **`--only` filter**: `--only codex,delegate` ⇒ `checkedEngines` deepEquals `["codex","delegate"]`, `engines` has only those keys, antigravity absent.
- **`--only` canonical re-sort**: `--only delegate,codex` ⇒ `checkedEngines` deepEquals `["codex","delegate"]` (proves canonical re-sort, not input echo); duplicate tokens (`--only codex,codex`) dedupe to `["codex"]`.
- **`--only` unknown engine / empty / unknown flag**: under `--json`, stdout is a JSON object `{"error": …}` naming the allowed set and the run exits `2`; without `--json`, the message goes to stderr and stdout is empty, exit `2`.
- **exit code**: a completed check run (ready or not-ready) exits `0`; only usage errors exit `2`. No assertion of exit `1`.
- **`allReady` aggregation**: `true` only when every checked engine is `ready`.
- **schema invariants**: every `EngineStatus` has the common fields (`engine`, `status`, `summary` non-empty string, `reason`, `deepFixCommand`); `reason`/`deepFixCommand` are `null` iff `ready`; there is **no** `schemaVersion` field.

**`tests/fleet/plugin-structure.test.mjs`** — structure parity (mirrors `tests/delegate/plugin-structure.test.mjs`):
- `plugins/fleet/.claude-plugin/plugin.json` exists, `name === "fleet"`, version matches the marketplace `fleet` entry, `source === "./plugins/fleet"`.
- `plugins/fleet/commands/setup.md` exists, starts with frontmatter, has `description:`, references `fleet-doctor.mjs`, uses `AskUserQuestion`, and contains the canonical engine list.
- `plugins/fleet/scripts/fleet-doctor.mjs` exists.
- Asserts the prompt routes to `/codex:setup`, `/antigravity:setup`, `/delegate:setup` and includes the delegate real-smoke hint string `delegate-companion.mjs task "hello" --profile`.

All tests are network-free and binary-free by construction (spawn seam + temp dirs).

## 9. Wiring changes (exact)

**`.claude-plugin/marketplace.json`** — add a `fleet` entry to `plugins[]` (keep `name: "agent-fleet"` unchanged):

```json
{
  "name": "fleet",
  "source": "./plugins/fleet",
  "description": "Guided onboarding for the agent-fleet engines — pick the ones you want and fix only those.",
  "version": "0.1.0"
}
```

(`author` is optional and omitted, matching the `delegate` entry.)

**`plugins/fleet/.claude-plugin/plugin.json`** — minimal shape, `name`/`version` matching the marketplace entry:

```json
{
  "name": "fleet",
  "version": "0.1.0",
  "description": "Guided onboarding for the agent-fleet engines — pick the ones you want and fix only those."
}
```

**`tests/fleet-structure.test.mjs`** — update the second test's expected array to include `"fleet"` (now four), so the existing consistency test (name + version per entry) automatically covers the new plugin:

```js
assert.deepEqual(
  marketplace.plugins.map((p) => p.name).sort(),
  ["antigravity", "codex", "delegate", "fleet"],
);
```

**`package.json`** — add a `test:fleet` script and append it to the main `test` script. The glob is **quoted** so node (not the shell) expands it — consistent with `test:shared`'s quoted form and robust under fish/zsh (a deliberate deviation from `test:delegate`'s unquoted form):

```json
"test": "npm run test:structure && npm run test:shared && npm run test:delegate && npm run test:antigravity && npm run test:codex && npm run test:fleet",
"test:fleet": "node --test \"tests/fleet/*.test.mjs\""
```

**`README.md`** — add a single `fleet` row to the existing top plugin table (3-column shape: `Plugin | Commands | What it delegates to`). No additional prose paragraph is added; the row's description cell carries the "recommended starting point" intent:

```
| `fleet` | `/fleet:setup` | Guided onboarding — pick the engines you want, check readiness, route each deep fix to that engine's `/<engine>:setup` (the recommended starting point) |
```

### Ironclad no-touch rule (restated)

The fleet work **adds a sibling plugin** and must **not** modify `plugins/codex/`, `plugins/antigravity/`, `plugins/delegate/`, `tests/codex/`, or `tests/antigravity/`. (`tests/delegate/` is likewise not modified.) The **only** allowed edits to existing files are: `.claude-plugin/marketplace.json` (+`fleet` entry), `tests/fleet-structure.test.mjs` (+`"fleet"` in the expected list), `package.json` (+`test:fleet`), and `README.md` (+fleet row). Everything else under `plugins/fleet/` and `tests/fleet/` is new.

## 10. Open questions (both RESOLVED — flagged for reviewer objection)

- **(a) DECIDED — `fleet-doctor` does only cheap, deterministic, network-free checks; auth is never probed.** For all three engines that means binary-on-PATH + `--version`; for `delegate` it additionally means local profile validation (parse `profiles/*.json`, `env` scalar-only). Auth/OAuth/login is always routed to the engine's own `/<engine>:setup`. *Rationale:* probing auth requires a network round-trip (codex app-server probe, `agy --print` OAuth, a real `claude` token check), which would contradict the user-declined "no real-API smoke" rule.
- **(b) DECIDED — when `delegate` is ready, the `/fleet:setup` summary prints the real-smoke one-liner only as an informational hint, never run by the tooling.** The hint is `node plugins/delegate/scripts/delegate-companion.mjs task "hello" --profile <name> --json`, with `<name>` filled from `firstValidProfile`. *Rationale:* it gives the user a one-step manual verification path while keeping all live API traffic an explicit, manual user action — consistent with "no real-API smoke."
