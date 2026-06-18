# /fleet:setup — guided fleet onboarding

A prompt-driven `/fleet:setup` command that asks which engine plugins you want, runs cheap network-free readiness checks, then guides you to fix only the gaps for the engines you chose — one decision at a time. It tells you the truth about what "ready" means: local prerequisites are present, but auth/login is never verified by the tooling.

## 1. Summary

`/fleet:setup` is a new minimal `fleet` plugin that gives a single, friendly entry point to get the agent-fleet engines (`codex`, `antigravity`, `delegate`) ready to use. It is **user-choice-first**: the first thing it does is ask which engines you want (multi-select), and it only checks and fixes the ones you pick — "不一定要一開始都安裝好。" A deterministic helper, `fleet-doctor.mjs`, runs cheap, network-free checks (binary present + `--version`; for `codex` an additional local `codex app-server --help` probe; for `delegate`, CLI + local profile validation); every deeper fix (auth, OAuth, install) is routed to the engine's own existing `/<engine>:setup` command. No real-API smoke is ever run by the tooling, and **auth/login/token is never verified** — `ready` means "local prerequisites present," not "usable right now without logging in."

## 2. Goals / Non-goals

### Goals
- One guided command to get a **chosen subset** of fleet engines ready.
- Matt-Pocock-style flow: explore → explain in plain language → ask **one** decision at a time → **guide** the fix (recommend the user run `/<engine>:setup` themselves) → tell the user to re-run `/fleet:setup` to confirm → done summary.
- A self-contained, deterministic readiness checker (`fleet-doctor.mjs`) with a stable `--json` contract, an `--only <csv>` filter, and a human-readable default output.
- **Honest readiness semantics**: the JSON contract states plainly (per engine) that auth was **not** checked, and the ready-summary tells the user to run `/<engine>:setup` on first use to complete login.
- Hermetic, fast, network-free tests via a spawn seam.

### Non-goals (YAGNI — explicitly excluded)
- **No real-API smoke.** The tooling never sends a live request to any engine. The only "smoke" is a manual, informational one-liner printed for `delegate` when it is ready (see §6.4).
- **No auth/login probing in `fleet-doctor`.** Auth state for all three engines requires a network round-trip; probing it would contradict "no real-API smoke" and "network-free." Auth is always routed to the engine's own `/<engine>:setup`. (The local `codex app-server --help` probe is **not** an auth check — it is a network-free local spawn; see §5.3.)
- **No network calls of any kind.** Allowed spawns are local, network-free probes only: `codex --version`, `codex app-server --help`, `agy --version`, `<delegate-binary> --version`. Anything that needs a network round-trip (codex `login`, antigravity OAuth via `agy --print`, a real `claude` token check) is **never** spawned by `fleet-doctor`.
- **No same-flow auto-run of `/<engine>:setup`.** `/fleet:setup` **guides** the user to run the deep-fix command themselves; it does **not** invoke another slash command in-flow and does **not** consume a nested re-check (see §6.3).
- **No modification of sibling plugins.** `plugins/codex/`, `plugins/antigravity/`, `plugins/delegate/`, `tests/codex/`, `tests/antigravity/`, `tests/delegate/` are untouched (see §9 ironclad rule).
- **No `fleet-doctor` import of / path-coupling to sibling plugins.** It checks dependencies directly; it does not `import` or reach into `plugins/<engine>/` (this includes re-implementing antigravity's `resolveAgyBin` inline rather than importing it — see §5.3).
- **No separate "verify mode" / no `fleet-doctor verify` subcommand.** `fleet-doctor` has exactly one behavior (run the checks); modes are expressed only via `--json` and `--only`.
- **No background jobs, no state store, no watchdog.** `fleet` is a stateless, read-only checker plus a prompt.
- **No caching of check results.** Every invocation re-checks from scratch.

## 3. Locked decisions (recap)

- **Scope:** fleet-wide across all three engine plugins, but the user picks a **subset**.
- **Form (Approach A):** a new minimal plugin `plugins/fleet/` = `commands/setup.md` (prompt-driven) + `scripts/fleet-doctor.mjs` (deterministic checks; `--json`, `--only <list>`, hermetic spawn seam + injectable env).
- **`fleet-doctor` is self-contained:** checks dependencies directly; does not import or path-couple to sibling plugins. Deep fixes route to each plugin's existing `/<plugin>:setup`.
- **Checks are cheap, deterministic, network-free:**
  - `codex`: `codex --version` **and** `codex app-server --help` (both via the seam; both must exit `0` for `ready`). `app-server` is a **local, network-free** probe.
  - `antigravity`: resolve the binary with the same order the real engine uses (`AGY_BIN` → PATH scan → `~/.local/bin/agy` → bare `agy`), then probe the resolved path with `--version` via the seam.
  - `delegate`: `claude` runnable (override binary via `DELEGATE_CLAUDE_BIN`) + `claude --version`, **plus** local profile validation (parse `profiles/*.json`; an `env` block, if present, must be a non-array object whose values are scalar-only).
- **Auth is never probed by `fleet-doctor`** — always routed to `/<engine>:setup`. `ready` means local prerequisites present, **not** authenticated/usable-now.
- **Deep fix is guide-only:** for each not-ready engine the prompt **explains the gap and recommends the user run `/<engine>:setup` themselves**, then asks them to re-run `/fleet:setup` to confirm. `/fleet:setup` never invokes another slash command in-flow.
- **When `delegate` is ready** (claude CLI present + ≥1 valid profile), the `/fleet:setup` summary prints the manual real-smoke one-liner as an informational hint using the **real installed slash command**:
  `/delegate:task "hello" --profile <name> --json`

## 4. Architecture: `plugins/fleet/` layout

```
plugins/fleet/
  .claude-plugin/
    plugin.json            # { "name": "fleet", "version": "0.1.0", "description": "..." }
  commands/
    setup.md               # prompt-driven /fleet:setup (the guided flow)
  scripts/
    fleet-doctor.mjs       # deterministic, network-free readiness checks; --json / --only; spawn seam + env seam
```

- `plugin.json` uses the minimal shape `{ name, version, description }` and matches the marketplace entry's `name` + `version` exactly (see §9).
- `/fleet:setup` resolves to the `fleet` plugin's `commands/setup.md`. Inside that command, `fleet-doctor.mjs` is invoked via `node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-doctor.mjs" ...` (the same `${CLAUDE_PLUGIN_ROOT}` convention used by the sibling setup commands).

## 5. Component: `scripts/fleet-doctor.mjs`

### 5.1 Responsibilities
- Run cheap, deterministic, **network-free** readiness checks for some or all of the three engines.
- Emit a stable machine-readable report (`--json`) for the prompt to consume, and a friendly human report by default.
- Be **self-contained**: it knows the three engines' check recipes inline (including a re-implementation of antigravity's binary resolution order); it does **not** `import` sibling-plugin code, and it does **not** depend on sibling plugins being installed.
- **Never** probe auth/login/OAuth and **never** make a network call. (Local `--version` / `app-server --help` spawns are allowed because they do not touch the network.)
- State **honestly** that auth was not checked: every `EngineStatus` carries `authVerified: false` (§5.4).

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

**Probe invocation.** Every probe is a `spawnSyncImpl` call with stdin closed and a 5 s timeout:

```
// version probe (all engines)
spawnSyncImpl(binary, ['--version'], { encoding: 'utf8', timeout: 5000, input: '' })

// codex secondary probe (codex only)
spawnSyncImpl('codex', ['app-server', '--help'], { encoding: 'utf8', timeout: 5000, input: '' })
```

`input: ''` closes stdin so a binary that reads stdin cannot hang the doctor; `timeout: 5000` (5000 ms) bounds a hung probe. No `cwd` is set (inherits the process cwd). Both probes are **local and network-free** — `codex app-server --help` only prints usage and exits; it does not open a server socket or contact any service.

**Probe-result detection — ORDERED rule (uniform across all probes).** From a single probe result `r = spawnSyncImpl(binary, args, …)`, classify by evaluating these clauses **top-to-bottom; the first match wins**:

1. **`r.error && r.error.code === 'ENOENT'`** ⇒ **not found**. Boolean (`onPath` / `cliRunnable`) `false`, `reason` = `binary-missing` / `cli-missing`, `version` = `null`.
2. **else if `r.error` (any code, including `ETIMEDOUT`) OR `r.signal` (e.g. `'SIGTERM'`) OR `r.status !== 0`** ⇒ **present-but-failed**. Boolean per engine (`onPath: true` for codex/antigravity; `cliRunnable: false` for delegate — see below), `reason` = `version-failed` / `cli-version-failed`, `version` = `null`.
3. **else (`r.status === 0`)** ⇒ **ok**. Boolean `true`, `version` = first trimmed non-empty line of `r.stdout`.

Precedence is strictly top-to-bottom. A **timeout** therefore lands in clause 2, **not** clause 1: the measured spawnSync timeout shape is `{ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }` — its `error.code` is `ETIMEDOUT` (not `ENOENT`), so clause 1 does not match and it falls through to clause 2 (`version-failed`). The measured not-found shape is `{ error: { code: 'ENOENT' }, status: null }`, which matches clause 1. **Only `ENOENT` means missing**; any other error (including `ETIMEDOUT`), any signal, or a non-zero status means present-but-failed. (This replaces the old "`r.error` truthy and `r.status == null` ⇒ missing" wording, which was wrong because a timeout also has `status == null`.)

The boolean is derived **purely from the probe result** (ENOENT ⇒ not found; status 0 ⇒ found-and-runnable) — `fleet-doctor` does **not** do a separate `command -v` / PATH lookup for codex or delegate. "On PATH" is shorthand for "the configured binary was resolvable and spawnable" (for delegate the binary may be an absolute path via `DELEGATE_CLAUDE_BIN`, so the `cliRunnable` name is used instead of `onPath`). antigravity is the exception: it resolves a candidate path **before** spawning (see below).

**codex** — TWO local probes:
1. Run `codex --version` via the seam. Classify with the ordered rule.
   - If clause 1 (ENOENT) ⇒ `reason: "binary-missing"`, `onPath: false`, `version: null`, `appServerAvailable: false`, **and the app-server probe is skipped** (no point probing a binary that is not installed).
   - If clause 2 ⇒ `reason: "version-failed"`, `onPath: true`, `version: null`, `appServerAvailable: false`, app-server probe skipped (the binary is present but already failing `--version`).
   - If clause 3 (status 0) ⇒ `onPath: true`, `version` populated; **proceed to the app-server probe**.
2. Run `codex app-server --help` (args `['app-server','--help']`) via the seam. Classify with the same ordered rule (treating any non-clause-3 outcome as failure):
   - exit `0` ⇒ `appServerAvailable: true`.
   - ENOENT / any error (incl. `ETIMEDOUT`) / signal / non-zero status ⇒ `appServerAvailable: false`.
- **`ready` iff BOTH probes exit `0`** (`onPath: true` and `appServerAvailable: true`). Then `reason: null`, `version` populated.
- **`not-ready` reasons (codex enum):**
  - `binary-missing` — `codex --version` ENOENT'd (`onPath: false`, `appServerAvailable: false`, `version: null`).
  - `version-failed` — `codex --version` launched but failed/timeout/signal (`onPath: true`, `appServerAvailable: false`, `version: null`).
  - `app-server-failed` — `codex --version` exited `0` (`onPath: true`, `version` populated) **but** `codex app-server --help` did not exit `0` (`appServerAvailable: false`).
- Deep-fix route: `/codex:setup`. Auth/login (network) is handled there via `!codex login` — **never** by `fleet-doctor`. The `app-server --help` probe is local and does **not** stand in for an auth check.

**antigravity** — resolve the binary inline, then probe `--version`:
- `fleet-doctor` **re-implements** the engine's resolution order inline (it does **not** import `plugins/antigravity/scripts/lib/agent-runtime.mjs`). This mirrors `resolveAgyBin(env)` so a user whose `agy` lives at `~/.local/bin/agy` or is pointed at by `AGY_BIN` is **not** falsely reported binary-missing. Resolution order, using `deps.env` and a deps-injectable existence check (`deps.existsSyncImpl ?? fs.existsSync` — see §5.5):
  1. **`env.AGY_BIN`** — consulted **only when truthy/non-empty**: `env.AGY_BIN && existsSyncImpl(env.AGY_BIN)` (matching `agent-runtime.mjs:53`). An empty-string/unset `AGY_BIN` short-circuits to the next step **without** calling `existsSyncImpl('')`. If set and it exists on disk, use it. `resolvedFrom: "AGY_BIN"`.
  2. **PATH scan** — else split `(env.PATH || env.Path || '')` on `':'` and **skip falsy/empty directory entries** (mirroring `agent-runtime.mjs:56`'s `.filter(Boolean)`, so a leading/trailing/double colon does not produce an empty dir that could spuriously match a relative `./agy`); the first non-empty directory `d` for which `existsSyncImpl(join(d, 'agy'))` wins. `resolvedFrom: "PATH"`.
  3. **home fallback** — else if `existsSyncImpl(join(env.HOME, '.local/bin/agy'))`, use that path. `resolvedFrom: "home-fallback"`.
  4. **default** — else fall back to the bare string `"agy"`. `resolvedFrom: "default"`.
- Probe the resolved `binPath` with `--version` via the seam; classify with the ordered rule.
- **`ready` iff `<binPath> --version` exits `0`** ⇒ `onPath: true`, `version` populated, `reason: null`.
- **`not-ready` reasons (antigravity enum):**
  - `binary-missing` — only when **no candidate existed** (resolution fell through to the bare `"agy"` default, `resolvedFrom: "default"`) **AND** the bare spawn ENOENT'd (clause 1). Then `onPath: false`, `version: null`, and `installUrl` is included.
  - `version-failed` — the resolved binary launched but failed/timeout/signal (clause 2) ⇒ `onPath: true`, `version: null`.
  - (Note: if `resolvedFrom !== "default"` a resolved path was found on disk, so an ENOENT at spawn is unexpected; the ordered rule still classifies a spawn ENOENT as not-found, but in practice `binary-missing` arises from the `default` + ENOENT combination.)
- Deep-fix route: `/antigravity:setup` (runs the interactive OAuth via `agy --print`). **No auth probe** in `fleet-doctor` — `agy --print` would trigger a network OAuth flow and is never spawned here.

**delegate**
- Resolve the CLI binary name: `DELEGATE_CLAUDE_BIN ?? "claude"` (from `deps.env`). Run `<binary> --version` via the seam; classify with the ordered rule.
- **`cliRunnable` semantics:** `cliRunnable: true` iff `<binary> --version` exited `0`. For `cli-missing` (clause 1, ENOENT) and `cli-version-failed` (clause 2, launched but failed/timeout/signal), `cliRunnable: false` and `cliVersion: null`. Both not-ready legs set `cliRunnable: false` for the readiness gate; `cli-version-failed` differs from `cli-missing` only in that the binary **was** found and spawned (it just failed `--version`).
- Validate local profiles (no network):
  - `dataRoot = DELEGATE_PLUGIN_DATA ?? CLAUDE_PLUGIN_DATA ?? <HOME>/.claude/plugins/data/delegate/`, where `<HOME>` is expanded from `deps.env.HOME` (falling back to `process.env.HOME`) — **not** `os.homedir()` — so the test `HOME` redirect is honored hermetically (§5.5, §8).
  - Enumerate `dataRoot/profiles/*.json`. The **profile name is the `.json` file basename** with the extension stripped (there is **no** in-file `name` field; the name is always the basename).
  - For each discovered file, in order:
    1. **Name check:** apply `PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/` to the basename. A basename that fails the regex (e.g. begins with `.`, `_`, or `-`, or contains a space) yields `error: "invalid-name"`, and the file is **skipped before JSON parse**.
    2. **Parse check:** otherwise read and `JSON.parse` the file; a parse failure yields `error: "unparseable-json"`.
    3. **Env-shape check:** otherwise, if a top-level `env` is present it must be a **plain object whose every value is a scalar** (`string` | `number` | `boolean` | `null`). Reject `Array.isArray(parsed.env)` — an **array `env` is invalid** (`error: "non-scalar-env"`), as is any `env` whose value is a nested object or array. (An `env` that is a non-array object with only scalar values passes.)
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

**Readiness semantics (honest, NO false "usable") — read this before interpreting `status`.** `status: "ready"` means **only** that the engine's **local prerequisites are present** — for codex, the binary is installed and both `codex --version` and `codex app-server --help` exit `0`; for antigravity, the resolved `agy` binary answers `--version`; for delegate, the claude CLI runs and there is ≥1 locally-valid profile. **`ready` does NOT mean the engine is authenticated, logged in, or usable right now.** `fleet-doctor` performs **no** auth/login/token verification of any kind (that needs a network round-trip, which is out of scope). To make this contractual, **every `EngineStatus` carries `authVerified: false`** (a constant; `fleet-doctor` never sets it to `true`). Consumers and the prompt MUST treat `ready` as "local prerequisites satisfied — still run `/<engine>:setup` to complete auth on first use."

**`EngineStatus` (common fields, every engine):**
- `engine` (`string`): one of `"codex" | "antigravity" | "delegate"`.
- `status` (`string`): `"ready" | "not-ready"`.
- `authVerified` (`boolean`): **always `false`**. States in the contract that `fleet-doctor` did **not** verify auth/login/token (it is network-free). Never `true`.
- `reason` (`string | null`): machine code for the gap when `not-ready`; `null` when `ready`. Enumerated per engine:
  - codex: `"binary-missing" | "version-failed" | "app-server-failed"`
  - antigravity: `"binary-missing" | "version-failed"`
  - delegate: `"cli-missing" | "cli-version-failed" | "no-profiles" | "no-valid-profiles"`
- `summary` (`string`): one human-readable sentence (always present). The exact strings are **free-form and NOT contract-tested** — the structure test (§8) asserts only that `summary` is a non-empty string. The canonical phrasings below are the recommended defaults the prompt surfaces in §6.3; an implementer may reword them without breaking tests:

  | engine | status / reason | canonical `summary` |
  |---|---|---|
  | codex | ready | `codex CLI ready (<version>) — auth not checked, run /codex:setup to log in` |
  | codex | binary-missing | `codex not found on PATH — install the OpenAI Codex CLI` |
  | codex | version-failed | `codex found but 'codex --version' failed` |
  | codex | app-server-failed | `codex --version ok but 'codex app-server --help' failed — codex isn't fully ready` |
  | antigravity | ready | `agy CLI ready (<version>) — auth not checked, run /antigravity:setup to authorize` |
  | antigravity | binary-missing | `agy not found — install from https://antigravity.google/download` |
  | antigravity | version-failed | `agy found (<binPath>) but '<binPath> --version' failed` |
  | delegate | ready | `delegate ready (<binaryName> <cliVersion>, <validProfileCount> valid profile(s)) — token not checked` |
  | delegate | cli-missing | `<binaryName> CLI not found — delegate needs the claude CLI` |
  | delegate | cli-version-failed | `<binaryName> found but '--version' failed` |
  | delegate | no-profiles | `claude CLI ready but no profiles found in <dataRoot>/profiles` |
  | delegate | no-valid-profiles | `claude CLI ready but no valid profiles (fix the listed file(s))` |

- `deepFixCommand` (`string | null`): the slash command to run for a deep fix when `not-ready`; `null` when `ready`. Per engine: `"/codex:setup"`, `"/antigravity:setup"`, `"/delegate:setup"`.

**codex `EngineStatus` adds:**
- `binaryName` (`string`): `"codex"`.
- `onPath` (`boolean`): whether `codex --version` was resolvable/spawnable (see §5.3). `version-failed` / `app-server-failed` ⇒ `onPath: true`; `binary-missing` ⇒ `onPath: false`.
- `appServerAvailable` (`boolean`): whether `codex app-server --help` exited `0`. `ready` ⇒ `true`. `binary-missing` / `version-failed` ⇒ `false` (the probe was skipped). `app-server-failed` ⇒ `false` (the probe ran but did not exit `0`).
- `version` (`string | null`): trimmed first non-empty line of `codex --version`, or `null`. Populated whenever `codex --version` exited `0` (i.e. for `ready` **and** `app-server-failed`); `null` for `binary-missing` / `version-failed`.

**antigravity `EngineStatus` adds:**
- `binaryName` (`string`): `"agy"`.
- `binPath` (`string`): the resolved path that was probed — an absolute path (from `AGY_BIN`, PATH scan, or the `~/.local/bin/agy` home fallback) or the bare string `"agy"` when resolution fell through to the default.
- `resolvedFrom` (`string`): how `binPath` was chosen — `"AGY_BIN" | "PATH" | "home-fallback" | "default"`.
- `onPath` (`boolean`): whether the resolved `binPath` was spawnable (see §5.3). `version-failed` ⇒ `onPath: true`; `binary-missing` ⇒ `onPath: false`.
- `version` (`string | null`): trimmed first non-empty line of `<binPath> --version`, or `null`.
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

### 5.5 Spawn + env + existence seams (hermetic tests)

- `fleet-doctor.mjs` exposes a pure entry function `runDoctor(argv, deps = {})`, where `deps` includes:
  - an injectable spawn function (`deps.spawnSyncImpl ?? spawnSync`);
  - an injectable environment (`deps.env ?? process.env`, honoring `AGY_BIN` / `DELEGATE_PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA` / `DELEGATE_CLAUDE_BIN` / `HOME` / `PATH`);
  - an injectable filesystem-existence check (`deps.existsSyncImpl ?? fs.existsSync`) used **only** by the antigravity `resolveAgyBin` re-implementation, so the resolution order (`AGY_BIN` → PATH scan → `~/.local/bin/agy` → bare `agy`) is fully test-stubbable with **no real filesystem and no real binary**. This is a network-free, deterministic mechanism: the resolver consults `deps.env` (for `AGY_BIN`, `PATH`/`Path`, `HOME`) and `deps.existsSyncImpl` to pick a candidate path, then hands that path to `deps.spawnSyncImpl`. `AGY_BIN` is consulted only when **truthy/non-empty** (`env.AGY_BIN && existsSyncImpl(env.AGY_BIN)`, matching `agent-runtime.mjs:53`), so an empty/unset `AGY_BIN` never triggers an `existsSyncImpl('')` call; likewise the PATH split (`(env.PATH || env.Path || '').split(':')`) skips falsy/empty segments before `existsSyncImpl(join(d, 'agy'))`. (`deps.existsSyncImpl` is distinct from the delegate profile enumeration, which reads the temp `dataRoot` directly; tests point `dataRoot` at a real temp dir via `env.DELEGATE_PLUGIN_DATA`.)
- All binary probes (`codex --version`, `codex app-server --help`, `agy --version`, `<delegate-binary> --version`) go through `deps.spawnSyncImpl` so tests can stub presence/absence, exit codes, signals, and timeouts **without any real binary**. This matches the delegate companion's `deps.spawnSyncImpl` convention in `cmdSetup`. Tests distinguish the codex probes by inspecting the `(binary, args)` the stub is called with (`['--version']` vs `['app-server','--help']`).
- The delegate `dataRoot` is computed from `deps.env` (with the `~`/`<HOME>` expansion taken from `deps.env.HOME`, falling back to `process.env.HOME`), so tests that pass an explicit `env` object are fully isolated from the ambient process environment.
- The CLI wrapper (`if (import.meta.url === ...)` / `main()`) calls `runDoctor(process.argv.slice(2))` with no `deps`, defaulting to the real `spawnSync`, `process.env`, and `fs.existsSync`.

## 6. Component: `commands/setup.md` (the `/fleet:setup` flow)

Prompt-driven command. Frontmatter: `description: Guided onboarding for the agent-fleet engines (pick the ones you want, fix only those)`; `allowed-tools: Bash(node:*), AskUserQuestion`. The body instructs the model through the steps below. The guiding principle is Matt-Pocock-style: assume the user doesn't know the jargon, show sensible defaults, ask **one** decision at a time, and never dump everything at once.

**This command is GUIDE-ONLY.** It runs `fleet-doctor` exactly once (Step 2) and **never invokes another slash command in-flow**. For every gap it explains the problem and **recommends the user run `/<engine>:setup` themselves**, then run `/fleet:setup` again to confirm. The `allowed-tools` list is intentionally limited to `Bash(node:*)` and `AskUserQuestion`; the body must **not** claim to dispatch, run, or consume the output of any other slash command.

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

Parse the JSON. Do **not** re-run per engine. If `allReady` is `true`, skip straight to the ready-summary (§6.4) — but note that even `allReady: true` does **not** mean the engines are authenticated; every `EngineStatus` has `authVerified: false`, and the ready-summary must say so (§6.4). This Step-2 call is the **only** `fleet-doctor` invocation in the flow.

### 6.3 Step 3 — Explain + guide the fix, one decision at a time (GUIDE-ONLY)

For each `not-ready` engine (in canonical order), the prompt:
1. **Explains the gap in plain language** from `summary` / `reason` (e.g. "Codex isn't installed yet — that's the OpenAI CLI this plugin drives.", or for `app-server-failed`: "Codex is installed but its app-server interface isn't responding, so it's not fully ready yet.").
2. Asks **one** `AskUserQuestion` to decide whether the user wants guidance to fix this engine now (options like `Show me how to fix <engine> (Recommended)` / `Skip <engine>`). Only one engine is in flight at a time; the next engine's question is not asked until the current one is resolved.
3. On "show me how," **guides the user** — it states the gap and tells them the exact slash command **they** should run themselves. It does **not** invoke that command and does **not** wait on / consume its output:

**codex** (`binary-missing` / `version-failed` / `app-server-failed`):
- Tell the user to run **`/codex:setup`** themselves. (That command offers to `npm install -g @openai/codex`, re-checks, and preserves `!codex login` guidance if installed-but-unauthenticated.)
- For `app-server-failed`, explain that `codex --version` worked but `codex app-server --help` did not, so codex is installed but not fully wired up; `/codex:setup` is still the right place to repair it.
- `/fleet:setup` does **not** install codex or run `codex login` itself.

**antigravity** (`binary-missing` / `version-failed`):
- If `binary-missing`: tell the user to install from `installUrl` (`https://antigravity.google/download`), then run **`/antigravity:setup`** themselves.
- If `version-failed`: mention the resolved `binPath` / `resolvedFrom` so they know which binary failed, then point them at `/antigravity:setup`.
- Route auth/OAuth entirely to the user-run `/antigravity:setup` (it triggers the interactive OAuth via `agy --print`). `/fleet:setup` never runs `agy --print` itself.

**delegate** (`cli-missing` / `cli-version-failed` / `no-profiles` / `no-valid-profiles`):
- Tell the user to run **`/delegate:setup`** themselves (which re-runs the same CLI + profile check and walks profile creation: a standard Claude Code settings JSON at `<dataRoot>/profiles/<name>.json` whose `env` block carries `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `model`).
- For `no-valid-profiles`, surface the specific `profiles[].error` (`invalid-name` / `unparseable-json` / `non-scalar-env`) and the offending `name` so the user knows which file to fix, then tell them to run `/delegate:setup`.

4. **Plugin-not-installed fallback.** If the engine's plugin may not be installed (its `/<engine>:setup` slash command does not exist in this session), instruct the user to **first** run `/plugin install <engine>@agent-fleet`, **then** `/<engine>:setup`. (`fleet-doctor` checks binaries on disk, not whether the sibling plugin is installed, so the prompt cannot assume the deep-fix command is present.)
5. **Confirm by re-running.** After guiding, tell the user to run **`/fleet:setup` again** once they have finished the deep fix, to confirm the engine is now `ready`. `/fleet:setup` does **not** re-run `fleet-doctor` in this flow and does **not** consume any nested re-check output — the Step-2 call (§6.2) is the doctor's only invocation in this run.

### 6.4 Step 4 — Ready-summary

After all chosen engines are resolved, print a compact summary: for each chosen engine, `ready` or `still not-ready (run /<engine>:setup yourself, then re-run /fleet:setup)`.

**Auth caveat (always print, even when `allReady`).** Because `fleet-doctor` never verifies auth (`authVerified: false` on every engine), the summary MUST tell the user that **`ready` means local prerequisites are present, not that the engine is logged in / usable right now**, and that on first use they should run the engine's own setup to complete auth:
- codex → `/codex:setup` (which guides `codex login`),
- antigravity → `/antigravity:setup` (which runs the OAuth flow),
- delegate → `/delegate:setup` (the token lives in each profile's `env`; `fleet-doctor` only checked shape, never the token).

Do **not** present `ready` as "usable now."

**When `delegate` is `ready`** (claude CLI present + ≥1 valid profile), additionally print the manual real-smoke one-liner as an informational hint, using the **real installed slash command** and substituting `firstValidProfile` for `<name>`:

```
/delegate:task "hello" --profile <name> --json
```

(`/delegate:task` is a real installed slash command — `plugins/delegate/commands/task.md` — accepting `--profile` and `--json`. This replaces the older repo-root-relative `node plugins/delegate/scripts/delegate-companion.mjs …` hint.) This is a hint the user may run manually; `/fleet:setup` never runs it (that would be a real-API smoke, which is out of scope).

## 7. Error handling

- **Missing binary** (`codex` / `agy` / `claude`): not a crash — `fleet-doctor` reports `status: "not-ready"` with `reason: "binary-missing"` / `"cli-missing"`, `onPath`/`cliRunnable: false`, and a `summary`. For antigravity, `installUrl` is included. The prompt explains and guides the user to run `/<engine>:setup`. (Detection: clause 1 of the ordered rule — `r.error.code === 'ENOENT'` — see §5.3. For antigravity, missing only after resolution fell through to the bare `agy` default and that spawn ENOENT'd.)
- **`--version` fails despite binary present** (non-zero exit, timeout, or signal): clause 2 of the ordered rule ⇒ `reason: "version-failed"` / `"cli-version-failed"`; `onPath: true` (codex/antigravity) / `cliRunnable: false` (delegate); treated as `not-ready`. A timeout (`error.code === 'ETIMEDOUT'`, `signal: 'SIGTERM'`, `status: null`) lands here, **not** in `binary-missing`. Same guidance.
- **codex app-server probe fails** (`codex --version` ok but `codex app-server --help` not exit `0`): `reason: "app-server-failed"`, `onPath: true`, `version` populated, `appServerAvailable: false`; treated as `not-ready`. The prompt explains codex is installed but not fully ready and guides the user to `/codex:setup`. (The app-server probe is skipped entirely when codex is `binary-missing` or already `version-failed`.)
- **Invalid / zero profiles (delegate)**: zero `.json` → `reason: "no-profiles"`; files present but none valid → `reason: "no-valid-profiles"` with per-invalid-file `profiles[].error` (including `non-scalar-env` for an array `env`). CLI section still reported independently (so the user sees "CLI fine, profiles are the problem").
- **`fleet-doctor` spawn failure** (e.g. `node` itself fails, or the script throws): the prompt detects **empty or non-JSON stdout** (or a thrown error) and tells the user plainly that the readiness check couldn't run, shows the raw stderr, and suggests re-running `/fleet:setup`. Because the prompt always passes `--json`, a usage error (exit `2`) still emits a JSON `{"error": …}` object to stdout (§5.2), so the prompt's "empty/non-JSON stdout = crash" heuristic stays correct — a usage error is parsed as JSON and surfaced as its `error` message, never misclassified as a crash. Inside `fleet-doctor`, a `spawnSyncImpl` returning `{error}` for a probe is handled as "binary not runnable / probe failed" per the ordered rule, not an uncaught throw — only genuinely unexpected errors propagate (exit non-zero / throw).
- **User declines a fix** (chooses `Skip <engine>`): that engine is left `not-ready`; the flow continues to the next engine and the final summary lists it as `still not-ready (run /<engine>:setup yourself, then re-run /fleet:setup)`. No nagging, no auto-retry, no in-flow dispatch.
- **Unknown engine in `--only`** (or empty `--only`, or an unknown flag): `fleet-doctor` exits `2`. Under `--json` it writes `{"error": "unknown engine: <name>; allowed: codex,antigravity,delegate"}` (or the analogous empty/`unknown-flag` message) to stdout; without `--json` it writes the plain-text message to stderr. The prompt only ever passes engines it sourced from the Step-1 multi-select, so this is primarily a guardrail for direct CLI use.

## 8. Testing — `tests/fleet/` hermetic suite

New directory `tests/fleet/`, run by `npm run test:fleet` (`node --test "tests/fleet/*.test.mjs"`, glob quoted so node — not the shell — expands it, robust under fish/zsh).

**Hermetic conventions** mirror the existing per-plugin suites, with one load-bearing ordering rule:

- A `helpers.mjs` is imported **first**. It **FIRST** strips ambient `ANTHROPIC_*` / `CLAUDE_*` / `CLAUDECODE*` / `DELEGATE_*` / `AGY_BIN` env, **THEN** sets the temp-dir values for `HOME` and `DELEGATE_PLUGIN_DATA` (and, when a test exercises it, `DELEGATE_CLAUDE_BIN` / `AGY_BIN` / `PATH`). The redirect always runs **after** the strip so the test-controlled values win — the strip pattern `DELEGATE_*` / `CLAUDE_*` would otherwise erase the very vars (`DELEGATE_PLUGIN_DATA`, `DELEGATE_CLAUDE_BIN`, `CLAUDE_PLUGIN_DATA`) the test needs.
- **Mechanism:** unit tests drive `runDoctor(argv, { spawnSyncImpl, env, existsSyncImpl })` and pass an **explicit `env` object** as `deps.env` plus (for antigravity) a stubbed `deps.existsSyncImpl`; this bypasses `process.env` and the real filesystem entirely, so the suite controls `HOME` / `DELEGATE_PLUGIN_DATA` / `DELEGATE_CLAUDE_BIN` / `AGY_BIN` / `PATH` and on-disk existence deterministically without mutating the ambient process environment. The strip/redirect in `helpers.mjs` governs the ambient env for any path that falls back to `process.env`.
- A `writeProfile(dataRoot, name, contents)` helper writes delegate profile fixtures under `<dataRoot>/profiles/<name>.json`.

**`tests/fleet/fleet-doctor.test.mjs`** — unit tests via the seams (`runDoctor(argv, { spawnSyncImpl, env, existsSyncImpl })`), no real binaries / no real filesystem for resolution:

*codex:*
- **codex ready**: stub `codex --version` → `{status: 0, stdout: "codex-cli 0.x.y\n"}` **and** `codex app-server --help` → `{status: 0}` ⇒ `engines.codex.status === "ready"`, `reason === null`, `onPath === true`, `appServerAvailable === true`, `version` populated, `authVerified === false`.
- **codex not-ready (binary-missing)**: `codex --version` stub returns `{error: {code: 'ENOENT'}, status: null}` ⇒ `status "not-ready"`, `reason "binary-missing"`, `onPath === false`, `appServerAvailable === false`, `version === null`, `deepFixCommand "/codex:setup"`; assert the app-server probe was **not** spawned.
- **codex version-failed**: `codex --version` launched but `{status: 1}` (and a separate case for the measured timeout shape `{status: null, signal: 'SIGTERM', error: {code: 'ETIMEDOUT'}}`) ⇒ `reason "version-failed"`, `onPath === true`, `appServerAvailable === false`, `version === null`; assert the app-server probe was **not** spawned.
- **codex app-server-failed**: `codex --version` → `{status: 0, stdout: "codex-cli 0.x.y\n"}` **but** `codex app-server --help` → `{status: 1}` ⇒ `status "not-ready"`, `reason "app-server-failed"`, `onPath === true`, `appServerAvailable === false`, `version` populated, `deepFixCommand "/codex:setup"`. (Also assert the same `not-ready` / `app-server-failed` for an `ETIMEDOUT` and an `ENOENT` on the app-server probe.)

*antigravity (resolution + probe; existence stubbed via `deps.existsSyncImpl`):*
- **resolves via AGY_BIN**: `env.AGY_BIN = "/opt/agy"`, `existsSyncImpl("/opt/agy") → true`; stub `/opt/agy --version` → `{status: 0, stdout: "agy 1.2.3\n"}` ⇒ `status "ready"`, `binPath === "/opt/agy"`, `resolvedFrom === "AGY_BIN"`, `onPath === true`, `version` populated. (Also: `AGY_BIN` set but `existsSyncImpl` false ⇒ resolution falls through to the next candidate, not AGY_BIN; and an empty-string/unset `AGY_BIN` falls straight through to the PATH scan with **no** `existsSyncImpl('')` call.)
- **resolves via PATH**: no `AGY_BIN`; `env.PATH = "/a:/b"`, `existsSyncImpl("/a/agy") → false`, `existsSyncImpl("/b/agy") → true`; stub `/b/agy --version` → `{status: 0}` ⇒ `binPath === "/b/agy"`, `resolvedFrom === "PATH"`, `status "ready"`.
- **PATH empty-segment safety**: a `PATH` with a leading/trailing/double colon (e.g. `env.PATH = ":/a"` or `"/a::/b"`) does **not** resolve to a bare `agy` via an empty segment — the empty segment is skipped (`.filter(Boolean)`) so `existsSyncImpl` is never called with `join('', 'agy')`.
- **resolves via HOME ~/.local/bin/agy fallback**: no `AGY_BIN`, `env.PATH` has no `agy`; `env.HOME = "/home/u"`, `existsSyncImpl("/home/u/.local/bin/agy") → true`; stub that path `--version` → `{status: 0}` ⇒ `binPath === "/home/u/.local/bin/agy"`, `resolvedFrom === "home-fallback"`, `status "ready"`.
- **binary-missing when none**: no `AGY_BIN`, no `agy` on `PATH`, no home fallback (`existsSyncImpl` returns `false` for every candidate) ⇒ `binPath === "agy"`, `resolvedFrom === "default"`; the bare `agy --version` spawn stub returns `{error: {code: 'ENOENT'}, status: null}` ⇒ `status "not-ready"`, `reason "binary-missing"`, `onPath === false`, `installUrl` present, `deepFixCommand "/antigravity:setup"`.
- **antigravity version-failed**: resolution finds a path (e.g. via PATH, `existsSyncImpl → true`) but that path `--version` → `{status: 1}` (and a timeout case) ⇒ `reason "version-failed"`, `onPath === true`, `version === null`.
- All antigravity cases are hermetic: `existsSyncImpl` and `spawnSyncImpl` are both stubbed; no real filesystem or binary is touched.

*delegate:*
- **delegate ready**: stub `claude --version` → `{status: 0, …}` **and** a temp `dataRoot` (passed via `env.DELEGATE_PLUGIN_DATA`) with one valid profile (via `writeProfile`) ⇒ `status "ready"`, `cliRunnable === true`, `validProfileCount === 1`, `firstValidProfile` set, `profiles` array empty (no invalid files), `authVerified === false`.
- **delegate no-profiles**: CLI ok, empty profiles dir ⇒ `reason "no-profiles"`, `validProfileCount === 0`.
- **delegate no-valid-profiles**: CLI ok, fixtures: a profile with `env: { nested: {} }` (object), one with `env: ["x"]` (an **array** `env`), and one with unparseable JSON ⇒ `reason "no-valid-profiles"`; `profiles[].error` set to `non-scalar-env` (object), `non-scalar-env` (array), and `unparseable-json` respectively; each entry carries the offending `name`. (The `env: ["x"]` fixture proves `Array.isArray(parsed.env)` is rejected.)
- **delegate invalid-name**: a fixture file whose basename fails `PROFILE_NAME_RE` (e.g. `_foo.json` or `.hidden.json`) ⇒ that entry has `error "invalid-name"`, is skipped before parse, and does not count toward `validProfileCount`.
- **delegate cli-missing**: stub `claude --version` → `{error: {code: 'ENOENT'}, status: null}` ⇒ `reason "cli-missing"`, `cliRunnable === false`, regardless of profiles.
- **delegate cli-version-failed**: stub `claude --version` → `{status: 1}` ⇒ `reason "cli-version-failed"`, `cliRunnable === false`, `cliVersion === null`.
- **delegate honors `DELEGATE_CLAUDE_BIN`**: set `env.DELEGATE_CLAUDE_BIN` to an absolute path; assert `binaryName` reflects the override and `spawnSyncImpl` is called with that binary.
- **delegate honors `env.HOME` for default dataRoot**: with no `DELEGATE_PLUGIN_DATA`/`CLAUDE_PLUGIN_DATA`, assert `dataRoot` is derived from `env.HOME` (`<env.HOME>/.claude/plugins/data/delegate`), proving `os.homedir()` is not used.

*generic CLI / schema:*
- **`--only` filter**: `--only codex,delegate` ⇒ `checkedEngines` deepEquals `["codex","delegate"]`, `engines` has only those keys, antigravity absent.
- **`--only` canonical re-sort**: `--only delegate,codex` ⇒ `checkedEngines` deepEquals `["codex","delegate"]` (proves canonical re-sort, not input echo); duplicate tokens (`--only codex,codex`) dedupe to `["codex"]`.
- **`--only` unknown engine / empty / unknown flag**: under `--json`, stdout is a JSON object `{"error": …}` naming the allowed set and the run exits `2`; without `--json`, the message goes to stderr and stdout is empty, exit `2`.
- **exit code**: a completed check run (ready or not-ready) exits `0`; only usage errors exit `2`. No assertion of exit `1`.
- **`allReady` aggregation**: `true` only when every checked engine is `ready`.
- **schema invariants**: every `EngineStatus` has the common fields (`engine`, `status`, `authVerified === false`, `summary` non-empty string, `reason`, `deepFixCommand`); `reason`/`deepFixCommand` are `null` iff `ready`; `authVerified` is **always `false`** (never `true`, even when `ready`); there is **no** `schemaVersion` field. Additionally, the per-engine fields are present on every status of that engine regardless of verdict: codex status always carries boolean `appServerAvailable`; antigravity status always carries string `binPath` and `resolvedFrom`; delegate status always carries `cliRunnable`. (This keeps the invariant sweep aligned with the expanded §5.4 schema, so a regression where, e.g., `appServerAvailable` is `undefined` for `version-failed` is caught here and not only by the dedicated codex tests.)

**`tests/fleet/plugin-structure.test.mjs`** — structure parity (mirrors `tests/delegate/plugin-structure.test.mjs`):
- `plugins/fleet/.claude-plugin/plugin.json` exists, `name === "fleet"`, version matches the marketplace `fleet` entry, `source === "./plugins/fleet"`.
- `plugins/fleet/commands/setup.md` exists, starts with frontmatter, has `description:`, references `fleet-doctor.mjs`, uses `AskUserQuestion`, and contains the canonical engine list.
- `plugins/fleet/scripts/fleet-doctor.mjs` exists.
- Asserts the prompt **guides the user** to `/codex:setup`, `/antigravity:setup`, `/delegate:setup` (and the `/plugin install <engine>@agent-fleet` fallback) and includes the delegate real-smoke hint string using the real command: `/delegate:task "hello" --profile`.
- Asserts the prompt does **not** claim to run another slash command in-flow (guide-only): it does not contain language promising to invoke `/<engine>:setup` itself or to consume its re-check output.

All tests are network-free and binary-free by construction (spawn seam + existence seam + temp dirs).

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

**`tests/fleet-structure.test.mjs`** — update the second test's expected array to include `"fleet"` (now four), and **rename that test** so its name covers four plugins (engine plugins **plus** fleet) rather than "exactly the three engine plugins". The existing consistency test (name + version per entry) automatically then covers the new plugin:

```js
// renamed from: "marketplace lists exactly the three engine plugins"
test("marketplace lists exactly the engine plugins plus fleet", () => {
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name).sort(),
    ["antigravity", "codex", "delegate", "fleet"],
  );
});
```

**`package.json`** — add a `test:fleet` script and append it to the main `test` script. The glob is **quoted** so node (not the shell) expands it — consistent with `test:shared`'s quoted form and robust under fish/zsh (a deliberate deviation from `test:delegate`'s unquoted form):

```json
"test": "npm run test:structure && npm run test:shared && npm run test:delegate && npm run test:antigravity && npm run test:codex && npm run test:fleet",
"test:fleet": "node --test \"tests/fleet/*.test.mjs\""
```

**`README.md`** — two coordinated edits, both within the allowed README scope:

1. **Plugin table row.** Add a single `fleet` row to the existing top plugin table (3-column shape: `Plugin | Commands | What it delegates to`). The row's description cell carries the "recommended starting point" intent:

```
| `fleet` | `/fleet:setup` | Guided onboarding — pick the engines you want, check readiness, then guide each deep fix to that engine's `/<engine>:setup` (the recommended starting point) |
```

2. **Install instructions.** The README install section must now tell the user how to install `fleet` and note the engine-plugin dependency. Add `/plugin install fleet@agent-fleet` to the install instructions and note that the **engine plugins must also be installed** for their `/<engine>:setup` commands to exist (which `/fleet:setup` guides the user toward — see the `/plugin install <engine>@agent-fleet` fallback in §6.3). For example:

```
# Recommended starting point — install fleet and run the guided onboarding:
/plugin install fleet@agent-fleet
/fleet:setup

# fleet only *guides* the deep fixes; install the engine plugins you chose so
# their /<engine>:setup commands exist:
/plugin install codex@agent-fleet
/plugin install antigravity@agent-fleet
/plugin install delegate@agent-fleet
```

(Exact prose/formatting is at the implementer's discretion, but the README must mention `/plugin install fleet@agent-fleet` and state that the engine plugins must also be installed for `/<engine>:setup` to exist.)

### Ironclad no-touch rule (restated)

The fleet work **adds a sibling plugin** and must **not** modify `plugins/codex/`, `plugins/antigravity/`, `plugins/delegate/`, `tests/codex/`, or `tests/antigravity/`. (`tests/delegate/` is likewise not modified.) The **only** allowed edits to existing files are: `.claude-plugin/marketplace.json` (+`fleet` entry), `tests/fleet-structure.test.mjs` (+`"fleet"` in the expected list and the renamed test), `package.json` (+`test:fleet`), and `README.md` (+fleet row and +install instructions). Everything else under `plugins/fleet/` and `tests/fleet/` is new.

## 10. Open questions / decided design points

All items below are **DECIDED** (flagged for reviewer objection):

- **(a) DECIDED — `fleet-doctor` does only cheap, deterministic, network-free checks; auth is never probed.** For codex that means `codex --version` **plus** the local, network-free `codex app-server --help` probe (both must exit `0`); for antigravity, resolve the binary (`AGY_BIN` → PATH → `~/.local/bin/agy` → bare `agy`) then `--version`; for delegate, CLI `--version` plus local profile validation (parse `profiles/*.json`, `env` must be a non-array object with scalar-only values). Auth/OAuth/login is always routed to the engine's own `/<engine>:setup`. *Rationale:* probing auth requires a network round-trip (codex `login`, `agy --print` OAuth, a real `claude` token check), which would contradict the user-declined "no real-API smoke" rule. (`codex app-server --help` is **not** an auth check — it is a local usage-printing spawn.)
- **(b) DECIDED — honest readiness semantics (Blocker 2).** `ready` means **local prerequisites present only**, never "authenticated / usable now." The JSON contract states this explicitly via a constant `authVerified: false` on every `EngineStatus`, and the §6.4 ready-summary always tells the user that auth/login/token was not verified and that they should run `/<engine>:setup` on first use (codex login, antigravity OAuth, delegate profile token). This is a settled design point, not an open question.
- **(c) DECIDED — guide-only deep-fix flow (Blocker 4).** `/fleet:setup` **never** invokes `/<engine>:setup` (or any other slash command) in-flow and never consumes a nested re-check. For each not-ready engine it explains the gap, recommends the user run `/<engine>:setup` (preceded by `/plugin install <engine>@agent-fleet` if the plugin may be absent), and asks them to re-run `/fleet:setup` to confirm. `fleet-doctor` runs exactly once (Step 2). The `allowed-tools` frontmatter stays `Bash(node:*), AskUserQuestion`, and the prompt body must not promise to run other slash commands. *Rationale:* keeps `/fleet:setup` a read-only guide with a single deterministic side effect (the one doctor run), avoids brittle nested slash-command dispatch, and keeps every install/auth action an explicit user choice.
- **(d) DECIDED — when `delegate` is ready, the `/fleet:setup` summary prints the real-smoke one-liner only as an informational hint, never run by the tooling.** The hint uses the **real installed slash command** `/delegate:task "hello" --profile <name> --json` (`plugins/delegate/commands/task.md`), with `<name>` filled from `firstValidProfile`. *Rationale:* it gives the user a one-step manual verification path while keeping all live API traffic an explicit, manual user action — consistent with "no real-API smoke" — and it references a command that actually exists rather than a repo-root-relative script invocation.
