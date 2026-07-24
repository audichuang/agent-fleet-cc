# Grok Plugin ↔ Grok Build CLI — Contract & Sync Audit

Living audit of whether the **`grok` plugin** (`plugins/grok/`) is still in sync with the
upstream **xAI Grok Build CLI** (`grok`, source: [`github` mirror of the SpaceXAI
monorepo](https://x.ai/cli)) it shells out to. The plugin was originally written by
*guessing* the CLI surface (Grok Build was closed-source at the time). Grok Build is now
open source, so every flag and output field the plugin depends on can be pinned to a source
anchor — this doc records what was checked, the verdict, and the exact anchors so the next
pass is a diff, not a rebuild.

> **Scope.** This audits the plugin's dependency on Grok's **headless CLI contract**: the
> argv it builds (`buildInvocation`) and the stdout it parses (`parseEvent` / `extractResult`)
> in `plugins/grok/scripts/lib/adapter.mjs`. It is **not** a review of Grok internals, nor of
> the shared job runtime (state/worker/cancel — that lives in `shared/lib/`).

> **Why CLI and not ACP.** Grok's headless runner (`headless.rs`) is *itself* a full ACP
> (Agent Client Protocol) client: it spawns the `grok-shell` agent, does the ACP
> `initialize`/capability handshake (`ProtocolVersion::V1`), opens a session, auto-answers
> permission requests, pulls `usage`/`structuredOutput` out of the ACP `_meta`, and
> **flattens** the ACP `session/update` notification stream into the simple
> `{type: text|thought|end|error}` line protocol we parse. Speaking ACP ourselves would mean
> re-implementing `headless.rs` (handshake, session lifecycle, protocol-version negotiation,
> permission responder, meta extraction) and pinning ourselves to a *versioned* protocol —
> strictly more coupling and churn than the forgiving switch-on-`type` line stream, for zero
> capability we actually consume. The CLI is the officially-maintained ACP client; we reuse
> it. (Contrast `codex`, which has no such projection and therefore *had* to build an
> app-server broker — see `docs/codex-protocol-sync-audit.md`.)

---

## How to keep this current

When you want to re-check after new Grok Build releases land:

1. **Find what changed upstream** in the two files that define our contract:
   ```bash
   git -C /path/to/grok-build log --oneline <BASELINE_COMMIT>.. -- \
     crates/codegen/xai-grok-pager/src/app/cli.rs \
     crates/codegen/xai-grok-pager/src/headless.rs
   ```
2. **Re-verify the two durable checklists below** (Flags sent, Output read). If Grok renamed,
   removed, or changed the value-enum of anything on them, that is a breaking drift — fix the
   adapter, add a regression test, bump the plugin version.
3. **Prefer the *released* binary as ground truth.** The open-source tree is a *periodic
   snapshot* of the monorepo (README: "synced periodically") — it may lead/lag the `grok` you
   actually invoke. Confirm suspicious drift by running the real binary
   (`grok --help`, a real headless call), not just reading source. See the `e2e-testing` skill
   for the real-engine smoke check.
4. **Update** the Baseline block and append a dated row to the **Audit log** at the bottom.

**Severity language.** `breaking` (a flag we send would now be rejected, or an output field we
read was renamed/removed → silent data loss) → `should-upgrade` (adopt to match, nothing
breaks) → `cosmetic` (additive upstream, we ignore it fine) → `none`.

---

## Baseline

| What | Value |
| --- | --- |
| Plugin | `plugins/grok/` @ `0.5.0` |
| Released binary we invoke | `grok 0.2.111` (re-verified 2026-07-24; `--help` confirms `--session-id`/`-s`) |
| Open-source tree audited | commit `c68e39f` ("Publish harness and TUI open-source", 2026-07-16), `xai-grok-pager-bin 0.1.220-alpha.4` (source tree at `~/research/grok-build`, re-checked 2026-07-24 — same commit, no upstream drift) |
| Contract files | `crates/codegen/xai-grok-pager/src/app/cli.rs`, `.../src/headless.rs`, `.../xai-grok-sandbox/src/profiles.rs` |
| Verdict | **none** — zero drift; every flag we send and field we read is present with matching semantics |

---

## Part 1 — Flags we send (durable checklist)

Built by `adapter.mjs → buildInvocation`. Each row is pinned to its `cli.rs` anchor.

| Flag we send | cli.rs anchor | Semantics | Status |
| --- | --- | --- | --- |
| `-p <prompt>` | `short='p', long="single"` (~485) | Headless single prompt; triggers headless mode | ✓ |
| `--output-format streaming-json` | `long="output-format", value_enum, default "plain"` (513) | Enum `plain`\|`json`\|`streaming-json` | ✓ |
| `--json-schema <SCHEMA>` | `long="json-schema"` (518) | Structured output; **implies** `--output-format json` | ✓ |
| `--always-approve` | `long="always-approve", alias="yolo"` (272 / 458) | Auto-approve all tools (== `--yolo` == `--permission-mode bypassPermissions`) | ✓ |
| `--no-auto-update` | `long="no-auto-update", hide=true` (696) | Suppress update check (hidden, still valid) | ✓ |
| `--no-alt-screen` | `long="no-alt-screen"` (709) | Run inline, no alternate screen | ✓ |
| `-m <MODEL>` | `short='m', long="model"` (521) | Model id | ✓ |
| `--cwd <DIR>` | `#[arg(long)] pub cwd` (238 / 436) | Workspace root (long auto-derived from field name) | ✓ |
| `--reasoning-effort <LVL>` | `long="reasoning-effort", visible_alias="effort"` (headless `PagerArgs` 525; the 265 hit is `AgentArgs`) | `none`..`max`; also per-model menu ids | ✓ |
| `--no-subagents` | `long="no-subagents"` (602) | Disable fan-out (deterministic single agent) | ✓ |
| `--sandbox read-only` | `#[arg(long, env="GROK_SANDBOX")] pub sandbox` (decl 674; 673 is its doc comment) | Emitted only on opt-in `--read-only` — see Part 3 | ✓ |
| `-r <ID>` | `short='r', long="resume"` (554) | Resume an existing session | ✓ |
| `-s <UUID>` | `short='s', long="session-id"` (582) | Use a specific session UUID for a **new** conversation (must be a valid UUID, must not already exist under the target session directory); with `--resume`/`--continue`, only valid together with `--fork-session` (we never pass that, so always mutually exclusive with `-r` in this plugin). Minted client-side (`crypto.randomUUID()`) and persisted to the job record BEFORE spawn, so a worker crash mid-run still leaves a resumable id. headless.rs wires it through: `session_id_flag` param (608), consumed at (617). | ✓ |

## Part 2 — Output we read (durable checklist)

Parsed by `adapter.mjs → parseEvent` / `extractResult`. Pinned to `headless.rs`.

| Field / event we read | headless.rs anchor | Notes | Status |
| --- | --- | --- | --- |
| `{"type":"text","data":…}` | `on_text_chunk` (373) | We concat `.data` | ✓ |
| `{"type":"thought","data":…}` | `on_thought_chunk` (388) | We ignore it (raw line stays in log) | ✓ |
| `{"type":"end","stopReason","sessionId","usage",…}` | `on_end` (441-457) | Terminal event; we trust exit-code + presence of `end`, not a specific `stopReason` | ✓ |
| `{"type":"error","message",…}` | `on_error` (469-480) | grok emits errors on **stdout** in json modes; we capture so the message survives | ✓ |
| json result: `text`/`stopReason`/`sessionId`/`structuredOutput` | `build_json_result` (419-439), `attach_structured_output` | `--json-schema` mode: one pretty-printed object; `.text` = JSON string, `.structuredOutput` = parsed | ✓ |
| `usage.{input_tokens,output_tokens}` | `attach_result_usage` → `notification::attach_result_usage_fail_closed` | Captured from the `end` event and the json result; normalized to `{inputTokens, outputTokens}` for the job record. *(Upstream also stamps usage on error events, but our error branch keeps only `message` — a failed job's cost is low-value, so error-usage is not surfaced. Also available-but-unread: `cache_read_input_tokens`, `total_tokens`, `num_turns`, `modelUsage`, `total_cost_usd`/`_ticks`.)* | ✓ |

**Tolerance guarantees we rely on:** the event list is documented non-exhaustive
("switch on `type`") — `parseEvent` returns `null` for unknown/junk lines and never throws, so
new upstream event types cannot break a run. This is the loose coupling that makes the CLI
line protocol *more* stable to track than a versioned wire protocol.

---

## Part 3 — Read-only / sandboxing (WIRED — opt-in `--read-only`)

Grok Build ships first-class sandbox enforcement. As of `grok@0.4.0` the plugin exposes it as an
**opt-in** `--read-only` flag. The default is **unchanged** — see the design note below for why
this is opt-in rather than a codex/antigravity-style read-only default.

**Wiring** (`grok-companion.mjs` `--read-only` bool → `request.readOnly` → `adapter.mjs`):
```js
if (r.readOnly) argv.push("--sandbox", "read-only");
```
- **Default (no `--read-only`)**: no `--sandbox` flag → grok resolves to the **`off`** profile —
  *no sandbox at all*, full read + write + network (`config.rs:1132`: `resolve_profile` falls back
  to `"off"` when no flag / `GROK_SANDBOX` / config profile is set). This is the pre-0.4.0
  behavior, preserved.
- **`--read-only`** → `--sandbox read-only`: **best-effort** no-write (only `~/.grok` + temp
  writable, whole workspace readable) — see the caveats below; it is *not* an absolute guarantee.
- `--always-approve` stays on in both modes — orthogonal layer: it auto-answers read-tool prompts;
  the sandbox is what actually blocks writes underneath (when it applies).
- **Resume**: `--read-only` on a resume of a session with a *persisted, differing* profile makes
  grok **`exit(1)`** (`SandboxStartup::Conflict`, constructed `cli.rs:883`, handled `main.rs:1694`)
  — a session's profile is fixed at creation. A legacy/unresolved session with **no** saved
  profile returns `None` (`persistence.rs:739`) and grok just applies the requested read-only
  (`cli.rs:888`). Fail-closed on a real conflict beats silently ignoring the request; for the
  common case start a fresh `--read-only` job. (Resuming a read-only session *with* `--read-only`
  matches → fine.)

**⚠️ `--read-only` is BEST-EFFORT, not a hard guarantee** (this is why it's opt-in, not a
codex/antigravity-style default — defaulting to a guarantee that can silently not hold would give
false confidence):
1. **A managed `requirements.toml` overrides it.** `resolve_profile` precedence is
   `requirement > CLI > env > config > "off"` (`config.rs:1123`); upstream test
   `sandbox_requirements_pin.rs` pins that `--sandbox read-only` *loses* to a requirement. So a
   managed `workspace`/`off` profile can permit writes despite the flag.
2. **It fails OPEN, not closed.** Where no OS backend applies (Linux Landlock unavailable / macOS
   Seatbelt) grok *warns and runs unsandboxed* rather than exiting (`lib.rs:143,181`). The hard
   `exit(1)` refusal fires only for read-*deny* profiles (custom with a non-empty deny list) —
   `requires_read_deny(ReadOnly)` is `false` (`lib.rs:359`); `strict` is **not** in that set
   either. Read-only has no bwrap deny-plan, so on Linux it skips bwrap and goes straight to
   Landlock. Combined with `--always-approve`, an un-enforced fallback is fully writable with tools
   auto-approved — so treat `--read-only` as hardening, not a hermetic jail.
3. **Network scope is child-process only.** grok leaves its **main** process online (it needs the
   LLM API), so in-process `web_search`/`web_fetch` **keep working** under `--read-only`
   (`lib.rs:10`). Only network from terminal-spawned **child** processes is blocked, via seccomp on
   Linux (`streaming_local_terminal.rs:916`). So `--read-only` does NOT break web research; it does
   stop a spawned `curl`/`wget` in a bash command.

The three upstream levers (strongest first):

| Mechanism | How | Strength | Source anchor | Used? |
| --- | --- | --- | --- | --- |
| **`--sandbox read-only`** (alias `readonly`, or `GROK_SANDBOX=read-only`) | Best-effort FS sandbox; only `~/.grok` + temp writable, whole workspace readable; blocks **child-process** network (not in-process web tools) | **Strong where a backend applies & no requirement overrides**; warns + runs writable otherwise | `profiles.rs:1,109`; writable paths `paths.rs:91`; flag decl `cli.rs:674`; enforce path `config.rs` `apply_sandbox`, `lib.rs:143` | ✅ what `--read-only` emits |
| `--disallowed-tools "search_replace,write,run_terminal_cmd,…"` | Removes write/exec tools from the toolset (keeps network + reads) | Medium — model can't call them, but not OS-enforced | `cli.rs:623` | available escalation |
| `--deny "Write(**)" --deny "Edit(**)"` | Permission-layer denial (tools exist, execution gated) | Weakest — cooperative | `cli.rs:476` | — |

Built-in sandbox profiles: `workspace`, `devbox`, `read-only`, `strict`, `off` (`profiles.rs`);
the resolved default when nothing is set is **`off`**, not `workspace` (`config.rs:1132`). For a
niche profile, set `GROK_SANDBOX=<profile>` — grok reads it natively (`cli.rs:674`), and the
plugin only injects `--sandbox` for `--read-only`, so it won't clobber your env otherwise.

---

## Audit log

| Date | Grok tree | Verdict | Notes |
| --- | --- | --- | --- |
| 2026-07-16 | `c68e39f` / bin `0.1.220-alpha.4` (released `grok 0.2.93`) | **none** | First source-grounded audit after open-sourcing. All 11 flags + all read fields pinned to anchors, zero drift. Same pass added `usage` capture (`{inputTokens,outputTokens}`) — the old "grok emits no token counts" assumption was stale; `attach_result_usage` now stamps usage on `end`/json/error. Documented read-only sandbox levers (Part 3). |
| 2026-07-16 | (same tree) | **none** | `grok@0.4.0`: wired an **opt-in `--read-only`** (`--sandbox read-only`). NON-breaking — default unchanged (`off`, full access). Opt-in (not a codex/antigravity-style default) because read-only is **best-effort**: a managed `requirements.toml` overrides it (`config.rs:1123`) and it fails *open* to writable when no OS backend applies (`lib.rs:143`) — a false-confidence default. Independent Codex review (session `019f6b69`) corrected several prior-draft errors, all verified against source: (1) read-only does **not** disable web tools — network restriction is **child-process only**, grok's in-process `web_search`/`web_fetch` stay online (`lib.rs:10`, `streaming_local_terminal.rs:916`); (2) default is `off` not `workspace` (`config.rs:1132`); (3) enum is `SandboxStartup::Conflict`+`exit(1)`, constructed `cli.rs:883` (not `Refused`), and only on a *persisted* differing profile — a no-saved-profile session applies read-only (`persistence.rs:739`, `cli.rs:888`); (4) read-only skips bwrap (no deny-plan) → Landlock directly, `strict` not in the read-deny set (`lib.rs:359`); (5) usage is captured from `end`/json only, not error events; (6) anchors: reasoning-effort `525`, `--sandbox` decl `674`. |
| 2026-07-24 | `~/research/grok-build` @ `c68e39f` (same tree, re-verified) + released `grok 0.2.111` | **none** | Wired `-s`/`--session-id` (`cli.rs:582`, adopted in headless at `headless.rs:608/617`) so a session id is minted client-side (`crypto.randomUUID()`) and persisted into the job record's `request` BEFORE the engine spawns — a worker crash mid-run (no `end` event) no longer loses the id needed to `-r`/`--resume`. Sent only for a brand-new conversation; always mutually exclusive with `-r` (grok rejects `--session-id` + `--resume` without `--fork-session`, which this plugin never passes). Local released binary `grok 0.2.111 --help` cross-checked the flag exists. |
