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
| Plugin | `plugins/grok/` @ `0.3.1` |
| Released binary we invoke | `grok 0.2.93` (adapter buckets verified by running it) |
| Open-source tree audited | commit `c68e39f` ("Publish harness and TUI open-source", 2026-07-16), `xai-grok-pager-bin 0.1.220-alpha.4` |
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
| `--reasoning-effort <LVL>` | `long="reasoning-effort", visible_alias="effort"` (265) | `none`..`max`; also per-model menu ids | ✓ |
| `--no-subagents` | `long="no-subagents"` (602) | Disable fan-out (deterministic single agent) | ✓ |
| `-r <ID>` | `short='r', long="resume"` (554) | Resume an existing session | ✓ |

## Part 2 — Output we read (durable checklist)

Parsed by `adapter.mjs → parseEvent` / `extractResult`. Pinned to `headless.rs`.

| Field / event we read | headless.rs anchor | Notes | Status |
| --- | --- | --- | --- |
| `{"type":"text","data":…}` | `on_text_chunk` (373) | We concat `.data` | ✓ |
| `{"type":"thought","data":…}` | `on_thought_chunk` (388) | We ignore it (raw line stays in log) | ✓ |
| `{"type":"end","stopReason","sessionId","usage",…}` | `on_end` (441-457) | Terminal event; we trust exit-code + presence of `end`, not a specific `stopReason` | ✓ |
| `{"type":"error","message",…}` | `on_error` (469-480) | grok emits errors on **stdout** in json modes; we capture so the message survives | ✓ |
| json result: `text`/`stopReason`/`sessionId`/`structuredOutput` | `build_json_result` (419-439), `attach_structured_output` | `--json-schema` mode: one pretty-printed object; `.text` = JSON string, `.structuredOutput` = parsed | ✓ |
| `usage.{input_tokens,output_tokens}` | `attach_result_usage` → `notification::attach_result_usage_fail_closed` | On `end`, the json result, **and** error events. We normalize to `{inputTokens, outputTokens}` for the job record. *(Available but not read: `cache_read_input_tokens`, `total_tokens`, `num_turns`, `modelUsage`, `total_cost_usd`/`_ticks`.)* | ✓ |

**Tolerance guarantees we rely on:** the event list is documented non-exhaustive
("switch on `type`") — `parseEvent` returns `null` for unknown/junk lines and never throws, so
new upstream event types cannot break a run. This is the loose coupling that makes the CLI
line protocol *more* stable to track than a versioned wire protocol.

---

## Part 3 — Read-only / sandboxing (available upstream; not yet wired)

Grok Build ships first-class read-only enforcement. Recorded here so it's a known lever, not a
rediscovery. **Not currently emitted by `buildInvocation`.**

| Mechanism | How | Strength | Source anchor |
| --- | --- | --- | --- |
| **`--sandbox read-only`** (alias `readonly`, or `GROK_SANDBOX=read-only`) | OS/kernel-enforced FS sandbox; only `~/.grok` + temp writable, whole workspace readable | **Strongest** — the agent physically cannot write, regardless of tools | `profiles.rs:1,109`; writable paths `paths.rs:91`; flag `cli.rs:673` |
| `--disallowed-tools "search_replace,write,run_terminal_cmd,…"` | Removes write/exec tools from the toolset | Medium — model can't call them, but not OS-enforced | `cli.rs:623` |
| `--deny "Write(**)" --deny "Edit(**)"` | Permission-layer denial (tools exist, execution gated) | Weakest — cooperative | `cli.rs:476` |

Built-in sandbox profiles: `workspace` (default), `devbox`, `read-only`, `strict`
(`profiles.rs:1`). Resume refuses to change a session's saved sandbox (safety).

**To wire a read-only job:** add a `readOnly` request flag that appends `--sandbox read-only`
in `buildInvocation` — mirrors the existing `noSubagents` seam (one `if (r.readOnly)`
`argv.push`). `--sandbox` is the recommended single lever; the tool/permission layers are
belt-and-suspenders. (Not done in this pass — no request asked for it.)

---

## Audit log

| Date | Grok tree | Verdict | Notes |
| --- | --- | --- | --- |
| 2026-07-16 | `c68e39f` / bin `0.1.220-alpha.4` (released `grok 0.2.93`) | **none** | First source-grounded audit after open-sourcing. All 11 flags + all read fields pinned to anchors, zero drift. Same pass added `usage` capture (`{inputTokens,outputTokens}`) — the old "grok emits no token counts" assumption was stale; `attach_result_usage` now stamps usage on `end`/json/error. Documented read-only sandbox levers (Part 3). |
