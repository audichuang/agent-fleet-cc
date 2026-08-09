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

0. **Actually fetch first.** A local clone that was never fetched reports "same commit"
   forever, which is how the 2026-07-24 row came to claim "no upstream drift" while
   upstream had already shipped 8 syncs (proved from `.git/logs/HEAD` — see the
   2026-08-09 log row). `git -C /path/to/grok-build fetch origin && git log --oneline
   HEAD..origin/main` BEFORE writing any verdict, and diff from the commit the
   **Baseline block** names, not from whatever the clone happened to sit on.
1. **Find what changed upstream** in the files that define our contract:
   ```bash
   git -C /path/to/grok-build log --oneline <BASELINE_COMMIT>.. -- \
     crates/codegen/xai-grok-pager/src/app/cli.rs \
     crates/codegen/xai-grok-pager/src/headless.rs \
     crates/codegen/xai-grok-pager/src/headless/ \
     crates/codegen/xai-grok-sandbox/ \
     crates/codegen/xai-grok-shell/src/config/mod.rs
   ```
   The last three matter: the NDJSON emitter moved into `headless/reducer/`, and the
   sandbox's new fail-closed *startup gate* landed in `xai-grok-sandbox` +
   `xai-grok-shell/src/config/mod.rs` — none of which `headless.rs`+`cli.rs` alone show.
   Sandbox behavior is split across those two crates: read what `xai-grok-shell` does with
   what `xai-grok-sandbox` returns, or you will mistake a startup refusal for enforcement.
   Upstream also ships its own changelog at
   `crates/codegen/xai-grok-shell/CHANGELOG.md` — screen it for `breaking_change: true`.
2. **Re-verify the two durable checklists below** (Flags sent, Output read). If Grok renamed,
   removed, or changed the value-enum of anything on them, that is a breaking drift — fix the
   adapter, add a regression test, bump the plugin version.
3. **Prefer the *released* binary as ground truth.** The open-source tree is a *periodic
   snapshot* of the monorepo (README: "synced periodically") — it may lead/lag the `grok` you
   actually invoke. Confirm suspicious drift by running the real binary
   (`grok --help`, a real headless call), not just reading source. See the `e2e-testing` skill
   for the real-engine smoke check.
4. **Update** the Baseline block and append a dated row to the **Audit log** at the bottom.
   When bumping the released-binary version, **keep the provenance of behavioral checks done on
   older versions** (e.g. "classifyError buckets verified by running 0.2.93") unless you actually
   re-ran them — a bare version bump silently upgrades an old claim to the new binary.

**Severity language.** `breaking` (a flag we send would now be rejected, or an output field we
read was renamed/removed → silent data loss) → `should-upgrade` (adopt to match, nothing
breaks) → `cosmetic` (additive upstream, we ignore it fine) → `none`.

---

## Baseline

| What | Value |
| --- | --- |
| Plugin | `plugins/grok/` @ `0.6.0` |
| Released binary we invoke | `grok 1.0.0 (3cd0d0cbce) [stable]` (2026-08-09; every flag we send verified present in verbatim `--help`, plus a parse-only run of the real binary). **Provenance of behavioral claims:** the `classifyError` auth/quota/config/endpoint buckets were verified by *running* `0.2.93` (2026-07-16) and have NOT been re-run since — they are carried forward, not re-proven on 1.0.0. The sandbox-refusal bucket added in 0.6.0 was verified from 1.0.0 source + `strings` on the shipped binary, not by triggering it. |
| Open-source tree audited | commit `8a14c91` ("Synced from monorepo", 2026-08-09), `SOURCE_REV 27b3c666`, `xai-grok-pager-bin` `1.0.0` (source tree at `~/research/grok-build`). **Diff base for this pass was `c68e39f`, not the local clone's previous HEAD `a422116`** — `a422116` was never audited (see the 2026-08-09 log row), and `a422116..HEAD` provably hides the entire `headless/reducer/` introduction and the `hook_write_deny.rs` fail-closed switch. |
| Tree vs binary | The tree **leads** the binary on exactly one axis: it carries the `du`/`disk-usage` subcommand that `grok 1.0.0` does not expose. All 43 visible `PagerArgs` flags match `--help` 1:1, so for the flag contract the two are equivalent and either is authoritative. |
| Contract files | `crates/codegen/xai-grok-pager/src/app/cli.rs`, `.../src/headless.rs`, **`.../src/headless/cli.rs`** (`OutputFormat`, `parse_json_schema`, `parse_permission_rules_strict`, prompt-file parsing — moved out of `headless.rs`), **`.../src/headless/reducer/{mod,acp}.rs`** (the NDJSON emitter), `.../xai-grok-sandbox/src/{profiles,lib,hook_write_deny}.rs`, `.../xai-grok-shell/src/config/mod.rs` (sandbox startup gate) |
| Verdict | **should-upgrade** — nothing we send is rejected and nothing we read was renamed, but `--sandbox read-only` gained a **fail-closed startup gate** (bubblewrap now required on Linux) while its **enforcement stayed fail-open**, and the plugin documented neither correctly. Fixed in `0.6.0`. |

---

## Part 1 — Flags we send (durable checklist)

Built by `adapter.mjs → buildInvocation`. Each row is pinned to its `cli.rs` anchor.

| Flag we send | cli.rs anchor | Semantics | Status |
| --- | --- | --- | --- |
| `-p <prompt>` | `short='p', long="single"` (476-484) | Headless single prompt; triggers headless mode | ✓ |
| `--output-format streaming-json` | `long="output-format", value_enum, default "plain"` (506-507); enum decl `headless/cli.rs:9-19` | Enum is now FOUR-valued: `plain`\|`json`\|`streaming-json`\|`streaming-messages-json` (the 4th is the Anthropic Messages API wire format, added by 1.0.0 — purely additive, we keep sending `streaming-json`). Note the `streaming-json` doc comment now reads "NDJSON of the agent native ACP session updates" — the *wording* changed, the emitted line shapes did not (see Part 2). | ✓ |
| `--json-schema <SCHEMA>` | `long="json-schema"` (515-516) | Structured output; **implies** `--output-format json` | ✓ |
| `--always-approve` | `long="always-approve", alias="yolo"` (450-455; AgentArgs copy 277) | Auto-approve all tools (== `--yolo` == `--permission-mode bypassPermissions`) | ✓ |
| `--no-auto-update` | `long="no-auto-update", hide=true` (732-733) | Suppress update check (hidden, still valid) | ✓ |
| `--no-alt-screen` | `long="no-alt-screen"` (745-746) | Run inline, no alternate screen | ✓ |
| `-m <MODEL>` | `short='m', long="model"` (518) | Model id | ✓ |
| `--cwd <DIR>` | `#[arg(long)] pub cwd` (428-429) | Workspace root (long auto-derived from field name) | ✓ |
| `--reasoning-effort <LVL>` | `long="reasoning-effort", visible_alias="effort"` (`PagerArgs` 521-527; the 269-275 hit is `AgentArgs`) | Clap/`FromStr` accept all seven canonical levels (`sampling-types/src/types.rs:829-846`), but **the model's catalog is what decides**: a canonical level the model does not offer is REJECTED after the session opens — `resolve_effort_token_for` returns `None` → `EffortTokenError::UnknownToken` → `headless.rs:683` `bail!` (see `acp/model_state.rs:209-211,226-239,258-268`). Today's catalog has one model, `grok-4.5`, offering only `low\|medium\|high`, so `none\|minimal\|xhigh\|max` kill the job. The 1.0.0 `needs_fresh_catalog` refresh (`headless.rs:1042-1066`) does NOT rescue them — it short-circuits on any canonical token and only widens acceptance for non-canonical *menu ids*. Plugin surfaces therefore advertise `low\|medium\|high` only and defer to `grok models`; no client-side allowlist (the catalog is remote and would rot). | ✓ |
| `--no-subagents` | `long="no-subagents"` (644-645) | Disable fan-out (deterministic single agent) | ✓ |
| `--sandbox read-only` | `#[arg(long, env="GROK_SANDBOX")] pub sandbox` (710-711) | Emitted only on opt-in `--read-only` — see Part 3 | ✓ |
| `-r <ID>` | `short='r', long="resume"` (552-560) | Resume an existing session | ✓ |
| `-s <UUID>` | `short='s', long="session-id"` (593) | Use a specific session UUID for a **new** conversation (must be a valid UUID, must not already exist under the target session directory); with `--resume`/`--continue`, only valid together with `--fork-session` (we never pass that, so always mutually exclusive with `-r` in this plugin). Minted client-side (`crypto.randomUUID()`) and persisted to the job record BEFORE spawn, so a worker crash mid-run still leaves a resumable id. headless.rs wires it through: `session_id_flag` param (608), consumed at (617). | ✓ |
| `--tools x_search,web_search,web_fetch` | `long="tools"` (662, "Built-in tools to allow (comma-separated)") | Emitted only on opt-in `--research`. **Authoritative**, not cooperative: `CliAgentOverrides.tools` → `apply_to_definition` overwrites `def.tools` outright for the main agent (`xai-grok-shell/src/agent/config.rs:1649-1650`); subagents get the session-clamped variant (`config.rs:1666-1667`). Every non-listed built-in tool (shell/edit/write/read/…) does not exist for the run — stronger than `--sandbox read-only`'s best-effort FS enforcement. Hosted tools gate through the same allowlist (`hosted_tool_allowed`, `xai-grok-agent/src/config.rs:1349-1357`); canonical names `builder.rs:1175-1182`, `HostedTool::XSearch => "x_search"` (`sampling-types/src/conversation.rs:495`). | ✓ |
| `--deny MCPTool` | `long="deny"` (469, permission-layer deny rule; same tier as Part 3's `--deny` rows) | Emitted alongside `--tools` on `--research`, as a **cooperative backstop only**: headless always loads the user's configured MCP servers regardless of `--tools` (`headless.rs:615/660`), and nothing in source proves the `--tools` whitelist covers MCP-provided tools — so this is weaker than the built-in-tool guarantee above, not a hard block. Rule syntax verified: a bare tool name (no parens) is the valid tool-wide form — `parse_permission_rule`'s no-paren branch maps `"MCPTool"` → `ToolFilter::Mcp` (`xai-grok-workspace/src/permission/rules.rs:209-216`, `tool_name_to_filter` 241), so the strict startup parser (`parse_permission_rules_strict`, `headless/cli.rs:145-157` (re-exported `headless.rs:42`, called `headless.rs:820`)) cannot reject it and kill every `--research` spawn. | ✓ |
| `--max-turns <n>` | `long="max-turns"` (669, `value_parser` `u32` range `1..`, "Maximum number of agent turns") | Opt-in runaway-cost fuse. `CliAgentOverrides.max_turns` (`headless.rs` ~907). Companion validates a positive integer before job creation; grok's own clap range is the same floor. | ✓ |
| `--no-memory` | `long="no-memory"` (653, "Disable cross-session memory for this session"; `conflicts_with = "experimental_memory"`) | Opt-in; we never send `experimental_memory`, so no conflict. Keeps a one-off delegated task from reading/writing the user's grok memory. | ✓ |

## Part 2 — Output we read (durable checklist)

Parsed by `adapter.mjs → parseEvent` / `extractResult`. Pinned to `headless.rs`.

| Field / event we read | headless.rs anchor | Notes | Status |
| --- | --- | --- | --- |
| `{"type":"text","data":…}` | `on_text_chunk` (240) → `reducer/acp.rs:108` `AcpLine::Text{data}` | We concat `.data`. `#[serde(tag="type", rename_all="snake_case")]` (`acp.rs:32`) renames the VARIANT, not the field — `data` survives. | ✓ |
| `{"type":"thought","data":…}` | `on_thought_chunk` (258) → `reducer/acp.rs:109` | We ignore it (raw line stays in log) | ✓ |
| `{"type":"end","stopReason","sessionId","requestId","usage",…}` | `on_end` (305) → `reducer/acp.rs:161-173` `AcpEndLine` (decl `acp.rs:89-100`) | Terminal event; we trust exit-code + presence of `end`, not a specific `stopReason`. **`stopReason` values are snake_case as of 1.0.0** — `end_turn\|max_tokens\|max_turn_requests\|refusal\|cancelled` (`headless.rs:385-401` `stop_reason_wire`, which warns + degrades to `end_turn` on an unknown future variant). Nothing in the adapter compares the value, which is exactly why that rename was a non-event; `requestId` is additive and unread. | ✓ |
| `{"type":"error","message",…}` | `on_error` (357) → `reducer/acp.rs:175-189` | grok emits errors on **stdout** in json modes; we capture so the message survives | ✓ |
| json result: `text`/`stopReason`/`sessionId`/`structuredOutput` | `build_json_result` (283-300), `attach_structured_output` (269-280) | `--json-schema` mode: one pretty-printed object; `.text` = JSON string, `.structuredOutput` = parsed. `requestId` and `thought` are additive and unread. Still pretty-printed and still ends on a bare `}` — which is what `parseEvent`'s jsonMode buffering heuristic keys on. | ✓ |
| **`structuredOutputError`** | `headless.rs:270-280` (`unwrap_or_else(\|\| Err("model did not produce structured output"))`) → `reducer/mod.rs:33-36` | **Read as of plugin 0.6.0.** A `--json-schema` run whose model answered in prose still **exits 0**, signalling the failure only by stamping `structuredOutput:null` + this field. Before 0.6.0 the job was recorded `completed` with the un-schema'd prose as `resultText`. `parseEvent` now flags it on the json event (`structuredError`) and `extractResult` gates `ok` on it — deliberately NOT a `kind:"error"` event, which would discard `sessionId`/`usage` and leave the job unresumable with its cost unrecorded. `extractResult` also returns the reason as the optional `error` field the shared worker now prefers over `stderrTail` (added to `shared/lib/` in the same pass), because grok exits **0** here and the fallback would otherwise persist "engine exited nonzero" on an exit-0 job. `classifyError` buckets it `config`. | ✓ |
| `usage.{input_tokens,output_tokens}` | `attach_result_usage` → `notification::attach_result_usage_fail_closed` (`extensions/notification.rs:318-341`) | Captured from the `end` event and the json result; normalized to `{inputTokens, outputTokens}` for the job record. *(Upstream also stamps usage on error events, but our error branch keeps only `message` — a failed job's cost is low-value, so error-usage is not surfaced. Also available-but-unread: `cache_read_input_tokens`, `total_tokens`, `num_turns`, `modelUsage`, `total_cost_usd`/`_ticks`.)* | ✓ |

**Tolerance guarantees we rely on:** the event list is documented non-exhaustive
("switch on `type`") — `parseEvent` returns `null` for unknown/junk lines and never throws, so
new upstream event types cannot break a run. This is the loose coupling that makes the CLI
line protocol *more* stable to track than a versioned wire protocol.

**Line types 1.0.0 emits on `streaming-json` that we tolerate but do not read:**
`tool_call`, `tool_call_update`, `available_commands`, `max_turns_reached`, and the
auto-compact lifecycle lines (`reducer/acp.rs`, `reducer/mod.rs:41-72`). All are single-line
compact NDJSON — none can break the `startsWith("{")` + `JSON.parse` path. `tool_call` is the
one worth revisiting: see Part 4. `tests/grok/fake-grok.mjs` (`conf-noise`) emits a real
`tool_call`/`tool_call_update` pair so this tolerance is a regression test, not a claim.

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
- **`--read-only`** → `--sandbox read-only`: no-write (only `~/.grok` + temp writable, whole
  workspace readable). On Linux this now **requires bubblewrap** and refuses to start without it
  (caveat 2a); starting is *not* proof it is enforcing (caveat 2b).
- `--always-approve` stays on in both modes — orthogonal layer: it auto-answers read-tool prompts;
  the sandbox is what actually blocks writes underneath (when it applies).
- **Resume**: `--read-only` on a resume of a session with a *persisted, differing* profile makes
  grok **`exit(1)`** (`SandboxStartup::Conflict`, constructed `cli.rs:883`, handled `main.rs:1694`)
  — a session's profile is fixed at creation. A legacy/unresolved session with **no** saved
  profile returns `None` (`persistence.rs:739`) and grok just applies the requested read-only
  (`cli.rs:888`). Fail-closed on a real conflict beats silently ignoring the request; for the
  common case start a fresh `--read-only` job. (Resuming a read-only session *with* `--read-only`
  matches → fine.)

**⚠️ `--read-only` is still not a hard guarantee, and it can now REFUSE TO START** (both are
why it stays opt-in rather than a codex/antigravity-style default):
1. **A managed `requirements.toml` overrides it.** `resolve_profile` precedence is
   `requirement > CLI > env > config > "off"` (`config.rs:1123`); upstream test
   `sandbox_requirements_pin.rs` pins that `--sandbox read-only` *loses* to a requirement. So a
   managed `workspace`/`off` profile can permit writes despite the flag.
2. **THREE modes, not one. Startup is fail-CLOSED on Linux/macOS; enforcement is still
   fail-OPEN; Windows has neither.** Collapsing these into a single "fails closed" claim is
   wrong in the dangerous direction — two successive `0.6.0` drafts did exactly that, each
   caught by independent review. Keep them separate.

   **2a. Startup — fail-closed (new in 1.0.0).** read-only is a hook-write-deny-enforcing profile:
   `profile_enforces_hook_write_deny` is true for **everything except `devbox` and `off`**
   (`xai-grok-sandbox/src/hook_write_deny.rs:19-21`, falling through `lib.rs:49-60`, which
   carries **no** `#[cfg(feature="enforce")]` gate — unlike `requires_read_deny`). So
   `requires_bwrap` is TRUE for read-only (`xai-grok-shell/src/config/mod.rs:1486`) and grok
   re-execs itself under `bwrap --cap-drop ALL`. Every failure path is now `exit(1)`, not a
   warning: `cmd.exec()` fails → `Refusing to start with denied paths unprotected.` +
   `Install bubblewrap with 'apt install -y bubblewrap'` (`config/mod.rs:1495-1504`); no deny
   plan could be prepared (`:1524-1529`); in-bwrap verification fails (`:1512-1522`); macOS
   Seatbelt cannot apply (`:1536-1541`, `:1549-1562`). **Confirmed live, not tree-only** —
   `strings $(which grok) | grep 'Refusing to start with denied paths'` hits on `1.0.0`.
   Practical consequence: **bubblewrap is a de-facto prerequisite for `--read-only` on Linux**;
   without it the job dies at startup with an empty result. `classifyError` buckets that
   stderr as `config` (added in `0.6.0`) so the user sees the actionable cause.

   **2b. Enforcement (Linux) — still fail-OPEN, so read-only is still not a guarantee.** Getting past
   startup does NOT mean writes are blocked. bwrap binds `/` **read-write** and only
   `--ro-bind`s the protected paths (root RW bind `xai-grok-sandbox/src/lib.rs:319`;
   ro-binds `lib.rs:322`, hook leaves `hook_write_deny.rs:359`) — bwrap is the
   hook-protection layer, not the no-write layer. **Landlock** is what actually blocks writes,
   and when it is unsupported or fails to apply, `SandboxManager::apply` warns
   `"Sandbox not supported on this platform, continuing without sandbox"` /
   `"Sandbox could not be applied, continuing without sandbox"` and returns `Ok(())` with
   `applied = false` (`lib.rs:194` + `201`, `225` + `232`) — both strings are in the shipped
   1.0.0 binary. The refusal that would catch an unapplied sandbox is **skipped once we are inside
   bwrap**: `let unappliable = requires_protection && !sandbox.is_applied() &&
   !xai_grok_sandbox::is_inside_bwrap();` (`xai-grok-shell/src/config/mod.rs:1549-1553`) — and
   read-only is *always* inside bwrap by 2a. So on a kernel without Landlock, a `--read-only`
   run starts successfully and the workspace stays writable, with `--always-approve`
   auto-answering tool prompts.

   **2c. Windows — no sandbox and (for a fresh session) no refusal.** `SandboxManager::apply` is a stub for
   `#[cfg(not(all(feature = "enforce", unix)))]` that logs "Sandbox enforcement unavailable"
   and returns `Ok(())` (`lib.rs:236-243`), and the entire refusal block in the shell is
   `#[cfg(any(target_os = "linux", target_os = "macos"))]` (`config/mod.rs:1535`, `1546`).
   Upstream publishes Windows binaries (`README.md`), so on Windows a **fresh or
   same-profile** `--read-only` run starts normally and enforces **nothing** — neither 2a's
   refusal nor 2b's partial protection. The one exception is the resume-conflict exit(1)
   below: `resolve_startup_sandbox` is pure flag-vs-saved-profile comparison with **no cfg
   gate** (`cli.rs:1006`, handled `main.rs:1948`), so resuming a session persisted as a
   *different* profile refuses on every OS, Windows included.

   **Treat `--read-only` as hardening with a hard host prerequisite, never as a hermetic
   jail.**

   The hard `exit(1)` refusal used to fire only for read-*deny* profiles —
   `requires_read_deny(ReadOnly)` is **still** `false` (`lib.rs:430-441`); `strict` is **not** in that set
   either — but that is no longer the load-bearing predicate. **The old claim "read-only has no
   bwrap deny-plan, so on Linux it skips bwrap and goes straight to Landlock" is now FALSE.**
   read-only carries no *read*-deny list (`profiles.rs:406` `deny: vec![]`) but it does carry
   `write_deny: resolve_write_deny(self)` (`profiles.rs:407` → `hook_write_deny.rs:224-229`),
   which IS the hook plan — so `bwrap_deny_plan` returns a plan, the "nothing to bind" early
   return is not taken, and `bwrap_reexec_for_profile` hands back a real command
   (`lib.rs:491`, `543-552`, `566-585`). Treat `--read-only` as hardening plus a hard host
   prerequisite, not a hermetic jail.
3. **Network scope is child-process only.** grok leaves its **main** process online (it needs the
   LLM API), so in-process `web_search`/`web_fetch` **keep working** under `--read-only`
   (`lib.rs:10`). Only network from terminal-spawned **child** processes is blocked, via seccomp on
   Linux (`streaming_local_terminal.rs:916`). So `--read-only` does NOT break web research; it does
   stop a spawned `curl`/`wget` in a bash command.

The three upstream levers (strongest first):

| Mechanism | How | Strength | Source anchor | Used? |
| --- | --- | --- | --- | --- |
| **`--sandbox read-only`** (alias `readonly`, or `GROK_SANDBOX=read-only`) | FS sandbox; only `~/.grok` + temp writable, whole workspace readable; blocks **child-process** network (not in-process web tools) | **Refuses to start without bwrap (2a), but can still run un-enforced once inside it (2b)**; a managed requirement also outranks it | profile `profiles.rs:402-410`; writable paths `paths.rs`; flag decl `cli.rs:710-711`; startup gate `xai-grok-shell/src/config/mod.rs:1486-1562`; hook plan `hook_write_deny.rs:19-21,224-229` | ✅ what `--read-only` emits |
| `--disallowed-tools "search_replace,write,run_terminal_cmd,…"` | Removes write/exec tools from the toolset (keeps network + reads) | Medium — model can't call them, but not OS-enforced | `cli.rs:665` | available escalation |
| `--deny "Write(**)" --deny "Edit(**)"` | Permission-layer denial (tools exist, execution gated) | Weakest — cooperative | `cli.rs:469` | — |

Built-in sandbox profiles: `workspace`, `devbox`, `read-only`, `strict`, `off` (+ `Custom`)
(`profiles.rs`) — unchanged in 1.0.0; the resolved default when nothing is set is **`off`**, not
`workspace` (`config.rs:1132`). For a niche profile, set `GROK_SANDBOX=<profile>` — grok reads
it natively (`cli.rs:710-711`), and the plugin only injects `--sandbox` for `--read-only`, so it
won't clobber your env otherwise.

**Checked and NOT a problem:** the `deny/glob.rs` rewrite (740 lines, 1.0.0) added a
refuse-to-start path when `expand_deny_globs` fails — it cannot reach a `--read-only` run,
because read-only's deny list is empty (`profiles.rs:406`) so `has_globs` is false and the
expansion is never attempted (`lib.rs:508-524`). Proved, not assumed.

**Re-run recipe for BOTH halves of caveat 2** (no engine spend, works offline):
```bash
strings $(which grok) | grep -E "Refusing to start with denied paths|hook write-deny is required"  # 2a: startup fail-closed
strings $(which grok) | grep -E "continuing without sandbox"                                        # 2b: enforcement fail-open
```
Both hit on `1.0.0`. If 2b's string ever disappears, re-read `SandboxManager::apply` — that
would be upstream finally closing the enforcement gap, and this caveat would need rewriting.

---

## Part 4 — Known engine surfaces we deliberately do NOT wire (yet)

Verified real (source-anchored), useful later, currently unused — so nobody re-discovers them:

- **Tool-level observability — the `updates.jsonl` premise is OBSOLETE, this got cheap.**
  `tool_call` / `tool_call_update` are emitted **on the `streaming-json` stdout we already
  capture into the job log** (`reducer/acp.rs:40-61`, emitted `:110-126`; upstream fixture
  `docs/user-guide/14-headless-mode.md:218-219`). Shape:
  `{"type":"tool_call","toolCallId":…,"title":"Read","kind":"read","status":"in_progress",
  "toolName":"read_file","rawInput":{…},"content":[],"locations":[]}`; `toolName` is the
  canonical wire name (`bash`, `x_search`, `read_file`), resolved by `tool_name_from`
  (`reducer/mod.rs:180-199`), statuses `pending|in_progress|completed|failed` (`mod.rs:146-155`).
  Why it matters: `/grok:status` currently reports growing quiet time and "no output yet"
  during a long tool phase — i.e. a healthy job looks hung, which is the exact question that
  verb exists to answer. Wiring is ~3 lines: a `parseEvent` branch returning
  `{kind:"tool", text:`${toolName}: ${title}`}`; `extractResult` filters on `kind==="text"` so
  it is unaffected, and `liveness.mjs` picks the new event up for free via its
  `typeof e.text === "string"` scan. **Known ceiling to name before taking it:**
  `shared/lib/runtime/worker.mjs` stamps `raw: line` on every stored event, so a `write`/`edit`
  `tool_call` puts its whole `rawInput` into `events.jsonl`, which `collectLiveness` re-reads
  on every `/grok:status`. Do NOT parse `tool_call_update` (its `rawOutput` is full command
  output), and do NOT touch `shared/lib/core/liveness.mjs` (antigravity shares it).
  Deferred only because it is P2, not because it is hard.
- **Durable session transcript `updates.jsonl`** — still real, now only useful for what the
  stdout stream cannot give: post-crash result recovery and replay of a session we did not
  capture. Resume replays from it (`sampling-types/src/conversation.rs:216`) and compaction
  never rewrites it (`xai-chat-state/src/actor/mutations.rs:202-205`). Layout:
  `$GROK_HOME/sessions/<cwd-slug>/<sessionId>/updates.jsonl`; combined with our pre-minted `-s`
  (Part 1) the path is deterministic per job.
- **`--background-wait-timeout <secs>` (hidden, default 600) / `--no-wait-for-background`
  (hidden)** — `cli.rs:686-708`. Every `grok -p` run **waits, by default, up to 600s after the
  answer is done** for pending background bash/monitor tasks and background subagents, "so eval
  harnesses see full task completion"; a `monitor(persistent:true)` never completes and always
  burns the full timeout. During that window no `end` line has been emitted, so our job stays
  `running`, `/grok:status` shows growing quiet time and `/grok:wait` blocks. **This is the
  named first suspect for any future "grok job hangs at the end" report.** Deliberately not
  wired: both flags are `hide = true`, i.e. upstream reserves the right to change them.
- **`--fork-session` + a fresh `-s` on resume** — today a resume sends `-r <parent>` and no `-s`
  (`grok-companion.mjs` mints an id only for a new job), and `extractResult` stores the
  *parent's* `sessionId` on the child. So resume chains are linear and destructive: you cannot
  fork two follow-ups off one finished job, and each follow-up rewrites the parent's session.
  Upstream permits the fix explicitly — `-s` is "only valid together with `--fork-session`"
  when resuming (`cli.rs:588-598`). Two lines each side. Unwired because resume is used
  one-shot today; take it the first time someone wants branching follow-ups.
- **`--prompt-file` beyond the E2BIG guard** — we now swap to it above `PROMPT_ARGV_LIMIT`
  (see `adapter.mjs`). Not taken: `--prompt-json` (ACP content blocks) and passing the user's
  own `--prompt-file` straight through, because grok parses a `.json` prompt file as content
  blocks rather than text (`headless/cli.rs:58-69`) — the companion reading it as text and
  re-writing `prompt.txt` keeps one semantics for all inputs.
- **Correct skips, re-confirmed on 1.0.0** (do not re-litigate without a new reason):
  `--output-format streaming-messages-json` + `--include-partial-messages` (Anthropic Messages
  wire format — we already parse the ACP form fine, a genuine no-op for us);
  `--permission-mode auto|dontAsk` (inert at spawn); `--verbatim` (does NOT stop `@token`
  expansion); `--disable-web-search`; `--rules`; `--system-prompt-override`; `--agent`/`--agents`;
  `--disallowed-tools`; `--leader-socket`; and the subcommands `du`/`disk-usage` (not even in the
  shipped binary), `export`, `sessions`, `trace`, `models`, `doctor`, `inspect`, `update`,
  `plugin`, `worktree`.
- **`GROK_AUTH_PATH`** — env override for the auth file, independent of `GROK_HOME`
  (`xai-grok-shell/src/cli_models.rs:103/112`). How isolated-HOME setups keep real login
  without copying credentials; we delegate auth to the CLI and don't need it today.

---

## Audit log

| Date | Grok tree | Verdict | Notes |
| --- | --- | --- | --- |
| 2026-07-16 | `c68e39f` / bin `0.1.220-alpha.4` (released `grok 0.2.93`) | **none** | First source-grounded audit after open-sourcing. All 11 flags + all read fields pinned to anchors, zero drift. Same pass added `usage` capture (`{inputTokens,outputTokens}`) — the old "grok emits no token counts" assumption was stale; `attach_result_usage` now stamps usage on `end`/json/error. Documented read-only sandbox levers (Part 3). |
| 2026-07-16 | (same tree) | **none** | `grok@0.4.0`: wired an **opt-in `--read-only`** (`--sandbox read-only`). NON-breaking — default unchanged (`off`, full access). Opt-in (not a codex/antigravity-style default) because read-only is **best-effort**: a managed `requirements.toml` overrides it (`config.rs:1123`) and it fails *open* to writable when no OS backend applies (`lib.rs:143`) — a false-confidence default. Independent Codex review (session `019f6b69`) corrected several prior-draft errors, all verified against source: (1) read-only does **not** disable web tools — network restriction is **child-process only**, grok's in-process `web_search`/`web_fetch` stay online (`lib.rs:10`, `streaming_local_terminal.rs:916`); (2) default is `off` not `workspace` (`config.rs:1132`); (3) enum is `SandboxStartup::Conflict`+`exit(1)`, constructed `cli.rs:883` (not `Refused`), and only on a *persisted* differing profile — a no-saved-profile session applies read-only (`persistence.rs:739`, `cli.rs:888`); (4) read-only skips bwrap (no deny-plan) → Landlock directly, `strict` not in the read-deny set (`lib.rs:359`); (5) usage is captured from `end`/json only, not error events; (6) anchors: reasoning-effort `525`, `--sandbox` decl `674`. |
| 2026-07-24 | `~/research/grok-build` @ `c68e39f` (same tree, re-verified) + released `grok 0.2.111` | **none** | Wired `-s`/`--session-id` (`cli.rs:582`, adopted in headless at `headless.rs:608/617`) so a session id is minted client-side (`crypto.randomUUID()`) and persisted into the job record's `request` BEFORE the engine spawns — a worker crash mid-run (no `end` event) no longer loses the id needed to `-r`/`--resume`. Sent only for a brand-new conversation; always mutually exclusive with `-r` (grok rejects `--session-id` + `--resume` without `--fork-session`, which this plugin never passes). Local released binary `grok 0.2.111 --help` cross-checked the flag exists. |
| 2026-07-24 | (same tree, wave 2) | **none** | Wired three more opt-in flags: (1) **`--research`** → `--tools x_search,web_search,web_fetch --deny MCPTool` — `--tools` (`cli.rs:620`) is an **authoritative** allowlist (`apply_to_definition` overwrites `def.tools` outright, `config.rs:1564-1573`/`1576-1587`; hosted-tool gate `hosted_tool_allowed`, `xai-grok-agent/src/config.rs:1349-1357`, canonical names `builder.rs:1175-1182`/`conversation.rs:495`), stronger than `--sandbox read-only`'s best-effort FS guarantee; MCP tools are NOT proven covered by `--tools` (headless always loads user MCP servers, `headless.rs:615/660`), so `--deny MCPTool` (`cli.rs:476`) rides along as a cooperative backstop only — documented as two distinct guarantee tiers, not conflated. (2) **`--max-turns <n>`** (`cli.rs:627`, clap range `1..`) as a runaway-cost fuse for unattended background jobs. (3) **`--no-memory`** (`cli.rs:611`, `conflicts_with=experimental_memory`, never sent) so a one-off delegated task doesn't touch the user's cross-session grok memory. All three are per-invocation behavior flags (not session identity) — orthogonal to `--read-only`/`--no-subagents`/resume, no mutual exclusion needed; verified against the same `c68e39f` tree, no drift. |
| 2026-08-09 | `8a14c91` / `SOURCE_REV 27b3c666` / pager-bin `1.0.0` (released `grok 1.0.0`) | **should-upgrade** → fixed in plugin `0.6.0` | First audit since the `0.2.111 → 1.0.0` jump (10 public releases in 16 days; 23 tree syncs since `c68e39f`). Method: 6 parallel source-grounded dimensions + adversarial refutation of every actionable finding; one finding (capture `num_turns`/`total_cost_usd`) was refuted and dropped as already-deliberate. **1.0.0 is NOT a breaking major** — upstream's own `xai-grok-shell/CHANGELOG.md` (which this doc had never noticed) records zero `breaking_change: true` for it. **No contract breakage:** all 17 flags present with identical names/aliases/enums/conflict sets, verified against source AND verbatim `--help` AND a parse-only run of the real binary; every field we read survived the `headless/reducer/` refactor byte-for-byte (`rename_all="snake_case"` renames variants, not fields), `usage` keys still snake_case, all new line types tolerated. **The real find: `--sandbox read-only` gained a fail-closed STARTUP gate while its ENFORCEMENT stayed fail-open** (`hook_write_deny.rs`, added upstream in `69f0ba8`) — see Part 3 caveat 2a/2b; four plugin surfaces promised plain fail-open and are corrected, `classifyError` gained a `config` bucket for the refusal, and bubblewrap is now documented as a Linux prerequisite. **TWO rounds of independent Codex review (session `019fe6d7`) were needed, and each caught a real defect in the previous round's fix** — recorded here because the failure mode repeated: round 1 caught the first draft collapsing 2a/2b into a flat "fails CLOSED" (an overstatement in the dangerous direction — bwrap binds `/` read-write and a kernel without Landlock runs writable); round 2 caught that even the corrected 2a/2b **still** over-generalised by omitting **2c (Windows: stub `apply`, no refusal compiled, so no enforcement at all)**. Round 1 also found: the `structuredOutputError` branch returned a bare error event, discarding `sessionId`/`usage` (job unresumable, cost unrecorded); a bare `/sandbox/` alternative in `classifyError` stole `not-installed`; the E2BIG test pinned 131072 (wrong on 64 KiB-page kernels); and the prompt-file test never ran the worker. Round 2 found: `classifyError`'s sandbox check still preceded `endpoint`/`not-installed`, so `GROK_BIN=/opt/bwrap/grok` → `spawn … ENOENT` was still stolen (fixed with two tiers: the unambiguous `Refusing to start` phrase matched **first**, above every bucket, because the refusal text embeds user-controlled paths verbatim — a hooks-path of `/tmp/quota` would otherwise read as a quota error; the broad word-net stays **last** as a wording-change fallback, since those words also appear in ordinary paths); the `ponytail:` comment recorded the wrong-`error` problem instead of fixing it (fixed by adding an optional `error` to the `extractResult` contract in `shared/lib/`, which the worker now prefers over `stderrTail` — additive, no other adapter sets it); and the new worker test used a 400 KB prompt that a 64 KiB-page kernel would pass with the swap disabled, while the fake's 60-char echo could not detect a truncated prompt (fixed: 3 MiB prompt + an exact byte-count assertion; verified to fail when the swap is disabled). Also fixed: `--effort` advertised 4 tokens (`none\|minimal\|xhigh\|max`) that grok-4.5's catalog rejects at runtime (live cache `~/.grok/models_cache.json` offers only `low\|medium\|high`); a `--json-schema` run with no structured output exited 0 and returned un-schema'd prose (now fails via `structuredOutputError`); `commands/task.md` advertised a nonexistent model id `grok-composer-2.5-fast`; the inline-prompt `ponytail:` comment named ARG_MAX (~2MB) when the real ceiling is MAX_ARG_STRLEN (131071 B — measured 131071 ok / 131072 `spawn E2BIG`), reachable via `/grok:task --prompt-file`, so oversized prompts now swap to `--prompt-file <jobDir>/prompt.txt`; and `tests/grok/fake-grok.mjs` still emitted CamelCase `stopReason` where 1.0.0 emits snake_case — a green suite against fiction. **Bookkeeping correction:** `.git/logs/HEAD` proves the local clone was never fetched between the 2026-07-16 clone and 2026-08-02, so the 2026-07-24 rows' "same commit, no upstream drift" was really "never fetched" — upstream had shipped 8 syncs by then, and the fail-closed switch was already live. The clone's previous HEAD `a422116` was likewise never audited, so this pass diffed from `c68e39f`; `a422116..HEAD` hides both `headless/reducer/` and `hook_write_deny.rs`. Step 0 of "How to keep this current" now forces a fetch. |
