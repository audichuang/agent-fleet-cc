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
2. **Re-verify the durable checklists below** — Part 1 (flags sent), Part 2 (output read) and
   Part 5 (stderr we bucket); Parts 1, 3 and 5 each carry their own offline re-check recipe. If
   Grok renamed, removed, or changed the value-enum of anything on them, that is a breaking
   drift — fix the adapter, add a regression test, bump the plugin version.
3. **Prefer the *released* binary as ground truth.** The open-source tree is a *periodic
   snapshot* of the monorepo (README: "synced periodically") — it may lead/lag the `grok` you
   actually invoke. Confirm suspicious drift by running the real binary, not just reading
   source — but **not with `--help` alone**: three flags we send are `hide = true`, so `--help`
   reports them as absent. Use Part 1's parse-only probe (free, offline) and keep a real
   headless call for behaviour only. See the `e2e-testing` skill for the real-engine smoke
   check.
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
| Plugin | `plugins/grok/` @ `0.7.0` (`npm run check-version`) — the 2026-08-23 first-pass fixes plus `/grok:image` shipped in it; the second-pass corrections below are on top of it |
| Released binary we invoke | `grok 1.0.5 (5115b46bc9)` — verified 2026-08-23 by `grok --version`. **Stale-data fix only:** the doc had carried `1.0.0 (3cd0d0cbce) [stable]` since 2026-08-09. Do **not** read the vanished `[stable]` suffix as drift in something we depend on. `cli.rs:413` did swap clap's `version` to `xai_grok_version::full_version()`, but that returns a plain version string either way (`xai-grok-version/src/lib.rs:27-28`); `[stable]` comes from `xai_grok_update::channel_label()` (`xai-grok-update/src/version.rs:589-600`), which returns `""` whenever no channel pointer is cached (`:595`, documented `:586` and `:514-525`) — **cache state, not the swap**. Either way it is cosmetic: `grok-companion.mjs` only echoes the string. |
| Provenance of behavioral claims | **Re-proven 2026-08-23:** every flag we send parses on 1.0.5 (parse-only probe, recipe under Part 1); every error string Parts 3 and 5 key on is present in the shipped binary (`strings -a`); the contract-file diffs quoted in the rows below. **Carried forward, NOT re-run:** the `classifyError` `auth` / `quota` buckets, verified by *running* `0.2.93` (2026-07-16). The `endpoint` bucket was likewise not re-run — it was re-read against source this pass and found **dead**; see Part 5. The sandbox-refusal bucket remains source + `strings` only, never triggered. The Imagine surface in Part 4 was **live-verified 2026-08-23** (one real generation on `grok 1.0.5`: registration via `available_commands`, the `tool_call_update` wire shape, the `ImageGen` `rawOutput` fields, tool events reaching the raw log). The one exception is the **tier-restricted** branch, still inference — the account under test has SuperGrok, so the short-circuit never fired. **Second pass, same day (doc-only re-verification, no new upstream diff):** additionally **re-proven** — grok's headless auth chain fails closed **at method selection** (`headless.rs:459`, `:466-472`, `:474-479`, `:899-900`, `pager-bin/src/main.rs:1901-1908`); **narrowed again in the fourth pass** — that covers the *no method advertised* case only, and a stale advertised `cached_token` still reaches interactive OAuth for 600s (Part 4 auth reading 4), the 403-is-not-auth pair (`shell/sampling/error.rs:127-136` + the `forbidden_is_not_auth_error` test at `sampling-types/error.rs:1197-1219`), `resolve_image_gen`'s full precedence chain incl. the managed requirement pin (`agent/config.rs:2631-2656`), the `0700` site (`storage.rs:64-71`), and the deployment-key surface (`agent/config.rs:186-189`/`:554`, `managed_config.rs:453-471`). Newly **carried forward unproven:** whether a deployment-key-only setup can complete a headless task (untested, and moot for the plugin now that nothing plugin-side inspects auth). |
| Open-source tree audited | commit `9fabade` ("Synced from monorepo") — the tree matching the **installed** `grok 1.0.5`. Diff base for this pass: `8a14c91` (the 2026-08-09 baseline = `grok 1.0.0`), so the contract diff that matters is `8a14c91..9fabade`. Source tree at `~/research/grok-build`. |
| Tree vs binary | Two axes, kept apart on purpose — conflating them is exactly how a wrong baseline once produced a false "no drift" verdict. **What we run:** `9fabade` *is* the installed binary. **Tree leads binary:** local HEAD is `19d42e3` (version 1.0.6), and `9fabade..19d42e3` changes **nothing** in any contract file — verified empty via `git diff --stat 9fabade 19d42e3 -- crates/codegen/xai-grok-pager/src/app/cli.rs .../headless.rs .../headless/ crates/codegen/xai-grok-sandbox/ crates/codegen/xai-grok-shell/src/config/mod.rs`. The previous row's only stated divergence is **dead**: 1.0.5's `--help` *does* expose `du`/`disk-usage` (checked on the installed binary). |
| Flag inventory (replaces the old "43 visible flags" claim) | The old line "all 43 visible `PagerArgs` flags match `--help` 1:1" is **dropped**. Not because the arithmetic broke — `grok --help \| grep -cE '^\s+(-[a-zA-Z], )?--'` returns **41** on 1.0.5, and 41 + the 2 newly-hidden memory flags reconstructs the old 43 — but because the old line recorded no counting method, which makes the number unfalsifiable, and as written it no longer matches `--help` on the binary we run. (Method recorded here so the next pass can at least reproduce *this* number.) Scoped, verified replacement: the `8a14c91..9fabade` `cli.rs` diff **adds and removes no visible `PagerArgs` flag** — it only sets `hide = true` on `--experimental-memory` / `--no-memory` (visible 43 → 41). The "visible `PagerArgs`" scoping is load-bearing: the same diff *does* add two flags outside that scope — hidden `--trigger` and `--auto` on the `grok update` subcommand, which the plugin never invokes. |
| Contract files | `crates/codegen/xai-grok-pager/src/app/cli.rs`, `.../src/headless.rs`, **`.../src/headless/cli.rs`** (`OutputFormat`, `parse_json_schema`, `parse_permission_rules_strict`, prompt-file parsing — moved out of `headless.rs`), **`.../src/headless/reducer/{mod,acp}.rs`** (the NDJSON emitter), `.../xai-grok-sandbox/src/{profiles,lib,hook_write_deny}.rs`, `.../xai-grok-shell/src/config/mod.rs` (sandbox startup gate) |
| Verdict | **should-upgrade** (2026-08-23, binary `1.0.0 → 1.0.5`): nothing we send is rejected and nothing we read was renamed — `headless/cli.rs` and `headless/reducer/` are **byte-identical** across `8a14c91..9fabade`, so Part 2 has zero drift — but four *pre-existing* defects surfaced and were fixed, plus a Part 1/Part 3 anchor refresh and the newly-wired `/grok:image` surface. **A second pass the same day** (independent Codex review of the first pass's commits, every claim re-verified by the host against the bytes) then **deleted the auth preflight the first pass had just hardened** — grok's headless path fails closed on its own *when no auth method resolves* (Part 4; a stale advertised token is the exception, covered later by the opt-in stall guard) — corrected `classifyError` again (403 out of `auth`, the failed-resume token narrowed, the bare `relay` token dropped), and hardened `/grok:image`'s success gate. See the two newest Audit-log rows. *(Superseded 2026-08-09 verdict, kept for continuity: `--sandbox read-only` gained a fail-closed startup gate while its enforcement stayed fail-open, and the plugin documented neither correctly — fixed in `0.6.0`.)* |

---

## Part 1 — Flags we send (durable checklist)

Built by `adapter.mjs → buildInvocation`. Every anchor below was re-read at `9fabade`
(= the installed `grok 1.0.5`) on 2026-08-23; the previous pins were off by +8..+16 lines.

**Evidence class — `--help` is NOT a valid cross-check for every row.** Three flags in this
crate are `hide = true`: `--no-auto-update`, `--no-memory`, and `--experimental-memory` (which
we never send). On 1.0.5 `grok --help | grep -c no-memory` returns **0**, so a future `--help`
sweep would wrongly read a flag we still send as *removed*. Use the parse-only probe instead —
it covers hidden and visible flags alike, spends no engine quota and touches no network:

```bash
# Control FIRST — without it, "exit 0" proves nothing.
grok --definitely-not-a-flag --help >/dev/null 2>&1; echo $?   # 2  ("unexpected argument")
grok --no-memory --help             >/dev/null 2>&1; echo $?   # 0  (hidden, still parsed)
# The whole argv we ever send, in one parse:
grok --no-memory --no-subagents --no-auto-update --no-alt-screen --always-approve \
     --output-format streaming-json -m grok-4.5 --reasoning-effort high --max-turns 3 \
     --tools x_search,web_search,web_fetch --deny MCPTool --sandbox read-only \
     -s 11111111-1111-4111-8111-111111111111 --cwd /tmp --help >/dev/null 2>&1; echo $?  # 0
```

Run 2026-08-23 against `grok 1.0.5`: control `2`, the send-argv line `0`. `-p` (with
`--json-schema`), `--prompt-file` and `-r` were probed separately — all `0` — because clap
declares them mutually exclusive with each other, not because they are any less verified.

| Flag we send | `app/cli.rs` anchor @ `9fabade` | Semantics | Status |
| --- | --- | --- | --- |
| `-p <prompt>` | `short='p', long="single"` (485-486; `conflicts_with_all` prompt_json/prompt_file 489-490) | Headless single prompt; triggers headless mode | ✓ |
| `--output-format streaming-json` | `long="output-format", value_enum, default "plain"` (514); enum decl `headless/cli.rs:9-19` (**byte-identical** to baseline) | Enum is FOUR-valued: `plain`\|`json`\|`streaming-json`\|`streaming-messages-json` (the 4th is the Anthropic Messages API wire format — purely additive, we keep sending `streaming-json`). The `streaming-json` doc comment reads "NDJSON of the agent native ACP session updates" (`headless/cli.rs:13`); wording only, the emitted line shapes are unchanged (Part 2). | ✓ |
| `--json-schema <SCHEMA>` | `long="json-schema"` (523) | Structured output; **implies** `--output-format json` (doc comment 520-522) | ✓ |
| `--always-approve` | `long="always-approve", alias="yolo", alias="dangerously-skip-permissions"` (459-461; `AgentArgs` copy 285) | Auto-approve all tools (== `--yolo` == `--permission-mode bypassPermissions`) | ✓ |
| `--no-auto-update` | `long="no-auto-update", hide=true` (748) | Suppress update check. **Hidden** — parse-only probe, never `--help` | ✓ |
| `--no-alt-screen` | `long="no-alt-screen"` (761) | Run inline, no alternate screen | ✓ |
| `-m <MODEL>` | `short='m', long="model"` (526; `AgentArgs` copy 274) | Model id. See the effort row for why no client-side model list lives here | ✓ |
| `--cwd <DIR>` | `#[arg(long)] pub cwd` (436-437) | Workspace root (long auto-derived from the field name). The *other* `pub cwd` in this file, at 252, is **`WorkspaceStartArgs`** (`grok workspace start`), **not** `AgentArgs` — `AgentArgs` (265-353) has no `cwd` at all. | ✓ |
| `--reasoning-effort <LVL>` | `long="reasoning-effort", visible_alias="effort"` (`PagerArgs` 530; the 278 hit is `AgentArgs`) | Clap/`FromStr` accept all seven canonical levels (`sampling-types/src/types.rs:829-846`), but **the model's own catalog decides**: a canonical level the model does not offer is rejected *after* the session opens — `resolve_effort_token_for` (`acp/model_state.rs:201`) yields `EffortTokenError::UnknownToken` (`:23`, raised `:238`) → `headless.rs:684` `bail!("--effort/--reasoning-effort: …")`. The 1.0.0 `needs_fresh_catalog` refresh (`headless.rs:1056-1074`) does not rescue an unknown canonical token — it short-circuits on any canonical token and only widens acceptance for non-canonical *menu ids*. **Durable rule (this doc no longer enumerates levels — the enumeration rotted twice in 14 days):** which effort levels exist is a **per-model, remote** fact, and `grok models` is the only authority. Do not write a level list into this doc, the plugin, or a test fixture; `plugins/grok/commands/task.md` now says exactly that instead of advertising tokens. | ✓ |
| `--no-subagents` | `long="no-subagents"` (652) | Disable fan-out (deterministic single agent) | ✓ |
| `--sandbox read-only` | `#[arg(long, env="GROK_SANDBOX")] pub sandbox` (726) | Emitted only on opt-in `--read-only` — see Part 3 | ✓ |
| `-r <ID>` | `short='r', long="resume"` (560-567) | Resume an existing session (or a title match; UUID-shaped values always mean ids) | ✓ |
| `-s <UUID>` | `short='s', long="session-id"` (601) | Use a specific session UUID for a **new** conversation (valid UUID, must not already exist under the target session directory); with `--resume`/`--continue` only valid together with `--fork-session` (596-606), which we never pass — so always mutually exclusive with `-r` here. Minted client-side (`crypto.randomUUID()`) and persisted to the job record BEFORE spawn, so a worker crash mid-run still leaves a resumable id. headless.rs wires it through: `session_id_flag` param (530), consumed (537). | ✓ |
| `--tools x_search,web_search,web_fetch` | `long="tools"` (678, "Built-in tools to allow (comma-separated)") | Emitted only on opt-in `--research`. **Authoritative**, not cooperative: `CliAgentOverrides.tools` → `apply_to_definition` overwrites `def.tools` outright for the main agent (`xai-grok-shell/src/agent/config.rs:1600`, the assignment at `:1602`); subagents get the session-clamped variant instead (`:1618-1619`). Every non-listed built-in tool (shell/edit/write/read/…) does not exist for the run — stronger than `--sandbox read-only`'s best-effort FS enforcement. Hosted tools gate through the same allowlist (`hosted_tool_allowed`, `xai-grok-agent/src/config.rs:1411`); canonical names `builder.rs:1175-1182`, `HostedTool::XSearch => "x_search"` (`sampling-types/src/conversation.rs:495`). | ✓ |
| `--deny MCPTool` | `long="deny", alias="disallowedTools"` (476-482; permission-layer deny rule, same tier as Part 3's `--deny` rows) | Emitted alongside `--tools` on `--research`, as a **cooperative backstop only**: headless always loads the user's configured MCP servers regardless of `--tools` (`headless.rs:534-535`, again `:581-582`), and nothing in source proves the `--tools` whitelist covers MCP-provided tools — so this is weaker than the built-in-tool guarantee above, not a hard block. Rule syntax verified: a bare tool name (no parens) is the valid tool-wide form — `parse_permission_rule` (`xai-grok-workspace/src/permission/rules.rs:156`) falls through its `mcp__` branch (245-266) to the no-paren path, and `tool_name_to_filter` (`:286`) maps `"MCPTool"` → `ToolFilter::Mcp` (`:291`), so the strict startup parser (`parse_permission_rules_strict`, `headless/cli.rs:145`, re-exported `headless.rs:42`, called `headless.rs:819`) cannot reject it and kill every `--research` spawn. | ✓ |
| `--max-turns <n>` | `long="max-turns"` (684-688: `value_parser` `u32` range `1..`, "Maximum number of agent turns") | Opt-in runaway-cost fuse. `CliAgentOverrides.max_turns` (`headless.rs:820`). The companion validates a positive integer before job creation; grok's own clap range has the same floor. | ✓ |
| `--no-memory` | `long="no-memory", conflicts_with="experimental_memory"`, **`hide = true`** (664-670); doc string is now "Legacy compatibility flag for disabling cross-session memory." | **INERT in headless — the flag alone was a false ✓ from 2026-07-24 until 2026-08-23.** `-p` dispatches `headless::run_single_turn` (`xai-grok-pager-bin/src/main.rs:2186`), and that path hardcodes `memory_enabled_override: None` (`headless.rs:795`; `HeadlessOptions` has no memory field at all). `PagerArgs::memory_enabled_override()` has exactly two non-test consumers, both inside the **interactive** `crate::acp::ConnectFlags` literal (`xai-grok-pager/src/app/mod.rs:795`, with `memory_override_flag` at `:796`, literal opened `:793`). So memory resolves with the CLI tier empty: `BoolFlag::env("GROK_MEMORY").cli(None).config(memory.enabled).feature_flag(remote).default(false)` (`xai-grok-config-types/src/memory.rs:607-612`), precedence `requirement > cli > env > config > managed > remote > default` (`config-types/src/flags.rs:109-136`). **The env tier is therefore the only one that can beat a user's `[memory] enabled = true`** — pinned by upstream's own test, "GROK_MEMORY=0 should force-disable even when TOML enables memory" (`xai-grok-shell/src/config/tests.rs:283`). **Plugin status: flag inert in headless; enforced via `GROK_MEMORY=0` in the spawn env.** `buildInvocation` keeps `--no-memory` in argv (`adapter.mjs:202` — costs nothing, covers upstream ever wiring it through) and injects `GROK_MEMORY: "0"` into the returned `env` (`adapter.mjs:222`), placed last so it also beats a `GROK_MEMORY=1` inherited from the user's shell. **Evidence class for this row is NOT `--help`:** `hide = true` means `grok --help \| grep -c no-memory` → **0** on 1.0.5, so re-check it with the parse-only probe above, the way `--no-auto-update` already is. | ✓ (via env) |

## Part 2 — Output we read (durable checklist)

Parsed by `adapter.mjs → parseEvent` / `extractResult`. Pinned to `headless.rs`.

**Zero drift, re-verified 2026-08-23 (`8a14c91..9fabade`).** `headless/cli.rs` and
`headless/reducer/` are **byte-identical** across that range (`git diff --stat` empty), and every
`headless.rs` anchor below still resolves at `9fabade` — the one pin that did drift is the
**aux**-crate hop for usage (`extensions/notification.rs`, re-pinned in its row: the fail-closed
wrapper is `:395`, the projection `:312`). `attach_result_usage` (`headless.rs:381`)
still projects snake_case `input_tokens` / `output_tokens` (`notification.rs:334`/`:338`); the `--json-schema` path still
coerces to `--output-format json` and still exposes `.text` / `.structuredOutput` /
`.structuredOutputError`. This Part needed no re-pinning — Parts 1 and 3 did.

| Field / event we read | headless.rs anchor | Notes | Status |
| --- | --- | --- | --- |
| `{"type":"text","data":…}` | `on_text_chunk` (240) → `reducer/acp.rs:108` `AcpLine::Text{data}` | We concat `.data`. `#[serde(tag="type", rename_all="snake_case")]` (`acp.rs:32`) renames the VARIANT, not the field — `data` survives. | ✓ |
| `{"type":"thought","data":…}` | `on_thought_chunk` (258) → `reducer/acp.rs:109` | We ignore it (raw line stays in log) | ✓ |
| `{"type":"end","stopReason","sessionId","requestId","usage",…}` | `on_end` (305) → `reducer/acp.rs:161-173` `AcpEndLine` (decl `acp.rs:89-100`) | Terminal event; we trust exit-code + presence of `end`, not a specific `stopReason`. **`stopReason` values are snake_case as of 1.0.0** — `end_turn\|max_tokens\|max_turn_requests\|refusal\|cancelled` (`headless.rs:385-403` `stop_reason_wire`, which warns + degrades to `end_turn` on an unknown future variant). Nothing in the adapter compares the value, which is exactly why that rename was a non-event; `requestId` is additive and unread. | ✓ |
| `{"type":"error","message",…}` | `on_error` (357) → `reducer/acp.rs:175-189` | grok emits errors on **stdout** in json modes; we capture so the message survives | ✓ |
| json result: `text`/`stopReason`/`sessionId`/`structuredOutput` | `build_json_result` (283-300), `attach_structured_output` (269-280) | `--json-schema` mode: one pretty-printed object; `.text` = JSON string, `.structuredOutput` = parsed. `requestId` and `thought` are additive and unread. Still pretty-printed and still ends on a bare `}` — which is what `parseEvent`'s jsonMode buffering heuristic keys on. | ✓ |
| **`structuredOutputError`** | `headless.rs:270-280` (`unwrap_or_else(\|\| Err("model did not produce structured output"))`) → `reducer/mod.rs:33-36` | **Read as of plugin 0.6.0.** A `--json-schema` run whose model answered in prose still **exits 0**, signalling the failure only by stamping `structuredOutput:null` + this field. Before 0.6.0 the job was recorded `completed` with the un-schema'd prose as `resultText`. `parseEvent` now flags it on the json event (`structuredError`) and `extractResult` gates `ok` on it — deliberately NOT a `kind:"error"` event, which would discard `sessionId`/`usage` and leave the job unresumable with its cost unrecorded. `extractResult` also returns the reason as the optional `error` field the shared worker now prefers over `stderrTail` (added to `shared/lib/` in the same pass), because grok exits **0** here and the fallback would otherwise persist "engine exited nonzero" on an exit-0 job. `classifyError` buckets it `config`. | ✓ |
| `usage.{input_tokens,output_tokens}` | `attach_result_usage` (`headless.rs:381`) → `notification::attach_result_usage_fail_closed` (`xai-grok-shell/src/extensions/notification.rs:395`) → `project_result_usage` (`:312`, the snake_case keys at `:334` / `:338`) | Captured from the `end` event and the json result; normalized to `{inputTokens, outputTokens}` for the job record. *(Upstream also stamps usage on error events, but our error branch keeps only `message` — a failed job's cost is low-value, so error-usage is not surfaced. Also available-but-unread: `cache_read_input_tokens`, `total_tokens`, `num_turns`, `modelUsage`, `total_cost_usd`/`_ticks`.)* | ✓ |

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
  *no sandbox at all*, full read + write + network (`xai-grok-shell/src/agent/config.rs:1194`: `resolve_profile`
  falls back to `"off"` when no flag / `GROK_SANDBOX` / config profile is set). This is the pre-0.4.0
  behavior, preserved.
- **`--read-only`** → `--sandbox read-only`: no-write (only `~/.grok` + temp writable, whole
  workspace readable). On Linux this now **requires bubblewrap** and refuses to start without it
  (caveat 2a); starting is *not* proof it is enforcing (caveat 2b).
- `--always-approve` stays on in both modes — orthogonal layer: it auto-answers read-tool prompts;
  the sandbox is what actually blocks writes underneath (when it applies).
- **Resume**: `--read-only` on a resume of a session with a *persisted, differing* profile makes
  grok **`exit(1)`** (`SandboxStartup::Conflict`, enum decl `cli.rs:806`, constructed `:1046`
  inside `resolve_startup_sandbox` `:1040-1053`, entry `startup_sandbox_profile` `:958-960`,
  handled `xai-grok-pager-bin/src/main.rs:1953-1954`)
  — a session's profile is fixed at creation. A legacy/unresolved session with **no** saved
  profile returns `None` (`resumed_session_sandbox_profile`, `persistence.rs:731`, inner
  `:738-761`) and grok just applies the requested read-only (the `(Some(x), _)` arm,
  `cli.rs:1051`). Fail-closed on a real conflict beats silently ignoring the request; for the
  common case start a fresh `--read-only` job. (Resuming a read-only session *with* `--read-only`
  matches → fine.)

**⚠️ `--read-only` is still not a hard guarantee, and it can now REFUSE TO START** (both are
why it stays opt-in rather than a codex/antigravity-style default):
1. **A managed `requirements.toml` overrides it.** `resolve_profile` precedence is
   `requirement > CLI > env > config > "off"` (`xai-grok-shell/src/agent/config.rs:1184-1195`
   — doc comment `:1184`, the `"off"` fallback `:1194`). **Anchor correction, 2026-08-23:** this
   doc used to cite a bare `config.rs:1123` / `:1132` for `resolve_profile`. That was a
   **pre-existing doc error, not upstream drift** — at the `8a14c91` baseline those lines were
   `pub struct HubConfig` and its `is_enabled` body; `resolve_profile` was already at
   `xai-grok-shell/src/agent/config.rs:1173` back then, and never moved file. Crate-qualified
   from here on, because three different `config.rs` files are cited in this doc. Upstream test
   `sandbox_requirements_pin.rs` pins that `--sandbox read-only` *loses* to a requirement. So a
   managed `workspace`/`off` profile can permit writes despite the flag.
2. **THREE modes, not one. Startup is fail-CLOSED on Linux/macOS; enforcement is still
   fail-OPEN; Windows has neither.** Collapsing these into a single "fails closed" claim is
   wrong in the dangerous direction — two successive `0.6.0` drafts did exactly that, each
   caught by independent review. Keep them separate.

   **2a. Startup — fail-closed (new in 1.0.0).** read-only is a hook-write-deny-enforcing profile:
   `profile_enforces_hook_write_deny` is true for **everything except `devbox` and `off`**
   (`xai-grok-sandbox/src/hook_write_deny.rs:18-20`, falling through `lib.rs:50-62`, which
   carries **no** `#[cfg(feature="enforce")]` gate — unlike `requires_read_deny`). So
   `requires_bwrap` is TRUE for read-only (`xai-grok-shell/src/config/mod.rs:1431`, literally
   `requires_read_deny || requires_hook_write_deny`) and grok re-execs itself under
   `bwrap --cap-drop ALL`. Every failure path is `exit(1)`, not a warning: `cmd.exec()` fails →
   `Refusing to start with denied paths unprotected.` + `Install bubblewrap with
   'apt install -y bubblewrap'` (message `config/mod.rs:1435-1438`, refusal `:1444-1450`); no
   deny plan could be prepared (`:1469-1475`); in-bwrap verification fails (`:1457-1467`, the
   `__GROK_INSIDE_BWRAP`-spoof guard); the profile could not be applied at all
   (`:1499-1507`, the arm macOS reaches too — see 2c for its `cfg` gate); hook mounts unverified
   after apply (`:1508-1518`, Linux). **Confirmed live, not tree-only** —
   `strings -a $(which grok) | grep 'Refusing to start with denied paths'` hits on the installed
   `1.0.5` (re-run 2026-08-23).
   Practical consequence: **bubblewrap is a de-facto prerequisite for `--read-only` on Linux**;
   without it the job dies at startup with an empty result. `classifyError` buckets that
   stderr as `config` (added in `0.6.0`) so the user sees the actionable cause.

   **2b. Enforcement (Linux) — still fail-OPEN, so read-only is still not a guarantee.** Getting past
   startup does NOT mean writes are blocked. bwrap binds `/` **read-write** and only
   `--ro-bind`s the protected paths (root RW bind `--bind / /` at
   `xai-grok-sandbox/src/lib.rs:322`; ro-binds `lib.rs:325`, hook leaves
   `hook_write_deny.rs:355`) — bwrap is the
   hook-protection layer, not the no-write layer. **Landlock** is what actually blocks writes,
   and when it is unsupported or fails to apply, `SandboxManager::apply` warns
   `"Sandbox not supported on this platform, continuing without sandbox"` /
   `"Sandbox could not be applied, continuing without sandbox"` and returns `Ok(())` with
   `applied = false` (`lib.rs:197` and `:228`) — both strings are in the shipped
   1.0.5 binary (`strings -a`, re-run 2026-08-23). The refusal that would catch an unapplied sandbox is **skipped once we are inside
   bwrap**: `let unappliable = requires_protection && !sandbox.is_applied() &&
   !xai_grok_sandbox::is_inside_bwrap();` (`xai-grok-shell/src/config/mod.rs:1494-1498`;
   `is_inside_bwrap` itself `xai-grok-sandbox/src/lib.rs:74`) — and
   read-only is *always* inside bwrap by 2a. So on a kernel without Landlock, a `--read-only`
   run starts successfully and the workspace stays writable, with `--always-approve`
   auto-answering tool prompts.

   **2c. Windows — no sandbox and (for a fresh session) no refusal.** `SandboxManager::apply` is a stub for
   `#[cfg(not(all(feature = "enforce", unix)))]` that logs "Sandbox enforcement unavailable"
   and returns `Ok(())` (`lib.rs:240-247`, the log line `:244`), and the refusal machinery in
   the shell sits behind `#[cfg(any(target_os = "linux", target_os = "macos"))]`
   (`config/mod.rs:1480` for `requires_protection`, `:1491` for the refusal block itself;
   the macOS `unappliable` arm is `:1493-1494`, the Linux one `:1495-1498`).
   Upstream publishes Windows binaries (`README.md`), so on Windows a **fresh or
   same-profile** `--read-only` run starts normally and enforces **nothing** — neither 2a's
   refusal nor 2b's partial protection. The one exception is the resume-conflict exit(1)
   below: `resolve_startup_sandbox` is pure flag-vs-saved-profile comparison with **no cfg
   gate** (enum decl `cli.rs:806`; entry `startup_sandbox_profile` `cli.rs:958-960`; the pure
   resolver `resolve_startup_sandbox` `cli.rs:1040-1053`, `Conflict` constructed `:1046`;
   handled `xai-grok-pager-bin/src/main.rs:1953-1954`), so resuming a session persisted as a
   *different* profile refuses on every OS, Windows included.

   **Treat `--read-only` as hardening with a hard host prerequisite, never as a hermetic
   jail.**

   The hard `exit(1)` refusal used to fire only for read-*deny* profiles —
   `requires_read_deny(ReadOnly)` is **still** `false` (`lib.rs:434-445`, stub `:448-450`);
   `strict` is **not** in that set
   either — but that is no longer the load-bearing predicate. **The old claim "read-only has no
   bwrap deny-plan, so on Linux it skips bwrap and goes straight to Landlock" is now FALSE.**
   read-only carries no *read*-deny list (`profiles.rs:407` `deny: vec![]`) but it does carry
   `write_deny: resolve_write_deny(self)` (`profiles.rs:408` → `resolve_write_deny`
   `profiles.rs:44` → `profile_hook_write_deny` `hook_write_deny.rs:220-225`),
   which IS the hook plan — so `bwrap_deny_plan` (`lib.rs:469`, stub `:539`) returns a plan, the
   "nothing to bind" early return (`lib.rs:582`) is not taken, and `bwrap_reexec_for_profile`
   (`lib.rs:569`) hands back a real command. Treat `--read-only` as hardening plus a hard host
   prerequisite, not a hermetic jail.

   **Two "MOVED FILE" claims that earlier drafts of this row carried are FALSE — do not
   reintroduce them.** `resolve_write_deny` never moved: it was already
   `xai-grok-sandbox/src/profiles.rs:43` at the `8a14c91` baseline and already returned
   `anyhow::Result` (43 → 44, a one-line shift). The old `hook_write_deny.rs:224-229` pin was
   never `resolve_write_deny` at all — it pointed at the **callee**, `profile_hook_write_deny`
   (now `:220-225`, same file). Likewise `resolve_profile` never changed file (see caveat 1).
   The `config/mod.rs` rewrite (481 lines) plus `profiles.rs` / `hook_write_deny.rs` churn moved
   *line numbers* by ~50-70, and **behaviour is unchanged**: the 2a/2b/2c structure survives
   verbatim — `requires_bwrap = requires_read_deny || requires_hook_write_deny`
   (`config/mod.rs:1431`) and `unappliable = requires_protection && !is_applied() &&
   !is_inside_bwrap()` (`:1494-1498`).
3. **Network scope is child-process only.** grok leaves its **main** process online (it needs the
   LLM API), so in-process `web_search`/`web_fetch` **keep working** under `--read-only`
   (`lib.rs:10-12`, the crate's own module doc). Only network from terminal-spawned **child**
   processes is blocked, via seccomp on Linux
   (`xai-grok-shell/src/terminal/streaming_local_terminal.rs:917`). So `--read-only` does NOT break web research; it does
   stop a spawned `curl`/`wget` in a bash command.

The three upstream levers (strongest first):

| Mechanism | How | Strength | Source anchor | Used? |
| --- | --- | --- | --- | --- |
| **`--sandbox read-only`** (alias `readonly`, or `GROK_SANDBOX=read-only`) | FS sandbox; only `~/.grok` + temp writable, whole workspace readable; blocks **child-process** network (not in-process web tools) | **Refuses to start without bwrap (2a), but can still run un-enforced once inside it (2b)**; a managed requirement also outranks it | profile `profiles.rs:403-411` (`deny: vec![]` `:407`, `write_deny` `:408`, `restrict_network: true` `:410`); writable paths `paths.rs`; flag decl `cli.rs:726`; startup gate `xai-grok-shell/src/config/mod.rs:1425-1521`; hook plan `hook_write_deny.rs:18-20`, `:220-225` | ✅ what `--read-only` emits |
| `--disallowed-tools "search_replace,write,run_terminal_cmd,…"` | Removes write/exec tools from the toolset (keeps network + reads) | Medium — model can't call them, but not OS-enforced | `cli.rs:681` | available escalation |
| `--deny "Write(**)" --deny "Edit(**)"` | Permission-layer denial (tools exist, execution gated) | Weakest — cooperative | `cli.rs:476-482` | — |

Built-in sandbox profiles: `workspace`, `devbox`, `read-only`, `strict`, `off` (+ `Custom`)
(`profiles.rs`) — unchanged through 1.0.5; the resolved default when nothing is set is **`off`**,
not `workspace` (`xai-grok-shell/src/agent/config.rs:1194`). For a niche profile, set
`GROK_SANDBOX=<profile>` — grok reads
it natively (`cli.rs:726`), and the plugin only injects `--sandbox` for `--read-only`, so it
won't clobber your env otherwise.

**Checked and NOT a problem:** the `deny/glob.rs` rewrite (740 lines, 1.0.0) added a
refuse-to-start path when `expand_deny_globs` fails — it cannot reach a `--read-only` run,
because read-only's deny list is empty (`profiles.rs:407`) so `has_globs` is false
(`lib.rs:513-514`) and `expand_deny_globs` is never reached (`lib.rs:520`). Proved, not assumed.

**Re-run recipe for BOTH halves of caveat 2** (no engine spend, works offline):
```bash
strings -a $(which grok) | grep -E "Refusing to start with denied paths|hook write-deny is required"  # 2a: startup fail-closed
strings -a $(which grok) | grep -E "continuing without sandbox"                                        # 2b: enforcement fail-open
```
Both hit on `1.0.5` (re-run 2026-08-23; they hit on `1.0.0` too). If 2b's string ever disappears, re-read `SandboxManager::apply` — that
would be upstream finally closing the enforcement gap, and this caveat would need rewriting.

---

## Part 4 — Known engine surfaces we deliberately do NOT wire (yet)

Verified real (source-anchored), useful later, currently unused — so nobody re-discovers them.
**One entry has graduated:** Grok Imagine (`image_gen`) is now WIRED, by `/grok:image`
(`plugins/grok/commands/image.md`, 2026-08-23). Its bullet stays here, first and marked, because
everything the verb depends on is engine contract that the next pass has to re-diff.

- **Grok Imagine / `image_gen` — WIRED as of 2026-08-23 (`/grok:image`).** Not a companion verb:
  `commands/image.md` drives the existing `task` verb with a canned prompt (`--no-subagents
  --json`, foreground, `timeout: 600000`), and **grok's own shell is asked to do the `cp`** out of
  its session folder. **Why that copy, stated correctly (2026-08-23, second pass):** for
  convenience and sandbox-independence — grok already knows the absolute path it just wrote and
  can copy it whatever profile the run used. **Not** for permissions: the images directory is
  chmod `0700` on unix, but only at creation time (`storage.rs:64-71`), and `0700` is owner-rwx —
  it does not stop the *same OS user* from reading the file, which is exactly what the verb's own
  recovery step does. Anything implying the file is unreachable afterwards is overstated; so is
  "a path outside cwd necessarily fails", which nothing supports with the sandbox off (the
  resolved default is `off` — Part 3). All anchors read at `9fabade` (= installed `1.0.5`):
  - **Registration / gate.** `builder.rs:741` pushes `ImageGenTool` when
    `image_gen_config.image_gen_enabled()`; the tool's own `requires_expr` is `Expr::True`
    (`image_gen/mod.rs:405-407`). Resolution is
    `BoolFlag::env("GROK_IMAGE_GEN").config(features.image_gen).feature_flag(remote).default(true)`
    (`xai-grok-shell/src/agent/config.rs:2648-2656`, `.default(true)` exactly at `:2655`), with
    the remote `imagine_tool_disabled` kill switch short-circuiting to `false` first
    (`:2641-2647`) and a **managed requirement pin** outranking even that
    (`:2638-2640`, field decl `requirements.image_gen: Constrained<bool>` `:609`) — the whole
    precedence chain, pin included, was **re-read byte-for-byte on the second 2026-08-23 pass**;
    `resolve_image_gen` states it in its own doc comment ("requirement > env > `[features]` >
    remote > default", `:2631-2635`). There is **no
    `AgentMode::Headless` gate anywhere in the chain** — which is the whole reason the verb can
    exist. Verified disablers, then: `GROK_IMAGE_GEN`, `[features] image_gen`, remote
    `imagine_tool_disabled`, and a managed requirement pin. *(The pin is anchored above; its
    `requirements.toml` **key spelling** is deliberately NOT claimed — nothing read this pass
    proves it.)*
  - **Tier tell.** A free / X Basic user is zero-limited server-side:
    `image_gen/mod.rs:49` `TIER_RESTRICTED_UPSELL` is returned as `Ok(ToolOutput::Text(...))` at
    `:458` (short-circuit `:454-459`) — i.e. a **successful** tool result, so the job looks
    healthy. Match the substring `SuperGrok` only, never the full marketing sentence (upstream
    can reword it). Present in the shipped `1.0.5` binary (`strings -a`, 2 hits: `image_gen` +
    `image_edit`).
  - **Typed fallback channel.** When grok generates but skips the copy, the path arrives on
    `tool_call_update.rawOutput` = `MediaGenOutput`
    (`xai-grok-tools/src/types/output.rs:63-76`): `{path, filename, session_folder,
    uploaded_url?}` — FOUR fields, `uploaded_url` set for remote/ZDR output where `path` is
    empty. A `tool_call_update` line carries **no** `toolName` (`headless/reducer/acp.rs:53-61`);
    only `tool_call` does (`:40-52`). So grepping `"toolName":"image_gen"` on an update line
    never matches — match on `rawOutput`, or correlate `toolCallId` back to the `tool_call`.
  - **Saved-file format is a naming convention, not a guarantee.**
    `SessionFileWriter::new(DEFAULT_IMAGE_DIR, "jpg")` (`image_gen/mod.rs:150`; cite that, **not**
    `storage.rs:168`, which is inside that file's `#[cfg(test)] mod tests` — the `cfg(test)` at
    `storage.rs:161`) and `save()` is called with
    `ext_override = None` (`:468-472`), writing whatever base64 the API returned (`:259-273`).
    Hence the verb's pass/fail gate cannot key on the extension, and JPEG magic bytes stay a
    **warning only**. **Tightened 2026-08-23, second pass:** "exists and is non-empty" was too
    loose to be a gate — a bare `test -s` also passes on a *stale* file left by an earlier run and
    on a *directory*, so a failed generation could report success. The gate is now
    `test -f && test -s` (regular file, non-empty) with **freshness supplied by requiring the
    output path not to exist beforehand** — no mtime or inode bookkeeping to get wrong. Same pass
    narrowed the tier triage: scanning the whole job log for the upsell substring also matched
    **the user's own prompt text**, so the triage reads the **completed `image_gen` tool result**
    instead.
  - **LIVE-VERIFIED 2026-08-23 against real `grok 1.0.5`** (one generation: 35s, exit 0,
    431,791-byte JPEG, magic `ff d8 ff`). Observed, not inferred: `image_gen` is listed in the
    `available_commands` line of a headless run (registration proven on the path we use, not just
    from source); tool events **do** reach the raw job log read back with `logs <job>`; the
    `tool_call_update` line's keys are exactly `content`, `locations`, `rawOutput`, `status`,
    `toolCallId`, `type` — **no `toolName`**, confirming the grep trap above; and `rawOutput` came
    back as `{"type":"ImageGen","path":…,"filename":"1.jpg","session_folder":"images"}`. Two
    refinements to the row above from that observation: `session_folder` is the bare directory
    *name* (`"images"`), not a path, and `uploaded_url` is simply **absent** for local output
    rather than present-and-empty — so read it with a presence check, not a truthiness check.
  - **ONE claim is still INFERENCE — confirm when a non-SuperGrok account is available:** that a
    tier-restricted run exits 0 with no error event. The live run could not exercise it (the
    account under test has SuperGrok, so `image_gen` never short-circuited). Its sibling claim —
    that the upsell text would reach the raw log — is now **strongly evidenced** rather than
    proven: tool-result content demonstrably reaches the log, and the upsell arrives as exactly
    that (`Ok(ToolOutput::Text(...))`).
  - **The companion takes no `--cwd`** (`Unknown flag: --cwd`, exit 1). The run's cwd is the cwd
    of the shell that invokes it, which the adapter then forwards to grok as `--cwd`. Learned by
    hitting it on the live run — `commands/image.md` step 1 now says so.
  - **Re-check recipe:** `git show 9fabade:crates/codegen/xai-grok-agent/src/builder.rs | rg -n 'image_gen_enabled'`
    · `git show 9fabade:crates/codegen/xai-grok-tools/src/implementations/grok_build/image_gen/mod.rs | rg -n 'SuperGrok feature'`
    · `git diff <baseline>..<binary-commit> -- crates/codegen/xai-grok-tools/src/implementations/grok_build/image_gen/mod.rs crates/codegen/xai-grok-shell/src/session/acp_conversion.rs`
    (empty for `8a14c91→9fabade` **and** `9fabade→19d42e3`, checked 2026-08-23).
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
  (hidden)** — `cli.rs:708` / `:716-724` (default `600` at `:719`, persistent-monitor caveat
  documented `:713-715`). Every `grok -p` run **waits, by default, up to 600s after the
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
  when resuming (`cli.rs:596-606`: `-s` decl `:601`, `--fork-session` `:605`). Two lines each side. Unwired because resume is used
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
  `--disallowed-tools`; `--leader-socket`; and the subcommands `du`/`disk-usage`
  (**correction 2026-08-23:** these ARE in the shipped binary — `grok --help` on `1.0.5` lists
  `du … [aliases: disk-usage]`. The old "not even in the shipped binary" was true of `1.0.0` and
  is now dead; the skip stands on its own merits, not on absence), `export`, `sessions`, `trace`,
  `models`, `doctor`, `inspect`, `update`, `plugin`, `worktree`.
- **Startup silence on stdout — why no stall-guard default is safe (new 2026-08-23, fourth pass).**
  A stall guard that kills a job for being quiet needs to know how long a *healthy* run may
  legitimately stay quiet. On grok, the answer is "longer than anything we dare hard-code", and
  it is deliberate:
  · `xai-grok-pager/src/headless.rs` fn `headless_materialize_ctx` sets
    **`restore_progress_on_stdout: false`** — remote-restore progress goes to **stderr only**.
  · `xai-grok-pager/src/app/session_startup.rs` pins
    **`REMOTE_RESTORE_TIMEOUT = 90s`** for pre-TUI remote restore (session state + memory).
  · Model-catalog work **is** bounded, and the earlier version of this row was wrong to imply
    otherwise (corrected 2026-08-23, sixth pass): the first-catalog wait budget is
    `STARTUP_AUTH_REFRESH_TIMEOUT + STARTUP_FETCH_TIMEOUT` (`xai-grok-shell/src/agent/models.rs`
    `wait_for_first_catalog_inner`, `const BUDGET`), and both are **5s**
    (`xai-grok-http/src/lib.rs`), so **10s** total.
  · What is genuinely unbounded is **session opening itself** — no source-proven ceiling was
    found for it, and that alone is what makes a default unsafe.
    *(Correction of a correction, 2026-08-23 seventh pass: an earlier revision of this row called
    "the engine's inference idle bound is 600s" a **conflation** with `AUTH_CALLBACK_TIMEOUT`.
    That retraction was wrong. 600s is independently BOTH: `resolve_inference_idle_timeout_secs`
    (`xai-grok-shell/src/agent/mvp_agent/mod.rs`, `per_model.or(remote).unwrap_or(600).max(10)`,
    installed into `sampler_config_initial.idle_timeout_secs` by
    `session/acp_session_impl/spawn.rs`) AND the OAuth callback wait. What was actually wrong with
    the original sentence is narrower: it is an **overridable inference-idle fallback**, not a
    universal startup ceiling, and inference idle does not bound session opening at all — so it
    was never evidence for a safe watchdog default either way.
    Process note, because it caused this: the retraction was "verified" by reading the working
    tree at `19d42e3` while this doc pins `9fabade`. At `9fabade` that line is exactly
    `resolve_inference_idle_timeout_secs`. **Verify anchors with `git show <pinned>:<path>`, never
    with a `sed` on whatever the clone happens to be checked out at.*)
  · The streaming reducer emits nothing at session open (`headless/reducer/mod.rs`, the
    `Reducer::begin` default returns no lines), so there is **no early stdout event to rely on**.
  Consequence for the plugin: `plugins/grok/scripts/lib/adapter.mjs` declares
  `firstEventTimeoutMs` as a getter that returns `null` unless the user sets
  `GROK_FIRST_EVENT_TIMEOUT_MS`, and returns `null` in `--json-schema` mode **even when opted
  in** (non-streaming writes nothing until its terminal object — a healthy schema run was killed
  by a 15s budget, verified live). A 120s default was shipped and reverted; if a future pass is
  tempted to restore one, this row is the reason not to.
  Re-check recipe — and note what it does and does NOT cover:
  `git show 9fabade:crates/codegen/xai-grok-pager/src/headless.rs | rg -n 'restore_progress_on_stdout'`
  · `git show 9fabade:crates/codegen/xai-grok-pager/src/app/session_startup.rs | rg -n 'REMOTE_RESTORE_TIMEOUT'`
  · `git show 9fabade:crates/codegen/xai-grok-shell/src/agent/models.rs | rg -n -A2 'const BUDGET'`
  · `git show 9fabade:crates/codegen/xai-grok-http/src/lib.rs | rg -n 'STARTUP_(FETCH|AUTH_REFRESH)_TIMEOUT'`.
  Those four verify the restore-output flag, the 90s restore timeout and the 10s catalog budget.
  They do **not** verify reducer output at session open or the absence of a session-open ceiling —
  those were read by hand, and re-reading them is the expensive part of the next pass.
- **Auth — grok's headless path fails closed at METHOD SELECTION, so the plugin inherits that much for free (but see reading 4: a stale advertised token still reaches interactive OAuth)
  (row re-inverted 2026-08-23, second pass).** This row has now been written three ways; the
  history is the lesson, so it is kept.
  1. Originally: "we delegate auth to the CLI and don't need it today."
  2. First pass 2026-08-23 called that **disproven**, because the plugin's own preflight
     consumed auth presence and hard-refused the launch — so a new auth source would be a
     *plugin* change, not a free CLI inheritance.
  3. **Second pass 2026-08-23: reading (1) was right and (2) was wrong.** The correction
     reasoned from *the plugin's guard*, never from *the engine* — and the engine settles it.
     The preflight was written to prevent a headless run blocking on a device-code URL until
     the 1 h job timeout, and **that hang does not exist on the binary we run.** So the guard
     was deleted; auth detection survives only as `/grok:setup`'s **advisory** report
     (`cmdSetup` in `grok-companion.mjs` — it prints what it found and never blocks).
  4. **Fourth pass 2026-08-23: (3) is right about the guard and TOO STRONG about the engine.**
     The fail-closed guarantee holds at **method selection only**. An *advertised but dead*
     `cached_token` — expired, or a legacy `WebLogin` — passes that gate, and then
     `xai-grok-shell/src/agent/mvp_agent/acp_agent.rs:704-732` hands off to
     `authenticate_after_cached_token_unavailable`, which (landing on grok.com) **replaces the
     request meta** with `{"use_oauth": true}`
     (`.../agent_ops.rs:1412-1416`, destroying the headless marker) and then waits out
     `AUTH_CALLBACK_TIMEOUT = 600s` (`xai-grok-shell/src/auth/oidc/login.rs`, enforced by
     `tokio::time::timeout` → `OidcError::CallbackTimeout`). **So interactive login IS reachable
     headless**, bounded at 10 minutes and invisible under `--background`.
     Deleting the guard did not open this: the deleted guard only called `existsSync`, so a
     stale `auth.json` passed it and hung anyway. It is covered instead by the **opt-in** stall
     guard (`firstEventTimeoutMs`, see the startup-silence row above) — opt-in because, as that
     row shows, no default constant is safe. Do not re-read (3) as "interactive login is never
     attempted": that sentence was on four surfaces and all four are now corrected.

  **Engine evidence, all read at `9fabade` (= installed `grok 1.0.5`):**
  `xai-grok-pager/src/headless.rs` fn `authenticate` is documented "failing closed when none is
  available" (`:459`); it bails when no eager method exists (`:466-472`, message from
  `auth_required_message` `:445-457`) and bails again if the selected method
  `needs_interactive_login()` (`:475-479`), under the comment "Prefer non-interactive methods
  only; interactive login is not usable headless." (`:474`). Its call site turns that into a
  stdout `error` line and returns `Err` (`:889-902`, `emitter.on_error` `:899`), which `main`
  prints as `Error: …` on **stderr** and `exit(1)` (`xai-grok-pager-bin/src/main.rs:1901-1908`).
  The non-interactive message is *"Not signed in. To authenticate without a browser, run: grok
  login --device-code … Alternatively, set the XAI_API_KEY environment variable …"* (`:451-455`).
  **Consequences we rely on — scoped to the "no method resolves" case:** a headless run with
  **no** auth method advertised at all dies in seconds with a self-explanatory reason on both
  streams, and the reason lands in `classifyError`'s `auth` bucket, since the message contains
  "authenticate" (the bucket matches `authenticat`) and `XAI_API_KEY`. Nothing plugin-side has to
  detect auth to get that.
  **This is NOT "never a hang"** (that phrasing was the surviving fifth variant of this row and
  is retracted): when a method IS advertised but dead — an expired or legacy-WebLogin
  `cached_token` — reading 4 above applies and the run waits 600s on interactive OAuth. The
  fail-closed inheritance covers the empty case, not the stale case.

  **Why the guard was a net negative** (host-verified against its own logic — env truthiness plus
  a bare `fs.existsSync`): it **false-refused valid setups** — a per-model `api_key`/`env_key` in
  grok's config (`resolve_credentials`' first tier, below), an unset `HOME`, an empty
  `GROK_AUTH_PATH` — and **accepted credentials grok cannot use**: `GROK_AUTH=garbage` (grok
  parses it as JSON and falls back, `auth/manager.rs:316-328`), a zero-byte auth file, or a
  *directory* at that path. A guard that both refuses working setups and waves through broken
  ones is worse than the engine's own error.

  **`GROK_AUTH_PATH` itself is real and unchanged** — env override for the auth file, independent
  of `GROK_HOME`: `xai-grok-shell/src/auth/manager.rs:311` (comment `:306-310`, falling back to
  `grok_home.join("auth.json")` `:313`), resolved *before* the `GROK_AUTH` branch so inline
  credentials persist refreshes to the same path. *(The old pin `cli_models.rs:103/112` stays
  superseded — those lines are now `:120`/`:129` and are `EnvGuard` **test** support, not the
  production read.)* grok's own source order, for anyone who needs to reason about it again:
  inline `GROK_AUTH` JSON first (`manager.rs:315-328`), then the file at
  `GROK_AUTH_PATH ?? $GROK_HOME/auth.json`, with `XAI_API_KEY` then legacy
  `GROK_CODE_XAI_API_KEY` read by `read_xai_api_key_env` (`agent/auth_method.rs:36-38`, consts
  `:26` / `:30`). **We consume none of it** — this list exists so the next pass does not
  re-discover it, not because the plugin reads it.
  - **`GROK_DEPLOYMENT_KEY` — not an auth source we can reason about, and moot for the plugin.**
    It is grok's **management** API key (`xai-grok-shell/src/agent/config.rs:186-189` "Management
    API key for enterprise deployments. Sent on telemetry and service requests for
    deployment-level attribution", read from env at `:554`; resolved for managed-config calls by
    `resolve_deployment_key`, `managed_config.rs:453-471`, which also accepts `[endpoints]
    deployment_key` from config). It does **not** appear in sampling credential resolution:
    `resolve_credentials` (`agent/config.rs:4796-4825`, priority comment `:4794-4795`) goes BYOK
    `own_credential` → cached auth-provider token → session key → `XAI_API_KEY` env, and never
    consults it. **So whether a deployment-key-only setup can complete a headless task is
    UNTESTED** — the earlier justification ("it would walk the user into a device-code hang") is
    dead with the hang. With no preflight, the plugin no longer takes a position either way:
    grok either authenticates or fails closed as above.
  - **`GROK_BIN` and `GROK_SKIP_AUTH_PREFLIGHT` — historical, deleted with the guard.** For one
    day the doc recorded that `GROK_BIN` had bypassed the preflight (a real bypass while the
    guard existed: a real-binary `GROK_BIN` install is a production override that `cmdSetup`
    probes and `adapter.mjs` spawns) and that the escapes were the in-process fake seam
    (`deps.binaryArgv`) plus `GROK_SKIP_AUTH_PREFLIGHT=1`. All of that is gone: there is no
    preflight to bypass, and **`GROK_SKIP_AUTH_PREFLIGHT` is read by no code path any more** (it
    survives only as history in `plugins/grok/CHANGELOG.md`) — do not reintroduce it in a doc, a
    test or a README. `GROK_BIN` itself is untouched and still a supported production override.

---

## Part 5 — stderr we bucket (`classifyError`)

The fifth contract surface, and the one with the weakest evidence class: `adapter.mjs →
classifyError(stderrTail, exitCode)` maps grok's *prose* onto the shared job runtime's error
kinds. Buckets used to be justified only by "verified by running `0.2.93` (2026-07-16)", which is
how one of them stayed **dead** for a month. Anchors and a re-check recipe now live here so the
next pass diffs instead of re-guessing.

**Order is part of the contract.** `classifyError` returns on first match, and several of grok's
strings satisfy two regexes, so the table below is written **in evaluation order** — re-ordering it
is a behaviour change, not a tidy-up. Adapter pins re-read 2026-08-23 (second pass) against the
landed `adapter.mjs`; the first pass's pins were ~6 lines stale within a day, which is why every
row also names its regex token.

| # | Bucket | Adapter test | Upstream source of the strings | Evidence class |
| --- | --- | --- | --- | --- |
| 1 | `config` (sandbox refusal) — **FIRST**, above every bucket | `adapter.mjs:341` `/refusing to start/i` | `xai-grok-shell/src/config/mod.rs:1435-1438`, `:1461-1466`, `:1500-1505`, `:1513-1516` (all four carry the phrase) | `strings -a` on 1.0.5 ✓; never triggered |
| 2 | `not-installed` — **SECOND** (moved up 2026-08-23, second pass) | `:351` exit 127 / `/command not found\|ENOENT/i` | Our own spawn, not grok. It must outrank the prose buckets because the string here is the spawn error verbatim (`spawn /opt/relay/grok ENOENT`) and it embeds a **user-controlled PATH** — any bucket matching a substring of that path steals a missing binary | ours |
| 3 | `auth` | `:367` (`401`, `unauthorized`, `authenticat`, `XAI_API_KEY`, `grok login`, …) | Widened from a **live 0.2.93 run** (2026-07-16). Newly source-backed this pass: grok's own headless no-auth message ("Not signed in. To authenticate without a browser … set the XAI_API_KEY environment variable", `headless.rs:445-457`) lands here via `authenticat` + `XAI_API_KEY`. **`forbidden`/403 was REMOVED** — see the traps below | behavioural (stale) + source ✓ for the no-auth message |
| 4 | `quota` | `:375` (`429`, `rate limit`, `quota`, **`requires a grok subscription`**) | Same live-0.2.93 provenance, plus the one 403 that IS an entitlement limit. **Production anchor is the match pattern**, `xai-grok-shell/src/sampling/error.rs:134` (`message.contains("requires a Grok subscription")`, inside the `StatusCode::FORBIDDEN` arm) — *not* the sentence "The model 'grok-build' requires a Grok subscription." at `:696`, which is a fixture inside `#[test] forbidden_subscription_error_includes_api_key_hint_when_env_set` (`:690-700`); cite that test as what **pins** the wording, the way Part 4 already distinguishes `image_gen/mod.rs:150` from `storage.rs:168` | behavioural (stale) + source ✓ for the subscription 403 |
| 5 | `endpoint` tier 1 — Node/undici codes | `:408` (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`) | **Nothing in grok.** Kept only for a transport failure in *our own* Node process. The bare **`relay`** token that used to sit here is **GONE** (second pass) — it stole `spawn /opt/relay/grok ENOENT` from `not-installed`, and grok only ever says "relay" about session-**share** connections (`xai-grok-shell/src/extensions/notification.rs:1218-1229`), never in headless failure prose | source ✓ |
| 6 | `endpoint` tier 2 — grok's real prose | `:409` | `xai-grok-sampling-types/src/error.rs:593-617` `status_user_message` (HTTP 502-504 / 529 / 520-524+530 / 525-526 / other 5xx sentences), `:179` (`reqwest error stream: …`); `xai-grok-shell/src/sampling/error.rs:101` `OVERLOADED_USER_MESSAGE`, `:119-121` (`http client init failed: {e}`) | source ✓ + `strings -a` on 1.0.5 ✓ |
| 7 | `config` (bad model/effort, unsatisfiable schema, failed resume, **403 policy denial**) — now **AFTER** endpoint | `:427` | `headless.rs:684` (`--effort/--reasoning-effort: …`), `:559` (`Session does not exist`), `app/session_startup.rs:1285` / `:1288` (`Failed to restore session from remote…`), `headless.rs:270-280` (`model did not produce structured output`); `forbidden`/`HTTP 403` per `xai-grok-shell/src/sampling/error.rs:127-136` | source ✓ |
| 8 | `config` (weak sandbox word-net) — **LAST** | `:434` (`bwrap`, `bubblewrap`, `write-deny`, `sandbox profile`, `sandbox deny`) | wording-change fallback for row 1's refusal | deliberate belt-and-braces |

**Three ordering decisions that are load-bearing** (each was a real mis-bucketing, fixed
2026-08-23 second pass):
- **`not-installed` before the prose buckets** (row 2). The input can be a spawn error containing
  a user-chosen path; a `GROK_BIN` under `/srv/relay`, `/tmp/quota` or `/opt/ENOENT` was being
  labelled by its *directory name*.
- **`endpoint` before `config`** (rows 6 → 7). grok's resume-failure prose **embeds** the
  transport failure that caused it — "Failed to restore session from remote: Grok is temporarily
  unavailable. (HTTP 503)". That run failed because the endpoint was down, not because the user
  named a bad session. Safe in the other direction because `classifyError` sees **one** string
  (`spawnError || adapter error || stderrTail`, `shared/lib/runtime/worker.mjs`), and no remaining
  `config` token can **wrongly** co-occur with 5xx prose: each is either purely local, or
  status-exclusive with a 5xx, or — the one 5xx-bearing case — a string `endpoint` is *supposed* to
  own. *(Corrected 2026-08-23, third pass: this
  used to justify that with "every remaining `config` token is a purely local decision grok makes
  without issuing a request", which contradicted row 7 of the table right above it — the **403
  policy denial** is a remote HTTP response, and "Failed to restore session from remote…" is a
  remote failure too. The routing is right; the reason was wrong.)* The per-token reason, matching
  the table:
  - **Local, never in flight:** `--effort/--reasoning-effort: …` (`headless.rs:684`),
    `Session does not exist` (`:559`), and the whole row-1/row-8 sandbox word-net. These genuinely
    issue no request, so no 5xx sentence can co-occur with them.
  - **Post-request, but structurally cannot carry a 5xx:** `model did not produce structured
    output` (`headless.rs:270-280`). *(Corrected 2026-08-23, third review pass: this was listed
    above as "never in flight", which is false — it is reached only after a model request comes
    back, and the run exits **0**. The routing to `config` is still right, for a different reason:
    it is the `unwrap_or_else` on a request that **succeeded** and merely answered off-schema, so
    a transport/5xx failure would have short-circuited long before this string could be produced.
    Two passes in a row got the rationale wrong while getting the routing right — a reminder that
    a correct verdict does not validate the argument under it.)*
  - **Remote, but mutually exclusive with 5xx:** the `forbidden`/`HTTP 403` tokens
    (`shell/sampling/error.rs:127-136`). One request resolves to **one** status — a 403 response is
    not also a 502/503/529 response, so the two sentences cannot appear in the same failure.
  - **Remote AND 5xx-bearing, deliberately conceded to `endpoint`:** only the interpolated
    variant, `Failed to restore session from remote: {e}` (`app/session_startup.rs:1285`) — that
    `{e}` is where "Grok is temporarily unavailable. (HTTP 503)" lands. This is the one string the
    `endpoint`-first ordering is *designed* to steal, which is the whole point of rows 6 → 7, not
    an exception to the rule. Its sibling at `:1288` ("…: conversation history was unavailable.")
    shares the same `config` token but carries **no** upstream status sentence, so it keeps
    reaching `config` — the split is by what the string contains, not by which line emitted it.
- **403 is not `auth`** (rows 3/4/7). Upstream says it in as many words: "403 Forbidden is NOT an
  auth error — the request was authenticated, but the action is not permitted (content-safety
  blocks, ZDR-gated operations, remote-settings-blocked users)"
  (`xai-grok-shell/src/sampling/error.rs:127-132`, mapping it to `internal_error` at `:133+`
  *precisely* so the client does not run its re-auth flow), pinned by a regression test
  `forbidden_is_not_auth_error` (`xai-grok-sampling-types/src/error.rs:1197-1219`, assert message
  "403 Forbidden must not be treated as an auth error" `:1217`). Telling a user to fix a login
  that is already fine is the worst kind of wrong label. The split: the **entitlement** 403
  ("requires a Grok subscription") → `quota`, everything else → `config` (the fix is to change
  the request). One deliberate exception, and it is correct: when the user also has an API key
  set, upstream appends "You have an API key set (XAI_API_KEY) … run `grok logout`"
  (`shell/sampling/error.rs:134-141`) and row 3 claims that variant first — there the fix really
  is auth state.

**Those three orderings were RUN, not reasoned** (2026-08-23, second pass — feeding real upstream
sentences to the landed `classifyError`): grok's no-auth message → `auth`; a content-policy
`Forbidden … (HTTP 403)` → `config`; `The model 'grok-build' requires a Grok subscription.` →
`quota`; `spawn /srv/relay/grok ENOENT` → `not-installed`; `Failed to restore session from remote:
Grok is temporarily unavailable. (HTTP 503)` → `endpoint`; `Authentication temporarily unavailable`
→ `auth`. This is the first time any part of Part 5 has behavioural evidence newer than the live
`0.2.93` run — the `auth`/`quota` *widenings* are still only as good as that 2026-07-16 run, but
the **routing** of the six strings above is now pinned by execution.

**The `endpoint` bucket was DEAD against the engine we ship against.** Its only regex matched
Node/undici codes — `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` / `fetch failed` / `relay` — and
grok is a Rust CLI whose capacity/5xx/transport failures arrive as prose. Proof at `9fabade`:
`ENOTFOUND` and `ETIMEDOUT` appear **nowhere** in `crates/`; `ECONNREFUSED` appears only in
comments and tests (`xai-file-utils/src/storage_client.rs:2593`, `xai-grok-mcp/src/servers_tests.rs:2226`,
`xai-grok-shell/src/leader/mod.rs:1375`); `fetch failed` only in unrelated upload/session copy.
`strings -a $(which grok) | grep -c ENOTFOUND` → **0**. **PRE-EXISTING, not new drift:**
`git show 8a14c91:crates/codegen/xai-grok-sampling-types/src/error.rs | grep -n 'fn status_user_message'`
→ line `464`, i.e. the prose was already there at the baseline this bucket was last blessed on.
Both regexes are fixed in this change: tier 1 stays (a real `spawn ENOENT` still comes from our
Node process), tier 2 carries grok's actual sentences. **Second pass:** tier 1 also **lost its
`relay` token** — the one Node-code alternative that was not a Node code at all, and the one that
stole a missing binary from `not-installed` (row 2).

**Two traps worth writing down** — both are one-word mistakes that silently mis-bucket:
1. Use the **full** phrase `grok is temporarily unavailable`, never a bare
   `temporarily unavailable`. The binary also carries **"Authentication temporarily unavailable"**
   (`xai-grok-pager/src/app/error_display.rs:230`, the `WireErrorType::AuthTransient` arm
   `:229-232`; `strings -a` ✓). **Stale-claim correction, 2026-08-23 second pass:** this trap used
   to say the `auth` bucket does *not* catch that string ("authenticate" is not a substring of
   "Authentication"). That has been false since the same-day first pass, which widened the token to
   **`authenticat`** — case-insensitively that *does* match "Authentication", and `auth` is
   evaluated before `endpoint`, so the string is claimed correctly. The full-phrase rule therefore
   is now belt-and-braces rather than load-bearing — **keep it anyway**: a bare
   `temporarily unavailable` would also swallow any other "<subsystem> temporarily unavailable"
   prose upstream adds.
2. Do **not** match `not found locally, restoring conversation from remote`
   (`app/session_startup.rs:1134`; in the shipped binary too, `strings -a` ✓). grok prints it even
   when the remote restore **succeeds**, so matching it would relabel any later failure in the same
   run as a resume problem. *(The 2026-08-23 first pass justified this by "`config` is tested
   before `endpoint`" — that ordering is now **reversed** (see row 6 → 7 above), and the trap
   stands on its own without it.)*

Also deliberately unmatched: grok's idle timeout (`No response from model for {n}s — the model
may be stuck`, `xai-grok-shell/src/sampling/error.rs:180-182`). The `timeout` kind already has an
owner (the worker's wall-clock fuse) and upstream calls this one not retryable, so labelling it
`endpoint` ("transport, try again") would mislead.

**Re-check recipe** (offline, no engine spend):
```bash
# every string tier 2 keys on must still be in the shipped binary
for p in "Grok is temporarily unavailable" "Grok is temporarily overloaded" \
         "Connection to Grok timed out" "Secure connection to Grok failed" \
         "Something went wrong on the server" "http client init failed" \
         "reqwest error stream" "Model is temporarily overloaded"; do
  printf '%s  %s\n' "$(strings -a $(which grok) | grep -cF "$p")" "$p"; done   # all 1 on 1.0.5
# and the two traps must still be present (they are why the regexes are shaped as they are)
strings -a $(which grok) | grep -cF "Authentication temporarily unavailable"            # 1
strings -a $(which grok) | grep -cF "not found locally, restoring conversation from remote"  # 1
```
A count of `0` for a tier-2 string means upstream reworded it — re-read
`status_user_message` and `map_sampling_err_to_acp`, then update both the regex and this table.
The `auth` / `quota` buckets cannot be re-checked this way; they need a real failing run, and
until someone does one they stay flagged stale in the Baseline block.

---

## Audit log

| Date | Grok tree | Verdict | Notes |
| --- | --- | --- | --- |
| 2026-07-16 | `c68e39f` / bin `0.1.220-alpha.4` (released `grok 0.2.93`) | **none** | First source-grounded audit after open-sourcing. All 11 flags + all read fields pinned to anchors, zero drift. Same pass added `usage` capture (`{inputTokens,outputTokens}`) — the old "grok emits no token counts" assumption was stale; `attach_result_usage` now stamps usage on `end`/json/error. Documented read-only sandbox levers (Part 3). |
| 2026-07-16 | (same tree) | **none** | `grok@0.4.0`: wired an **opt-in `--read-only`** (`--sandbox read-only`). NON-breaking — default unchanged (`off`, full access). Opt-in (not a codex/antigravity-style default) because read-only is **best-effort**: a managed `requirements.toml` overrides it (`config.rs:1123`) and it fails *open* to writable when no OS backend applies (`lib.rs:143`) — a false-confidence default. Independent Codex review (session `019f6b69`) corrected several prior-draft errors, all verified against source: (1) read-only does **not** disable web tools — network restriction is **child-process only**, grok's in-process `web_search`/`web_fetch` stay online (`lib.rs:10`, `streaming_local_terminal.rs:916`); (2) default is `off` not `workspace` (`config.rs:1132`); (3) enum is `SandboxStartup::Conflict`+`exit(1)`, constructed `cli.rs:883` (not `Refused`), and only on a *persisted* differing profile — a no-saved-profile session applies read-only (`persistence.rs:739`, `cli.rs:888`); (4) read-only skips bwrap (no deny-plan) → Landlock directly, `strict` not in the read-deny set (`lib.rs:359`); (5) usage is captured from `end`/json only, not error events; (6) anchors: reasoning-effort `525`, `--sandbox` decl `674`. **[Anchor note added 2026-08-23, verdict unchanged]** the `config.rs:1123` / `:1132` pins in this row were wrong when written: at `8a14c91` those lines are `pub struct HubConfig` / its `is_enabled`; `resolve_profile` was `xai-grok-shell/src/agent/config.rs:1173` then and is `:1184-1195` at `9fabade`. A doc defect, not upstream drift. |
| 2026-07-24 | `~/research/grok-build` @ `c68e39f` (same tree, re-verified) + released `grok 0.2.111` | **none** | Wired `-s`/`--session-id` (`cli.rs:582`, adopted in headless at `headless.rs:608/617`) so a session id is minted client-side (`crypto.randomUUID()`) and persisted into the job record's `request` BEFORE the engine spawns — a worker crash mid-run (no `end` event) no longer loses the id needed to `-r`/`--resume`. Sent only for a brand-new conversation; always mutually exclusive with `-r` (grok rejects `--session-id` + `--resume` without `--fork-session`, which this plugin never passes). Local released binary `grok 0.2.111 --help` cross-checked the flag exists. **[Anchor note added 2026-08-23, verdict unchanged]** at `9fabade` the flag decl is `cli.rs:601` and the headless wiring `headless.rs:530` (param) / `:537` (consumed), not `608`/`617`. |
| 2026-07-24 | (same tree, wave 2) | **none** | Wired three more opt-in flags: (1) **`--research`** → `--tools x_search,web_search,web_fetch --deny MCPTool` — `--tools` (`cli.rs:620`) is an **authoritative** allowlist (`apply_to_definition` overwrites `def.tools` outright, `config.rs:1564-1573`/`1576-1587`; hosted-tool gate `hosted_tool_allowed`, `xai-grok-agent/src/config.rs:1349-1357`, canonical names `builder.rs:1175-1182`/`conversation.rs:495`), stronger than `--sandbox read-only`'s best-effort FS guarantee; MCP tools are NOT proven covered by `--tools` (headless always loads user MCP servers, `headless.rs:615/660`), so `--deny MCPTool` (`cli.rs:476`) rides along as a cooperative backstop only — documented as two distinct guarantee tiers, not conflated. (2) **`--max-turns <n>`** (`cli.rs:627`, clap range `1..`) as a runaway-cost fuse for unattended background jobs. (3) **`--no-memory`** (`cli.rs:611`, `conflicts_with=experimental_memory`, never sent) so a one-off delegated task doesn't touch the user's cross-session grok memory. All three are per-invocation behavior flags (not session identity) — orthogonal to `--read-only`/`--no-subagents`/resume, no mutual exclusion needed; verified against the same `c68e39f` tree, no drift. **[Correction added 2026-08-23 — verdict left as written]** item (3) was **wrong on the day it was written**, and this is a DOC defect, not upstream drift: `git show c68e39f:crates/codegen/xai-grok-pager/src/headless.rs` already hardcoded `cli_experimental_memory: false, cli_no_memory: false` at lines `878-879` (the old field shape, same effect), and `8a14c91` the same at `795-796`. So `--no-memory` never reached headless on any tree this doc has audited; the flag was inert from the moment it was wired. Fixed 2026-08-23 by injecting `GROK_MEMORY=0` into the spawn env — see the Part 1 `--no-memory` row. |
| 2026-08-09 | `8a14c91` / `SOURCE_REV 27b3c666` / pager-bin `1.0.0` (released `grok 1.0.0`) | **should-upgrade** → fixed in plugin `0.6.0` | First audit since the `0.2.111 → 1.0.0` jump (10 public releases in 16 days; 23 tree syncs since `c68e39f`). Method: 6 parallel source-grounded dimensions + adversarial refutation of every actionable finding; one finding (capture `num_turns`/`total_cost_usd`) was refuted and dropped as already-deliberate. **1.0.0 is NOT a breaking major** — upstream's own `xai-grok-shell/CHANGELOG.md` (which this doc had never noticed) records zero `breaking_change: true` for it. **No contract breakage:** all 17 flags present with identical names/aliases/enums/conflict sets, verified against source AND verbatim `--help` AND a parse-only run of the real binary; every field we read survived the `headless/reducer/` refactor byte-for-byte (`rename_all="snake_case"` renames variants, not fields), `usage` keys still snake_case, all new line types tolerated. **The real find: `--sandbox read-only` gained a fail-closed STARTUP gate while its ENFORCEMENT stayed fail-open** (`hook_write_deny.rs`, added upstream in `69f0ba8`) — see Part 3 caveat 2a/2b; four plugin surfaces promised plain fail-open and are corrected, `classifyError` gained a `config` bucket for the refusal, and bubblewrap is now documented as a Linux prerequisite. **TWO rounds of independent Codex review (session `019fe6d7`) were needed, and each caught a real defect in the previous round's fix** — recorded here because the failure mode repeated: round 1 caught the first draft collapsing 2a/2b into a flat "fails CLOSED" (an overstatement in the dangerous direction — bwrap binds `/` read-write and a kernel without Landlock runs writable); round 2 caught that even the corrected 2a/2b **still** over-generalised by omitting **2c (Windows: stub `apply`, no refusal compiled, so no enforcement at all)**. Round 1 also found: the `structuredOutputError` branch returned a bare error event, discarding `sessionId`/`usage` (job unresumable, cost unrecorded); a bare `/sandbox/` alternative in `classifyError` stole `not-installed`; the E2BIG test pinned 131072 (wrong on 64 KiB-page kernels); and the prompt-file test never ran the worker. Round 2 found: `classifyError`'s sandbox check still preceded `endpoint`/`not-installed`, so `GROK_BIN=/opt/bwrap/grok` → `spawn … ENOENT` was still stolen (fixed with two tiers: the unambiguous `Refusing to start` phrase matched **first**, above every bucket, because the refusal text embeds user-controlled paths verbatim — a hooks-path of `/tmp/quota` would otherwise read as a quota error; the broad word-net stays **last** as a wording-change fallback, since those words also appear in ordinary paths); the `ponytail:` comment recorded the wrong-`error` problem instead of fixing it (fixed by adding an optional `error` to the `extractResult` contract in `shared/lib/`, which the worker now prefers over `stderrTail` — additive, no other adapter sets it); and the new worker test used a 400 KB prompt that a 64 KiB-page kernel would pass with the swap disabled, while the fake's 60-char echo could not detect a truncated prompt (fixed: 3 MiB prompt + an exact byte-count assertion; verified to fail when the swap is disabled). Also fixed: `--effort` advertised 4 tokens (`none\|minimal\|xhigh\|max`) that grok-4.5's catalog rejected at runtime. **[Correction added 2026-08-23 — the replacement claim rotted in 14 days]** this row (and Part 1) then asserted the catalog "offers only `low\|medium\|high`". On 2026-08-23 the live cache (`~/.grok/models_cache.json`, `fetched_at 2026-08-23T03:36:51Z`, `grok_version 1.0.5`, `origin https://cli-chat-proxy.grok.com/v1/models`) holds **`grok-4.6`** with `reasoning_efforts` `[xhigh, high (default), medium, low]`, `hidden: false`, alongside `grok-4.5` with `[high (default), medium, low]`. **The durable rule replaces the enumeration everywhere: effort levels are per-model and remote, and `grok models` is the only authority** — do not write a level list into this doc, the plugin, or a fixture; a `--json-schema` run with no structured output exited 0 and returned un-schema'd prose (now fails via `structuredOutputError`); `commands/task.md` advertised a nonexistent model id `grok-composer-2.5-fast`; the inline-prompt `ponytail:` comment named ARG_MAX (~2MB) when the real ceiling is MAX_ARG_STRLEN (131071 B — measured 131071 ok / 131072 `spawn E2BIG`), reachable via `/grok:task --prompt-file`, so oversized prompts now swap to `--prompt-file <jobDir>/prompt.txt`; and `tests/grok/fake-grok.mjs` still emitted CamelCase `stopReason` where 1.0.0 emits snake_case — a green suite against fiction. **Bookkeeping correction:** `.git/logs/HEAD` proves the local clone was never fetched between the 2026-07-16 clone and 2026-08-02, so the 2026-07-24 rows' "same commit, no upstream drift" was really "never fetched" — upstream had shipped 8 syncs by then, and the fail-closed switch was already live. The clone's previous HEAD `a422116` was likewise never audited, so this pass diffed from `c68e39f`; `a422116..HEAD` hides both `headless/reducer/` and `hook_write_deny.rs`. Step 0 of "How to keep this current" now forces a fetch. |
| 2026-08-23 | `8a14c91` → **`9fabade`** (the installed binary) / released `grok 1.0.0` → `grok 1.0.5 (5115b46bc9)`; local HEAD `19d42e3` (1.0.6, contract-identical) | **should-upgrade** → fixed in `0.7.0` | First pass since the doc's baseline went stale by five patch releases. **No contract breakage:** no flag we send is rejected (parse-only probe on the real 1.0.5 — control `--definitely-not-a-flag --help` exits `2`, the whole send-argv exits `0`) and nothing we read was renamed — `headless/cli.rs` and `headless/reducer/` are **byte-identical** across `8a14c91..9fabade`, so Part 2 needed no edit at all. **Four PRE-EXISTING defects surfaced and were fixed** (none is new upstream drift): (1) **`--no-memory` is inert in headless** — `-p` → `headless::run_single_turn` hardcodes `memory_enabled_override: None` (`headless.rs:795`), `HeadlessOptions` has no memory field, and the flag's only consumers are the interactive `ConnectFlags` literal (`app/mod.rs:795-796`); now enforced by injecting `GROK_MEMORY=0` into the spawn env (`adapter.mjs:222`), the one precedence tier that beats a user's `[memory] enabled = true` (`config-types/memory.rs:607-612`, `flags.rs:109-136`, upstream test `config/tests.rs:283`). The 2026-07-24 row that wired it was wrong the day it was written — annotated there. (2) **the `endpoint` bucket was DEAD** — it matched Node/undici codes that appear nowhere in grok's Rust source; replaced with grok's real prose (`sampling-types/src/error.rs:593-617`, `shell/sampling/error.rs:101`/`:119-121`), all confirmed in the shipped binary. (3) the `config` bucket did not catch a **failed resume**. (4) the **auth preflight** checked 2 of grok's sources and **`GROK_BIN` bypassed it entirely** — now `XAI_API_KEY \| GROK_CODE_XAI_API_KEY \| GROK_AUTH` plus `GROK_AUTH_PATH ?? $GROK_HOME/auth.json`, with only the in-process fake seam and `GROK_SKIP_AUTH_PREFLIGHT=1` exempt. Plus: a **Part 1 + Part 3 anchor refresh** (Part 1's `cli.rs` pins were off by +8..+16; Part 3's sandbox pins by ~50-70 after upstream's 481-line `config/mod.rs` rewrite — **behaviour unchanged**, the 2a/2b/2c structure survives verbatim), a **new Part 5** giving `classifyError` real anchors and an offline re-check recipe, and a **new Part 4 bullet for `/grok:image`**, which moves Grok Imagine from "not wired" to wired. **Two "MOVED FILE" claims were refuted, not carried forward:** `resolve_write_deny` (already `profiles.rs:43` at baseline) and `resolve_profile` (already `agent/config.rs:1173`) never changed file; the doc's `hook_write_deny.rs:224-229` pin had been pointing at the *callee*. **Claims RE-PROVEN this pass:** every flag parses on 1.0.5; every error string Parts 3/5 key on is in the shipped binary (`strings -a`); the staleness facts (`grok --version`, `--help` exposing `du`, `--help` hiding `--no-memory`); and the contract-file diffs (`9fabade..19d42e3` empty; `image_gen/mod.rs` + `acp_conversion.rs` empty across both ranges). **Claims CARRIED FORWARD unproven:** the `auth`/`quota` buckets (live `0.2.93` run, 2026-07-16 — a version bump does not re-prove them); the sandbox refusal (source + `strings`, never triggered); and the Imagine **tier-restricted** branch (the rest of that surface was live-verified this pass — see Part 4; the tier short-circuit could not fire on a SuperGrok account). **Open product question, not a defect:** upstream's baked default model moved `grok-4.5` → `grok-4.6` (`crates/codegen/xai-grok-models/default_models.json` `"default"`, provable with `git diff 8a14c91 9fabade -- crates/codegen/xai-grok-models/default_models.json`), while the plugin still hardcodes `grok-4.5`. Drift, not breakage: `grok-4.5` is still in the live catalog and we always send an explicit `-m`. That file is deliberately **not** added to the step-1 contract-file list — the CLI's default is not part of a contract we send. **[Annotations added 2026-08-23, second pass — verdict left as written]** (a) this row's verdict cell originally read "fixed in the working tree (not yet bumped)"; those fixes shipped as **`grok@0.7.0`** and the cell was updated to say so — the verdict itself (`should-upgrade`) is untouched. (b) Item **(4)**, the hardened auth preflight, was **DELETED the same day** — an independent Codex review pointed at the engine instead of the plugin, and grok's headless path already fails closed (`headless.rs:459`/`:475-479`), so the 1 h device-code hang the guard existed to prevent cannot happen on the binary we run. See the second-pass row below and the rewritten Part 4 auth block. (c) Item **(2)**'s replacement `endpoint` regex still carried a bare `relay` token that stole `spawn … ENOENT` from `not-installed`, and item (3)'s failed-resume token out-ranked `endpoint` on prose that embeds a 5xx — both corrected in the second pass. |
| 2026-08-23 (second pass) | `9fabade` (unchanged) / `grok 1.0.5` — **no new upstream diff was run** | **should-upgrade** → fixed on this branch (on top of `0.7.0`) | **The first pass's own commits were reviewed by an independent Codex (gpt-5.6), and the host re-verified every finding against the bytes.** Four real defects, all first-pass regressions or first-pass rationalisations that did not survive contact with the engine. (1) **The auth preflight is DELETED, and the doc's original conclusion is restored.** grok's headless path fails closed on its own — `authenticate` is documented "failing closed when none is available" (`headless.rs:459`), bails when no non-interactive method exists (`:466-472`) and again on `needs_interactive_login()` under the comment "interactive login is not usable headless" (`:474-479`), emitting a stdout `error` line and returning `Err` (`:899-900`) which `main` prints on stderr with `exit(1)` (`pager-bin/src/main.rs:1901-1908`). **So the 1 h device-code hang the guard was written for does not exist on the binary we run**, while the guard itself false-refused valid setups (per-model `api_key`, unset `HOME`, empty `GROK_AUTH_PATH`) and accepted credentials grok cannot use (`GROK_AUTH=garbage`, an empty file, a directory). **The lesson is the reason this doc exists:** the 0.6.0-era row that called "we delegate auth to the CLI" *disproven* was itself wrong, because it reasoned from the plugin's guard instead of from the engine — and one pass shipped a guard on that reasoning. Auth detection survives only as `/grok:setup`'s advisory report (`cmdSetup`). (2) **`classifyError` corrected again:** 403/`forbidden` out of `auth` (upstream is explicit and test-pinned — `shell/sampling/error.rs:127-136`, `sampling-types/error.rs:1197-1219`), the entitlement 403 ("requires a Grok subscription", `shell/sampling/error.rs:696`) into `quota`, the rest into `config`; `not-installed` moved **second** so a `GROK_BIN` path like `/srv/relay` stops being read as prose; the bare `relay` token dropped from `endpoint` tier 1; and `endpoint` moved **before** `config` so a resume failure that embeds "Grok is temporarily unavailable. (HTTP 503)" is bucketed by its real cause. Part 5 is now written in **evaluation order** with per-row regex tokens, because the first pass's adapter line pins went stale within a day. (3) **`/grok:image`'s success gate hardened** — a bare `test -s` also passes on a stale file from an earlier run and on a directory, so the gate now requires a regular, non-empty, freshly-written file; and the tier triage reads the completed `image_gen` tool result instead of grepping the whole log, which was matching the user's own prompt text. (4) **Two overstated claims removed from this doc:** the images directory's `0700` mode (`storage.rs:64-71`, unix, set once at creation) does **not** stop the same OS user from copying the file — the verb's own recovery step does exactly that, so the reason grok's shell does the copy is convenience and sandbox-independence; and "a path outside cwd necessarily fails" is unsupported with the sandbox `off`. **Claims RE-PROVEN this pass** (each anchor opened at `9fabade`): the whole headless auth chain above; `resolve_image_gen`'s precedence including the **managed requirement pin** (`agent/config.rs:2631-2656`, pin `:2638-2640`, field decl `:609`) — already in Part 4 and now byte-verified, with its `requirements.toml` **key spelling** still deliberately NOT claimed; the 403 anchors; `"Authentication temporarily unavailable"` (`app/error_display.rs:229-232`); the relay-share enum (`extensions/notification.rs:1218-1229`); `GROK_AUTH_PATH` / `GROK_AUTH` / `read_xai_api_key_env` (`auth/manager.rs:306-328`, `agent/auth_method.rs:26-38`); and the deployment-key surface (`agent/config.rs:186-189`, `:554`, `managed_config.rs:453-471`, absent from `resolve_credentials` `:4796-4825`). **Claims CARRIED FORWARD unproven:** everything the first pass carried (the `auth`/`quota` buckets' live-`0.2.93` provenance, the sandbox refusal, the Imagine tier-restricted branch) **plus one new one**: whether a **deployment-key-only** setup can complete a headless task is **untested** — the old justification for excluding it (it would walk the user into the device-code hang) died with the hang, and with no preflight the plugin takes no position either way. **Behavioural evidence, new this pass:** the six-string routing check in Part 5 was *run* against the landed `classifyError` (no-auth message → `auth`, policy 403 → `config`, subscription 403 → `quota`, `spawn /srv/relay/grok ENOENT` → `not-installed`, resume-with-503 → `endpoint`, `Authentication temporarily unavailable` → `auth`) — the first behavioural evidence in Part 5 newer than the 2026-07-16 `0.2.93` run. No upstream diff was run this pass: the tree, the binary and Parts 1-3 are the first pass's, unchanged. |
| 2026-08-23 (third pass) | `9fabade` (unchanged) / `grok 1.0.5` — **no new upstream diff, no engine run** | **none** (doc-only) | **A second independent Codex (gpt-5.6) review of the second pass's commits; the host re-verified against the bytes.** One real defect in this doc, one already-fixed false alarm. **Fixed:** Part 5's `endpoint`-before-`config` justification claimed "every remaining `config` token is a purely local decision grok makes without issuing a request" — which **contradicted row 7 of its own table**, where the remote **HTTP 403 policy denial** is routed to `config`. The 403→`config` routing is deliberate and stays (`shell/sampling/error.rs:127-136`, regression-test-pinned at `sampling-types/error.rs:1197-1219`); the *sentence* was the defect, and it is now split per token: local tokens, the 403 (remote but mutually exclusive with 5xx — one request, one status), and the remote-restore string that `endpoint` is *supposed* to steal. **No change needed:** the review flagged a stale "the `auth` bucket does not catch `Authentication temporarily unavailable`" claim, but trap 1 of Part 5 already carries the second-pass **Stale-claim correction** annotating exactly that (the token is `authenticat`, which matches case-insensitively, and `auth` is evaluated before `endpoint`). The same stale line **does** still stand in `plugins/grok/CHANGELOG.md` (~`:35`, `:79`) — out of this lane's files, handed back to the plugin lane. **Re-proven this pass:** nothing upstream — the corrected sentence is reasoned from anchors this doc already carries. **Carried forward unproven:** everything the second pass carried, unchanged (the `auth`/`quota` widenings' stale live-`0.2.93` provenance, the sandbox refusal, the Imagine tier-restricted branch, and whether a deployment-key-only setup can complete a headless task). Parts 1-4, the tree, the binary and the auth rows are untouched. |
