# Codex Plugin ↔ Codex CLI — Sync & Health Audit

Living audit of whether the **`codex` plugin** (`plugins/codex/`) is still in sync with the
upstream **OpenAI Codex CLI** it drives, and whether its health-check + long-run
observability machinery is sound. The Codex CLI moves daily; this doc records what was
checked, the verdict, and the exact evidence anchors so the next pass is a diff, not a
rebuild.

> Scope note: this audits the plugin's dependency on Codex's **app-server v2 JSON-RPC
> protocol** and its own **job/health/observability runtime**. It is not a review of Codex
> internals.

---

## How to keep this current

When you want to re-check after new Codex commits land:

1. **Find what changed upstream** since the baseline below:
   ```bash
   git -C /path/to/codex log --since=<BASELINE_DATE> --oneline -- \
     codex-rs/app-server-protocol codex-rs/app-server codex-rs/core/src
   ```
2. **Re-run the two audits** (each is a multi-agent workflow that reads both repos and
   adversarially verifies every non-trivial finding — see "How the audits were run"):
   - Protocol-drift audit (11 dimensions).
   - Health + observability audit (7 areas).
3. **Update** the result tables, the "Action items" section, and the **Baseline** block, then
   append a dated row to the **Audit log** at the bottom.
4. **Re-verify the dependency surface** (Part 1 → "What the plugin sends/reads"): that list is
   the durable checklist. If Codex renamed/removed anything on it, that is a breaking drift.

**Severity language.** Protocol: `breaking` (a request would now be rejected, or a
notification/item rename silently drops data) → `should-upgrade` (adopt to match, nothing
breaks) → `cosmetic` (additive, ignored fine) → `none`. Health: `bug` → `should-improve` →
`minor-gap` → `solid`.

---

## Baseline

| | |
|---|---|
| Codex CLI HEAD | `4a443994bd` (`codex-zsh-v0.1.0-604`; installed binary codex-cli 0.145.0) |
| Last re-check | 2026-07-22 (diff + source-grounded checklist) |
| Last FULL 11-dimension audit | 2026-07-21 @ `d5998e7452` (codex-cli 0.144.6) → `codex@1.3.2` |
| Plugin version now | `codex@1.4.0` |
| Codex repo checked | `/home/audichuang/research/codex` |

> **2026-07-22 re-check (codex-cli 0.144.6 → 0.145.0, HEAD `d5998e7452` → `4a443994bd`, 58 commits):**
> No drift on the plugin's app-server v2 surface — **no plugin change needed.** Verified two ways:
> (a) **diff** — the commits touching the protocol paths are all internal (sandbox / proxy /
> plugin-list / rollout / HTTP client / response-item-ID assignment); the ones touching the
> `app-server-protocol` crate are purely **additive** (new `configRequirements/read` fields,
> `PluginListParams.forceRefetch`, `PathUri`/`FeedbackRequirements`) — `config/read` (what the plugin
> reads) untouched, zero diff lines hit a durable-checklist identifier. (b) **source-grounded** —
> every durable-checklist item was confirmed to still EXIST with its expected shape in the 0.145.0
> source: all 10 sent requests present in the v2 schema, `turn/start` params (`thread_id`/`input`/
> `model`/`effort`/`output_schema`) on `turn.rs`, Bedrock `usesCodexManagedCredentials` present
> (`common.rs`), `InitializeCapabilities` fields present, all 18 notifications + 9 item.type variants
> in the v2 schema, all 8 server-request decline names in `server_request_definitions!`.
> `build:codex` regenerated types from the installed 0.145.0 CLI and tsc passed. Scope: diff +
> source-grounded checklist verification (proportionate to a patch bump), not the full multi-agent
> 11-dimension pass. The last FULL audit remains 2026-07-21 @ `d5998e7452`.
>
> The result tables below still describe the deeper 2026-07-13 pass; their `file:line` anchors are
> from that commit unless a log row notes a newer one.

---

## Part 1 — Protocol sync

### What the plugin sends / reads (the durable checklist)

The plugin speaks Codex **app-server v2** over JSON-RPC (`scripts/lib/app-server.mjs`,
`scripts/lib/codex.mjs`). If Codex renames/removes any of these, it is breaking drift:

- **Requests sent:** `initialize`, `initialized` (notify), `thread/start`, `thread/resume`,
  `thread/name/set`, `thread/list`, `turn/start`, `turn/interrupt`, `review/start`,
  `account/read`, `config/read`, `model/list`.
- **initialize capabilities:** `{ experimentalApi:false, requestAttestation:false,
  optOutNotificationMethods:[ item/agentMessage/delta, item/reasoning/summaryTextDelta,
  item/reasoning/summaryPartAdded, item/reasoning/textDelta ] }`.
- **turn/start params:** `{ threadId, input:[{type:"text",text,text_elements:[]}], model|null,
  effort|null, outputSchema|null }`.
- **Server→client requests it auto-declines** (`SERVER_REQUEST_REPLIES`):
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `item/tool/requestUserInput`,
  `mcpServer/elicitation/request`, `item/tool/call`, `account/chatgptAuthTokens/refresh`,
  `attestation/generate`, `currentTime/read`, + v1 `applyPatchApproval`/`execCommandApproval`.
- **Notifications handled** (`applyTurnNotification`): `thread/started`,
  `thread/name/updated`, `turn/started`, `item/started`, `item/completed`, `turn/completed`,
  `error`, `model/rerouted`, `guardianWarning`, `thread/tokenUsage/updated`,
  `turn/plan/updated`, `turn/diff/updated`, `account/rateLimits/updated`, `warning`,
  `configWarning`, `deprecationNotice`, `model/safetyBuffering/updated`,
  `windows/worldWritableWarning`, and (added 1.3.0) `item/commandExecution/outputDelta`.
- **item.type variants rendered:** `agentMessage`, `reasoning`, `commandExecution`,
  `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`,
  `enteredReviewMode`, `exitedReviewMode`.

### Results (11 dimensions, all adversarially verified)

| Dimension | Verdict | Note |
|---|---|---|
| initialize handshake | ✅ none | `InitializeCapabilities` (v1.rs:44-60) is all `#[serde(default)]`/Option, no `deny_unknown_fields`; the new `mcpServerOpenaiFormElicitation` is defaulted, so omitting it is correct. 4 opt-out delta names still exact (common.rs:1641,1668-1670). |
| `turn/completed` terminal error **#32280** | ✅ none | New `error` was added to the **v1** `TurnCompleteEvent` (protocol.rs:1955), which the plugin never reads. The plugin reads the **pre-existing** v2 `Turn.error.message` (thread_data.rs:240-273) via `resolveFinalMessage` — already forward-compatible. `#32263` startedAt likewise additive. |
| notification method names | ✅ none | All 18 handled names byte-identical upstream; none added/renamed/removed this week. Guardian/idle commits are core-only. |
| reasoning effort values | ✅ none | `ReasoningEffort` = None/Minimal/Low/Medium/High/XHigh/Max/**Ultra**/`Custom(String)` (openai_models.rs:40-52). Plugin's `max` is real; `Custom` catch-all means no effort string can 400. `ultra` deliberately not exposed (it triggers proactive multi-agent behavior, a poor fit for a single-agent task/review runner). |
| default model | ✅ none | Plugin default `gpt-5.6-sol` matches this week's promotion of Sol to default; `terra`/`luna` variants also valid. |
| model/list + spawn backend | ✅ none | `model/list` req/resp shape matches; this week's spawn model-override / backend-restriction are internal to Codex multi-agent, touch no wire the plugin uses. |
| review / guardian flow | ✅ none | `review/start` params, `ReviewTarget`, `delivery`, `reviewThreadId`, `enteredReviewMode`/`exitedReviewMode` all match. |
| server→client declines | ✅ none | `SERVER_REQUEST_REPLIES` mirrors the current `server_request_definitions!` set; nothing would hit `-32601` or hang a turn. |
| thread start/resume/name/list params | ✅ none | No renamed/removed/newly-required field on the params the plugin sends. |
| **config/account/auth** | ⚠️ **should-upgrade** → **FIXED 1.3.0**, re-fixed **1.3.2** | `account/read` can return `Account::AmazonBedrock`. 1.3.0 added the branch (was falling through to a generic label with `authMethod:null`). In codex-cli 0.144.6 the field was renamed/retyped `credentialSource` (string enum) → `usesCodexManagedCredentials` (bool); 1.3.2 reads the bool with a legacy-string fallback so the label stops silently dropping. |
| item types + payloads | ✅ none | Every `item.type` tag + field the plugin reads still matches the Rust enum + serde renames; web-search→extension migration and item-ID-prefix change are wire-transparent (plugin treats `item.id` opaquely). |

**Bottom line:** No breaking drift. One trivial, cosmetic auth-label gap (now fixed).

---

## Part 2 — Health-check & long-run observability

Both of the operator's hard requirements were checked against the ~20-minute task shape:
(1) health checks never false-kill a working task and always finalize a dead one;
(2) live progress is observable throughout, including `--background` via `/codex:status` and
`/codex:logs`.

### Results (7 areas, all adversarially verified)

| Area | Verdict | Note |
|---|---|---|
| Watchdog false-kill safety | ✅ solid | HUNG-by-silence needs `quietMs>15min` **AND** broker unreachable; a healthy long command keeps the broker socket answerable, so it's never killed. `confirmRounds=2` + escalate-not-kill absorb blips. Dead turns still caught (DEAD / missedOwnDeadline / broker-dead). Unit-tested (liveness.test.mjs). |
| Idle broker reap vs. active task | ✅ solid | The reaper counts open sockets; a `--background` worker holds one persistent broker socket for the whole turn (`withAppServer`), so `count≥1` and the 5s idle timer never arms mid-turn. |
| Background progress durability | ✅ solid | Every non-delta notification is flushed **synchronously** to the per-job log (`appendFileSync`) and turn identity to `events.ndjson`; `/codex:logs` live-tails the full rich stream, `/codex:status` shows phase + activity. A background task is not a black box. |
| **Transport-watchdog hang** | ⚠️ **should-improve** → **FIXED 1.3.0** | On the default broker path, an app-server **crash** (broker survives) left the worker socket open+silent → turn hung to the 1h cap. Now the broker tears down client sockets on app-server death. |
| **Command-output heartbeat** | ⚠️ **should-improve** → **FIXED 1.3.0** | A single long command emitted no handled notification between start/complete, so logs/status went dark for minutes although `item/commandExecution/outputDelta` was arriving and being discarded. Now surfaced as a throttled heartbeat. |
| **Transport-watchdog test coverage** | ⚠️ **should-improve** → **FIXED 1.3.0** | The mid-turn-disconnect finalizer had no regression test (every test stubbed `exitPromise` to never resolve). Now covered. |
| Stuck-running reconcile | ⚠️ **minor-gap** → **FIXED 1.3.0** | Reconcile was pure PID-liveness; a recycled PID (or a foreground job, which gets no watchdog) could stick "running". Now a persisted-deadline backstop finalizes past-deadline jobs regardless of PID liveness. |

**Bottom line:** The core machinery is solid. Four small improvements applied in 1.3.0; the
most important is the broker teardown on app-server death (a real default-path hang). An
independent Codex (GPT-5.6) review of the diff then caught two follow-on races that were
hardened in the same 1.3.0 (see Action items): the broker teardown misclassifying an
*intentional* shutdown's app-server close as a death, and a TOCTOU in the reconcile deadline
backstop that could false-finalize a job whose deadline had just been refreshed.

---

## Action items from the 2026-07-13 run

**Applied in `codex@1.3.0`** (432 codex + 109 shared tests green):

1. **Broker teardown on app-server death** — `app-server-broker.mjs`
   (`wireAppServerDeathTeardown` + a single shared `shutdown` promise that destroys sockets;
   the death handler no-ops when a shutdown is already in progress, so an *intentional*
   close is not misread as a death). Test: `tests/codex/app-server-broker.test.mjs`.
2. **Command-output heartbeat** — `codex.mjs` (`item/commandExecution/outputDelta`, throttled
   to ≤1/20s on a monotonic clock, real UTF-8 byte count only). Tests:
   `tests/codex/notification-surfacing.test.mjs`.
3. **Deadline backstop in `reconcileDeadPidJobs`** — `state.mjs`; the CAS guard re-checks the
   deadline on the *fresh* record (TOCTOU close). Tests: `tests/codex/state.test.mjs`
   (incl. the refreshed-deadline race guard).
4. **Transport-watchdog regression test** — `tests/codex/transport-watchdog.test.mjs`
   (disconnect→reject is the tight guard; post-final-answer asserts the success outcome).
5. **`amazonBedrock` auth-status branch** — `codex.mjs` `buildAppServerAuthStatus`. Test:
   `tests/codex/runtime.test.mjs` + fixture profile `bedrock-account`.

**Deliberately NOT changed (with rationale):**

- **`ultra` reasoning effort** — Codex's top tier exists, but it triggers proactive
  multi-agent behavior; exposing it in a single-agent headless task/review runner is a product
  choice, not drift. (Minor doc nit: `gpt-5-6-prompting/SKILL.md` calls `max` the "top tier";
  it's the plugin's top *recommended* tier. Left as-is.)
- **`item/mcpToolCall/progress` heartbeat** — same shape as the command-output heartbeat and a
  candidate if MCP-heavy long turns become common; deferred (command output is the dominant
  long-run case). <!-- ponytail: add if MCP tool calls dominate a long turn -->
- **Broker teardown end-to-end test** — the wiring seam has a unit test; a fake-engine e2e that
  kills the app-server mid-turn would be a stronger guard (see the `e2e-testing` skill) if this
  path ever regresses in practice.

---

## How the audits were run

Each audit was a multi-agent workflow: one agent per dimension/area read **both** repos and
produced a structured finding with `file:line` evidence; every non-trivial finding then went
to an independent adversarial verifier that tried to refute it against the cited source. Only
verified findings are recorded above. (Re-running: fan out the same dimensions/areas listed in
the two result tables.) After the fixes were applied, the full diff was handed to an
independent **Codex (GPT-5.6)** review as a third pass; it caught the two follow-on races noted
in the health bottom-line, which were fixed and re-tested. Recommended when re-running: repeat
that Codex diff-review before considering the pass done.

---

## Audit log

| Date | Codex HEAD | Plugin | Outcome |
|---|---|---|---|
| 2026-07-22 | `4a443994bd` (codex-cli 0.145.0) | 1.4.0 (**unchanged by this audit**) | **No drift — record-only.** codex-cli 0.144.6 → 0.145.0 (58 commits past `d5998e7452`). **Diff:** commits touching the protocol paths are all internal (sandbox / proxy / plugin-list / rollout / HTTP client factory / response-item-ID assignment `#34645` — plugin treats `item.id` opaque); the 3 touching `app-server-protocol` are all **additive**: new `configRequirements/read` fields (`sqlite_home`/`log_dir`/`model_catalog_json`/`feedback`/… on `ConfigRequirements`; `v2/config.rs`) + a `ConfigRequirementReadonly` write-error variant, `PluginListParams.forceRefetch`, new `PathUri`/`FeedbackRequirements`. **`config/read` (`ConfigReadResponse`) — what the plugin reads — untouched;** the new `configRequirements/read` endpoint is not called by the plugin. Zero diff lines hit a durable-checklist identifier. **Source-grounded:** confirmed every checklist item still exists with its expected shape in the 0.145.0 source — 10/10 sent requests in the v2 schema, `turn/start` params incl. `output_schema` on `turn.rs`, Bedrock `usesCodexManagedCredentials` (`common.rs`), `InitializeCapabilities` (`experimental_api`/`request_attestation`/`optOutNotificationMethods`), all 18 notifications + 9 item.type variants, all 8 server-request decline names (`server_request_definitions!`). `build:codex` regenerated types from the installed 0.145.0 CLI; `tsc` passed. Scope: diff + source-grounded checklist verification (proportionate to a patch bump), not the full multi-agent 11-dimension pass. (Plugin 1.4.0 = the unrelated model-auto-fallback feature, not driven by this sync.) |
| 2026-07-13 | `2b0b37abb7` | 1.2.0 → **1.3.0** | No breaking protocol drift. 4 health/observability improvements + 1 auth-label fix applied, then 2 follow-on races (broker intentional-close, reconcile deadline TOCTOU) + 2 nits (monotonic clock, UTF-8 byte count) hardened after an independent Codex (GPT-5.6) diff review. 432 codex + 109 shared green. |
| 2026-07-21 | `d5998e7452` (codex-cli 0.144.6) | 1.3.1 → **1.3.2** | **No breaking drift.** Re-ran all 11 dimensions (adversarially verified) + a coverage critic against 153 commits since `800715d201` (73 protocol-surface). 8 dimensions `none`; 3 non-none, all non-breaking. **Two source-grounded fixes applied in 1.3.2:** (1) **Bedrock auth label** — `account/read`'s `Account::AmazonBedrock` field was renamed/retyped `credentialSource` (string enum `awsManaged`/`codexManaged`) → `usesCodexManagedCredentials` (bool) and the `AmazonBedrockCredentialSource` enum deleted (`protocol/src/account.rs`, `app-server-protocol/src/protocol/v2/account.rs`); the plugin read `account.credentialSource` so the label silently dropped. `buildAppServerAuthStatus` (`codex.mjs`) now reads the bool, mapping true→`codexManaged`/false→`awsManaged`, with a legacy-string fallback for older CLIs. (2) **v1 decline shape** — `ReviewDecision::Denied` became a struct variant `{denied:{rejection}}` (`protocol/src/protocol.rs:4106`, snake_case externally tagged); the dead-path v1 `applyPatchApproval`/`execCommandApproval` replies in `app-server.mjs` were corrected from `{decision:"denied"}` to `{decision:{denied:{rejection}}}` (v2 turn/start flow uses `{decision:"decline"}`, unchanged — never triggered). Coverage critic: all_covered, only new methods are the Apps API (`app/read`/`app/installed`, plugin never calls); no request struct the plugin populates carries `deny_unknown_fields`. **Verified live:** real-engine e2e smoke vs codex-cli 0.144.6 (launch→cancel→wait, 0 violations) + `build:codex` typecheck vs types generated from the installed CLI + full `npm test` green. |
| 2026-07-16 | `800715d201` (rust-v0.144.5) | 1.3.1 (**unchanged**) | **No breaking drift — record-only, no plugin change.** Re-audited all 5 dependency dimensions (requests sent · notifications · item types · account/auth · initialize+server-requests) against 112 commits since `2b0b37abb7`, each finding adversarially refuted against current Rust. Every change touching the plugin's read surface is additive/cosmetic and ignored: `emittedAtMs` (notification timestamp — additive **top-level sibling** of `method`/`params`, not an envelope wrapper; `common.rs:1731-1742`), `cacheWriteInputTokens` (`thread/tokenUsage/updated`; `v2/thread.rs:1458`), `spendControlReached` (`account/rateLimits/updated`; `v2/account.rs:536`), pagination `next_cursor` (responses only — **`thread/list` still does NOT require cursor/limit**, both `Option`, no `deny_unknown_fields`). The two removed fields (`mcpToolCall.appContext.templateId`, `ThreadItemsListResponse.data`) are outside the plugin's read set. `server_request_definitions!` + `InitializeCapabilities` byte-identical since baseline. Launch path (bare `codex app-server` → stdio; `cli/src/main.rs:516`) and hard default model `gpt-5.6-sol` (`codex-companion.mjs:96`) both still valid. |
