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
1b. **Diff the checked-in wire schema first** — the cheapest high-signal pass, and enough on its
   own for a patch bump. `codex-rs/app-server-protocol/schema/json/` is the generated contract, so
   a rename or removal cannot hide in it (unlike reading Rust structs, where a `#[serde(rename)]`
   is easy to miss). Pin the installed binary to a tag (`git rev-list -1 rust-v<version>`) rather
   than diffing to `main`, which runs ahead of what is installed:
   ```bash
   git -C /path/to/codex diff --stat <BASELINE> rust-v<version> -- codex-rs/app-server-protocol/schema/json
   # then read only the DELETIONS — additions are ignored by a tolerant client
   git -C /path/to/codex diff <BASELINE> rust-v<version> -- codex-rs/app-server-protocol/src \
     | grep -E '^-' | grep -vE '^\-\s*(//|\*)'
   ```
   Also run `npm run build:codex` (its `prebuild` regenerates types from the **installed** binary,
   so `tsc` is a real drift check), and for anything touching the error/failure paths, a
   **real-engine smoke** — a live rejected turn has twice disproved a source-plausible assumption
   that the schema alone could not settle.
1c. **Model catalog: read `~/.codex/models_cache.json`, don't call `model/list`.** It is the raw
   upstream catalog the CLI already fetched — every model's `slug`, `visibility`,
   `supported_reasoning_levels`, `default_reasoning_level`, `priority`, `upgrade` — and it carries
   its own `fetched_at` + `client_version`, so you can see how fresh it is before trusting it.
   Offline, no account, no broker contention, no quota. (Fields are snake_case here; the
   app-server v2 wire shape is the camelCase view of the same data.) Fall back to a live
   `model/list` only if the cache is stale or the question is about the wire shape itself.
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
| Codex CLI HEAD | `99660ab3c7` (main @ 2026-08-23; installed binary codex-cli **0.149.0** — still no `rust-v0.149.0` tag, only `release/0.149.0-alpha.*` branches (the nearest tag is `rust-v0.150.0-alpha.7`), so keep pinning diffs to main) |
| Last re-check | 2026-08-23 (wire-schema diff `646f7c0a91`→main, deletion-only read of the 6 files that have any; durable-checklist re-assertion; `build:codex` against types regenerated from the installed 0.149.0 binary) |
| Last FULL 11-dimension audit | 2026-07-21 @ `d5998e7452` (codex-cli 0.144.6) → `codex@1.3.2` |
| Plugin version now | `codex@1.5.0` |
| Codex repo checked | `/home/audichuang/research/codex` |

> **2026-08-09 re-check (`57f42a8113` → main `646f7c0a91`, 80 commits, 20 on protocol paths;
> installed CLI 0.146.1 → **0.147.0**):** **No drift — no plugin change needed.** Cheapest possible
> pass this time: the wire-schema diff is **5 files, +411/−0 — zero deletions anywhere** — and the
> diffstat for `ServerNotification.json`, `ClientRequest.json`, `ServerRequest.json`,
> `v2/item.rs` and `core/src/protocol` is **empty**, i.e. the plugin's entire dependency surface
> (notifications, methods, declines, item variants) is byte-untouched; no checklist re-assertion
> needed. The only two non-comment deletions in `app-server-protocol/src` are both non-wire: the
> broker concurrency-lane label on `externalAgentConfig/detect` (`global("config")` →
> `global("external-agent-detect")`, a method the plugin never calls) and `HookExecutionMode`
> gaining `#[derive(Default)]`. New and unread: `ModelListResponse.multiAgentVersion` (#37433),
> `HooksListResponse` execution mode (#37538), `auto_review.ignore_rules` + `required_on_models` on
> `configRequirements/read` (#37519, #37511). `build:codex` green against types regenerated from
> the installed **0.147.0** binary; full `npm test` exit 0 (twice) on Node 24.16.
> **The one thing worth knowing (behaviour, not drift):** #37511 lets a **managed** workspace
> require auto-review per model, and the plugin's exact `thread/start` pair —
> `approvalPolicy:"never"` + `sandbox:"danger-full-access"` — is literally the tested case at
> `app-server/tests/suite/v2/model_auto_review.rs:119-136`: it **succeeds**, silently coerced to
> `on-request` + `auto_review`, sandbox downgraded to **`workspace-write`**. Two consequences.
> (a) The plugin deliberately picks `danger-full-access` because its target hosts cannot start
> bwrap (`codex.mjs:60-81`), and it does **not** read `thread/started.sandbox`
> (`codex.mjs:574-581` takes only id/name/agentNickname/agentRole) — so on that narrow
> intersection (managed workspace + protected model + bwrap-incapable host) a job would fail as an
> opaque turn error with the cause invisible. Recorded, not coded: the trigger needs an enterprise
> config this plugin's users mostly don't have, and the fix would be dead weight until one hits it.
> (b) The **reject** path (`-32600` "you need to use auto review") is reachable only from
> thread-settings updates and turn overrides (`:166-203`) — which the plugin never sends, since
> `turn/start` carries only `threadId/input/model/effort/outputSchema`. Also hard-errors: protected
> model while auto-review is disabled outright (`:137-150`), with a clear message.
> **Model catalog re-checked offline** (`~/.codex/models_cache.json`, fetched 2026-08-09, stamped
> `client_version` 0.146.0): **1.5.0's ticket lane still holds** — `gpt-5.6-luna` is
> `visibility:"list"`, levels `low…max` with **no `ultra`**, `default_reasoning_level:"medium"`,
> priority 3; sol priority 1 / default `low`; no newer family. The catalog also now carries
> #37433's field, and it **corroborates a rule the plugin already had**: `multi_agent_version` is
> `v2` on sol/terra (the two that offer `ultra`) and `v1` on luna — which is exactly why
> `gpt-5-6-prompting/SKILL.md` refuses to pass `ultra` ("triggers proactive multi-agent delegation
> this single-agent runner can't observe"). Upstream made that reasoning machine-readable; the
> guidance needs no edit.
>
> **2026-08-07 re-check (`2b5bdcf675` → main `57f42a8113`, 159 commits, 61 on protocol paths):**
> **No drift — no plugin change needed.** Wire-schema diff: 22 files, **+249/−4**, and all four
> deleted lines are the same `description` string being reworded. Zero method / notification /
> item-variant removals; the whole Part-1 durable checklist re-asserted green against the
> checked-in schema JSON (11 requests, 19 notifications, 8 declines, 10 item types,
> `TurnStartParams{threadId,input,model,effort,outputSchema}`, `TurnError{message,codexErrorInfo,
> additionalDetails}`). Everything new is additive and unread by the plugin:
> `InitializeParams.extensions` (per-session MCP extension negotiation, #36910 — it *demotes*
> `mcpServerOpenaiFormElicitation` to "legacy", but the field is still there and the plugin sends
> neither), `ModelListResponse.modelSpecialty` (only value so far: `cyber`, used by the TUI for
> safer defaults), `transparentBackground` on the `imageGeneration` item, `onboardingEntrypoint`
> on account-login-completed. `ReasoningEffort` unchanged (`None…Max/Ultra/Custom`).
> `build:codex` green against types regenerated from the installed 0.146.1 binary; full `npm test`
> green on Node 24.
> **One semantic change worth knowing (not drift):** #36893 made
> `commandExecution.command` and `commandActions` **redacted display values, no longer executable
> commands** — secrets are stripped before the item reaches the client, on live items, completed
> items and replayed history alike. The plugin only logs/heartbeats them, so this is a free win
> (job logs can no longer leak a secret that appeared in a command line); the thing not to do is
> ever treat a logged command as replayable. Also landed: #37132 enforces managed-auth
> requirements locally *before* credentials are used — no wire change to `account/read`, but on a
> managed workspace a disallowed login method now fails earlier and harder.
> **Model catalog re-checked offline** — no live `model/list` needed: `~/.codex/models_cache.json`
> is the raw upstream catalog the CLI already fetched (`fetched_at` + `client_version` in the
> file; it was 4 h old and stamped 0.146.1 at check time). `gpt-5.6-luna` is still
> `visibility:"list"` with `supported_reasoning_levels` up to **`max`** (no `ultra`), so
> **1.5.0's ticket-lane routing (luna @ `max`) still holds**; sol is still priority 1 with
> `default_reasoning_level:"low"`; no newer family. Upstream independently corroborates the lane —
> #37103 routes API-key Guardian reviews to luna, and `gpt-5.4-mini.upgrade` is still luna.
>
> **2026-08-02 re-check (`e363b08c91` → main `2b5bdcf675`, 352 commits; 46 past the previous
> pass's forward-look `4642370542`, 13 of those on protocol paths):** **No drift — no plugin
> change needed.** Schema diff: 50 files, +2450/−233, **zero** method/notification/item-variant
> removals. Everything new is a surface the plugin never calls (`threadSection/*` + `thread/section/move`,
> plugin search, external-agent-config import) or an additive field (`readOnlyHint` on tool-call
> items, `encrypted_function_args` in resume history, `ToolRequestUserInputParams.isBlocking`).
> The one type change on a read path is cosmetic: `CommandAction.read.path` moved
> `AbsolutePathBuf` → `LegacyAppPathString`, **both plain JSON strings**. The plugin's `isPinned`
> churn resolved as predicted (added 0.146.0, removed again). **Response shapes the plugin sends
> back are all still valid** — `PermissionsRequestApprovalResponse{permissions,scope,strictAutoReview?}`,
> `ToolRequestUserInputResponse{answers}`, `McpServerElicitationRequestResponse{action,content,_meta}`
> — despite #36365 (strict auto-review for MCP elicitations) and #36410 (explicit input blocking)
> touching those paths. Launch path unchanged (`codex app-server` untouched; `cli/src/main.rs`
> churn is all remote/exec-server daemon). `gpt-5.6-sol`/`terra`/`luna` still the newest family,
> `ReasoningEffort` enum unchanged (incl. `Custom` catch-all). Note: `currentTime/read` — in the
> plugin's decline table — is `#[experimental]` upstream so it is absent from `ServerRequest.json`
> by design (an export test asserts it); the entry is a harmless no-op, not drift.
> **Cheapest way to redo this pass** (~4 commands, no agents): schema diff for method/notification
> deletions, then assert the Part-1 durable checklist against the checked-in schema JSON with a
> throwaway Python script — every list in it is machine-checkable from `ClientRequest.json` /
> `ServerNotification.json` / `ServerRequest.json` / `v2/ItemCompletedNotification.json`.

> **2026-07-31 re-check (codex-cli 0.145.0 → 0.146.0, `4a443994bd` → `rust-v0.146.0` = `e363b08c91`,
> 154 commits, 59 touching protocol paths):** **No drift — no adaptation needed.** New, faster
> method this pass: **diff the checked-in wire schema**
> (`codex-rs/app-server-protocol/schema/json/`, refreshed upstream by #36239) instead of re-reading
> Rust structs — it is the generated contract, so a rename/removal cannot hide in it. Result: 40
> files, +1069/−38, and the ONLY field deletion anywhere in `app-server-protocol/src` is
> `first_party_type` (app metadata, outside the plugin's read set). Zero notification names
> added/removed; `ClientRequest` gained exactly one method (`externalAgentConfig/import/recordHistory`,
> never called) and lost none; `TurnStartParams` / `ThreadStartParams` / `ThreadResumeParams` /
> `ReviewStartParams` / `ConfigReadResponse` / `ModelListResponse` diffstats are **empty**;
> `v2/item.rs` changed only by two `#[serde(default)]` additions on `commandExecution`
> (`pluginId`/`scriptPath`) with no variant added or removed; `protocol/v1.rs`
> (`InitializeCapabilities`) untouched. `gpt-5.6-sol`/`terra`/`luna` all still in the catalog (no
> newer family), `ReasoningEffort` unchanged. **Forward-looking:** main at `4642370542` (0.147-era,
> +152 further commits) also has zero notification / item-variant / client-method changes on the
> plugin's surface — the `isPinned` field added in 0.146.0 is already removed again there, so don't
> chase it. Verified additionally by regenerating types from the installed 0.146.0 binary
> (`prebuild:codex`) + `tsc`, full `npm test` on Node 24, and a **real-engine smoke** (below).

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
  effort|null, outputSchema|null }`. Note it carries **no** approval/sandbox override — that
  matters, see next item.
- **thread/start settings:** `{ approvalPolicy:"never", sandbox: resolveSandboxMode() }`
  (`codex.mjs:89-90,102-103`; sandbox defaults to `danger-full-access` because target hosts
  cannot start Codex's bwrap sandbox). Since 0.147.0 (#37511) a **managed** workspace with
  `auto_review.required_on_models` **silently coerces** exactly this pair at `thread/start` —
  `on-request` + `auto_review` reviewer, sandbox downgraded to `workspace-write`
  (`app-server/tests/suite/v2/model_auto_review.rs:119-136`). Sending the same unsafe values on a
  **thread-settings update or a turn override** is a hard `-32600` "you need to use auto review"
  (`:166-203`) — the plugin stays on the coerced path only because `turn/start` carries no such
  fields. Keep it that way. **Re-pinned at `99660ab3c7`** (the anchors above are pinned to this
  doc's previous baseline `646f7c0a91` and are correct there; upstream has since moved them):
  the `danger-full-access` coercion case plus its
  `assert!(matches!(started.sandbox, SandboxPolicy::WorkspaceWrite{..}))` is
  `model_auto_review.rs:162-180`, the auto-review-disabled hard error `:181-194`, and the hard
  `-32600` settings-update / turn-override path `:198-258`. **And the open question about
  `thread/resume` is now closed by upstream:**
  `thread_resume_and_fork_upgrade_legacy_protected_model_settings`
  (`model_auto_review.rs:291-378 @ 99660ab3c7`) sends both `thread/resume` and
  `thread/fork` with the same unsafe pair the plugin sends (`approval_policy = Some(Never)`,
  `approvals_reviewer = Some(User)`) and asserts `assert_protected_with_policy` — never
  `assert_error`. So resume/fork are on the **coerce** lane, not the `-32600` reject lane, which
  means `buildResumeParams` (`codex.mjs:97-105`) is as safe as `thread/start`. (That test sends no
  `sandbox` field, so `:162-180` remains the only anchor for the sandbox → `workspace-write`
  downgrade.)
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
  Since codex-cli 0.146.x (#36893), `commandExecution.command` and `commandActions` are
  **redacted display strings, not executable commands** — safe to log verbatim (that is the
  point), never safe to treat as replayable.
- **`TurnError` fields read** (`error` notification + terminal `turn.error`): `message`,
  `willRetry` (on the notification), and — added 1.4.1 — `codexErrorInfo`, `additionalDetails`.
  `codexErrorInfo` is a string tag OR a single-key object (`{ httpConnectionFailed: {…} }`); the
  plugin reads the tag either way. **Mapping gotcha, verified live:** Codex derives the code from
  the error **variant, not the HTTP status** — an upstream 400 is
  `CodexErrorDetails::UnexpectedStatus`, which falls into `_ => CodexErrorInfo::Other`
  (`codex-rs/protocol/src/error.rs` `to_codex_protocol_error`). So a model-gate 400 arrives as
  `other`, **not** `badRequest`, and any allow-list gating on `badRequest` alone silently breaks the
  model fallback. If that mapping ever tightens (400 → `badRequest`), `MODEL_GATE_CODES` in
  `codex.mjs` still holds — it allows both.

### Results (11 dimensions, all adversarially verified)

| Dimension | Verdict | Note |
|---|---|---|
| initialize handshake | ✅ none | `InitializeCapabilities` (v1.rs:44-60) is all `#[serde(default)]`/Option, no `deny_unknown_fields`; the new `mcpServerOpenaiFormElicitation` is defaulted, so omitting it is correct. 4 opt-out delta names still exact (common.rs:1641,1668-1670). |
| `turn/completed` terminal error **#32280** | ✅ none | New `error` was added to the **v1** `TurnCompleteEvent` (protocol.rs:1955), which the plugin never reads. The plugin reads the **pre-existing** v2 `Turn.error.message` (thread_data.rs:240-273) via `resolveFinalMessage` — already forward-compatible. `#32263` startedAt likewise additive. |
| notification method names | ✅ none | All 18 handled names byte-identical upstream; none added/renamed/removed this week. Guardian/idle commits are core-only. |
| reasoning effort values | ✅ none | `ReasoningEffort` = None/Minimal/Low/Medium/High/XHigh/Max/**Ultra**/`Custom(String)` (openai_models.rs:40-52). Plugin's `max` is real; `Custom` catch-all means no effort string can 400. `ultra` deliberately not exposed (it triggers proactive multi-agent behavior, a poor fit for a single-agent task/review runner). |
| default model | ✅ none | Plugin default `gpt-5.6-sol` matches this week's promotion of Sol to default; `terra`/`luna` variants also valid. Live catalog, 2026-08-02 (see log row): `gpt-5.6-sol` is `isDefault:true`; **`gpt-5.6-luna` is `hidden:false`** (selectable, not an internal tier) and is the declared `upgrade` target of `gpt-5.4-mini`; per-model `supportedReasoningEfforts` = `low…max` **+ `ultra` on sol/terra only** (luna has no `ultra`; `gpt-5.5`/`5.4`/`5.4-mini`/`spark` stop at `xhigh`, i.e. `max` is out-of-catalog for them — harmless only because `ReasoningEffort` has a `Custom(String)` catch-all). Note `defaultReasoningEffort` is **`low` for sol** / `medium` for terra+luna, well below the plugin's `xhigh` default — the plugin always sends an explicit effort, so this never leaks through. |
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
- **Unrendered `item.type` variants** (noted 2026-07-31) — `describeStartedItem` /
  `describeCompletedItem` return null for `subAgentActivity`, `imageGeneration`, `contextCompaction`,
  `hookPrompt`, `sleep`, `imageView`, `plan`, `userMessage`, so those items produce no progress line
  and `/codex:status`'s phase goes quieter during them. NOT a black box — every non-delta
  notification is still flushed to the per-job log — and none of these are new (the enum is unchanged
  since the previous baseline). Worth a line each only if a real run shows a long stretch of silence;
  `subAgentActivity` is the likeliest, as Codex's multi-agent paths grow.
  <!-- ponytail: add a case per variant only when a real run goes quiet on one -->
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
| 2026-08-23 | `99660ab3c7` (main; installed CLI 0.149.0) | 1.5.0 (**unchanged**) | **No drift — record-only.** 639 commits past `646f7c0a91`. Wire-schema diff (`git -C <codex> diff --stat 646f7c0a91 99660ab3c7 -- codex-rs/app-server-protocol/schema/json`) is **54 files, +5560/−195** — the biggest since this log started, yet **only 6 files carry any deletion at all**: `ClientRequest.json` (3), the two aggregate schemas (92, 63), `v2/HooksListResponse.json` (33), `v2/RawResponseItemCompletedNotification.json` (2), `v2/ThreadResumeParams.json` (2). Swap `--stat` for `--numstat … \| awk '$2>0'` to get that list in one command; then read only those files' `^-` lines. All 3 `ClientRequest.json` deletions are **loosening, not breaking**: `FunctionCallOutputResponseItem.call_id` `string`→`[string,null]` and dropped from `required`, and `account/usage/read` params `null`→nullable object. `ServerNotification.json` is **+333/−0** — the whole notification surface untouched — and every params schema the plugin sends is **byte-identical** (`ThreadStartParams`, `TurnStartParams`, `ReviewStartParams`, `ThreadListParams`, `ModelListParams`, `GetAccountParams`, `ConfigReadParams`); `ThreadResumeParams`' top-level fields are untouched too, its 2 deletions being the same embedded `FunctionCallOutputResponseItem` loosening. Checklist re-asserted: 12 request methods, 19 handled notifications + the 4 opt-out delta names, the 9 server-request declines, the 10 item variants (`v2/item.rs` is **+9/−0**), `TurnError{message,codexErrorInfo,additionalDetails}`, `will_retry` (`v2/notification.rs:56`), and the `TurnStatus` wire values. `build:codex` green against types regenerated from the installed 0.149.0 binary. **Additive-only upstream news, none of it a plugin change:** `CodexErrorDetails::MisalignmentPolicyViolation` (`protocol/src/error.rs:136`) is a **new `codexErrorInfo` tag** and is **non-retryable** (`:389`) — it is not in `MODEL_GATE_CODES` (`codex.mjs:1242`) and the plugin reads tags opaquely, so it surfaces in `errorMessage` without wrongly arming the model fallback; `KnownPlan::EduPlus`/`EduPro` (`protocol/src/account.rs:38,41`) with Bedrock's `uses_codex_managed_credentials` still at `v2/account.rs:42`; `ReasoningEffort` unchanged (None/Minimal/Low/Medium/High/XHigh/Max/Ultra/`Custom(String)`), so 1.5.0's `max` and the `Custom` catch-all both still hold. **One open question closed, recorded not coded:** upstream now proves `thread/resume` and `thread/fork` are on the auto-review **coerce** lane, not the `-32600` reject lane (`model_auto_review.rs:291-378`), so `buildResumeParams` is as safe as `thread/start`; the durable checklist carries the re-pinned anchors. |
| 2026-08-09 | `646f7c0a91` (main; installed CLI 0.147.0) | 1.5.0 (**unchanged**) | **No drift — record-only.** 80 commits past `57f42a8113`, 20 on protocol paths. Cheapest pass yet: wire-schema diff is **+411/−0 (zero deletions)** and the diffstat for `ServerNotification.json` / `ClientRequest.json` / `ServerRequest.json` / `v2/item.rs` / `core/src/protocol` is **empty** — the plugin's whole dependency surface is byte-untouched, so no checklist re-assertion was needed. The two `app-server-protocol/src` deletions are non-wire (a broker lane label on the never-called `externalAgentConfig/detect`; `#[derive(Default)]` on `HookExecutionMode`). `build:codex` green against types regenerated from the installed 0.147.0 binary; `npm test` exit 0 twice on Node 24.16. **One behaviour learned, recorded not coded:** #37511's managed `auto_review.required_on_models` **silently coerces** the plugin's `thread/start` pair (`approvalPolicy:"never"` + `danger-full-access`) to `on-request` + `auto_review` + **`workspace-write`** — the tested case at `model_auto_review.rs:119-136`. The plugin picks full-access precisely because its hosts can't run bwrap and never reads `thread/started.sandbox`, so on managed-workspace + protected-model + bwrap-incapable hosts a job fails opaquely; too narrow an intersection to carry code for. The hard `-32600` "you need to use auto review" path is unreachable from the plugin (settings-update / turn-override only; `turn/start` carries no approval or sandbox fields — the durable checklist now says so). **Catalog re-checked offline:** luna still `visibility:"list"`, `low…max`, no `ultra` → **ticket lane holds**; and #37433's new `multi_agent_version` (`v2` on sol/terra, `v1` on luna) independently corroborates why `gpt-5-6-prompting` refuses to pass `ultra`. |
| 2026-08-07 | `57f42a8113` (main; installed CLI 0.146.1) | 1.5.0 (**unchanged**) | **No drift — record-only.** 159 commits past `2b5bdcf675`, 61 on protocol paths. Wire-schema diff +249/−4 with the only deletions being one reworded `description`; full durable checklist re-asserted green from the checked-in schema JSON; `build:codex` (types regenerated from the 0.146.1 binary) + full `npm test` green on Node 24. Additions are all unread: `InitializeParams.extensions`, `ModelListResponse.modelSpecialty`, `transparentBackground`, `onboardingEntrypoint`. **Two things learned, both recorded above rather than coded:** (1) #36893 makes `commandExecution.command`/`commandActions` **redacted display values** — a free secret-leak win for job logs, and a standing "never replay a logged command" rule; (2) the model catalog can be checked **offline** from `~/.codex/models_cache.json` (raw upstream catalog + `fetched_at`/`client_version`), which is how 1.5.0's luna-@-`max` ticket lane was re-confirmed (`visibility:"list"`, levels `low…max`, no `ultra`) without a live `model/list`. Recipe folded into "How to keep this current" step 1c. |
| 2026-08-02 | installed CLI 0.146.0 (live account, no source diff) | 1.4.1 (**unchanged** — guidance-only edit) | **Live model-catalog check, prompted by OpenAI's 2026-07-30 price cut** (Luna −80% → $0.20/$1.20, Terra −20% → $2/$12, Sol unchanged; `Fast mode` replaces Priority Processing). Verdict: **no protocol drift, one guidance gap closed.** Evidence = a real `model/list {includeHidden:true}` against this machine's ChatGPT account: 8 models, `gpt-5.6-luna` **`hidden:false`** with `supportedReasoningEfforts` `low…max` (no `ultra`), `defaultReasoningEffort:"medium"`, text+image, and `gpt-5.4-mini.upgrade === "gpt-5.6-luna"` — so Luna is the supported small-model lane, not an internal tier. The `gpt-5-6-prompting` skill had it written off as "rarely the right fit" and carried Terra's **pre-cut** price; both fixed, plus the rule that **Luna is only worth delegating to at `--effort max`** (≈27 → ≈51 on the Artificial Analysis index off→max) and its two real weak spots (MRCR v2 512K–1M ≈41% vs Sol ≈74%; OSWorld 2.0 ≈46%). `codex-rescue.md` gained a "Luna lane" so a small fully-specified task can reach Codex at all (its charter previously excluded simple asks). **Verified live on 0.146.0:** read-only Q&A turn `--model gpt-5.6-luna --effort max` → correct answers with correct `file:line`, 23s; write turn in a scratch git repo → correct `slugify` hardening + a passing `node:test` file, 1m49s, `touchedFiles` exactly the two requested. **Re-run recipe:** `model/list` goes through the shared broker via `listSupportedModels`, which returns `{checked:false, detail:"Shared Codex broker is busy."}` whenever any turn holds the broker — probe with `CodexAppServerClient.connect(cwd, {disableBroker:true})` + `client.request("model/list", {includeHidden:true})` instead. **Fixture realigned to this evidence:** `fake-codex-fixture.mjs` had `gpt-5.6-luna` as `hidden:true` (wrong) and no hidden entry at all in the `model-unsupported` branch, so setup's `!hidden` suggestion filter was never exercised; it now carries the real hidden entry (`codex-auto-review`) and `runtime.test.mjs` asserts it is never suggested — proven non-vacuous (dropping the filter reddens exactly that assertion). |
| 2026-08-02 | `2b5bdcf675` (main, 0.147-alpha era; installed CLI still 0.146.0) | 1.4.1 (**unchanged**) | **No drift — record-only.** 352 commits past `e363b08c91` (13 on protocol paths past the last forward-look). Zero method / notification / item-variant removals; all additions are surfaces the plugin never calls (`threadSection/*`, plugin search, external-agent-config import) or additive fields (`readOnlyHint`, `encrypted_function_args`, `isBlocking`). Only read-path type change is `AbsolutePathBuf` → `LegacyAppPathString` on `CommandAction.read.path` — both plain strings. Decline-reply shapes re-verified against the structs (#36365 / #36410 touched those paths but not the response types). Launch path + model catalog + `ReasoningEffort` unchanged. Details + the cheap re-run recipe in the Baseline block. |
| 2026-07-31 | `e363b08c91` (`rust-v0.146.0`, codex-cli 0.146.0) | 1.4.0 → **1.4.1** | **No protocol drift** (details in the Baseline block: wire-schema diff of `app-server-protocol/schema/json/`, 154 commits / 59 on protocol paths, only additive changes + one deletion outside the read set; forward-checked to main `4642370542` too). **Two fixes applied, both long-standing gaps rather than adaptations.** (1) **Structured error fields were never read.** `TurnError.codexErrorInfo` + `additionalDetails` existed since before the previous baseline and the plugin used neither — every failure decision and surfaced reason came from regex-matching English. 1.4.1 tags the code and keeps the details in `errorMessage` (via `describeTurnError`, so it flows to `/codex:status`, `/codex:wait`, the persisted record, and `--json` alike), gates `isModelUnavailableFailure` on the codes a gate can arrive under, and prefers a structured `unauthorized` over the auth regex in `isTerminalTurnError` (`willRetry` still outranks it). **The live smoke earned its keep here:** the first attempt allow-listed `badRequest`, which a real rejected turn disproved — the code came back `other`, because the mapping is by error variant (`UnexpectedStatus` → `_ => Other`), so that version would have silently disabled the 1.4.0 model fallback. `fake-codex-fixture.mjs` now emits `codexErrorInfo: "other"` so the hermetic e2e reproduces the real shape and fails on exactly that mistake. (2) **A job in the wrong state was reported as missing** — `/codex:cancel <just-finished-id>` said `No job found`; `matchJobReference` could not distinguish "predicate excluded it" from "unknown id", which also left `resolveResultJob`'s "still running" message dead for an explicit reference. Both now say what is true. **Verified:** 469 codex + full chain green on Node 24, `build:codex` against types regenerated from the 0.146.0 binary, and a real-engine smoke on live 0.146.0 (launch → `wait --timeout-ms 0` 79ms → completed exit 0 → cancel → `wait` exit 2; plus the real rejected turn and the two new cancel messages). Scope: wire-schema diff + source-grounded checklist + live smoke (proportionate to a patch bump), not the full multi-agent 11-dimension pass. |
| 2026-07-22 | `4a443994bd` (codex-cli 0.145.0) | 1.4.0 (**unchanged by this audit**) | **No drift — record-only.** codex-cli 0.144.6 → 0.145.0 (58 commits past `d5998e7452`). **Diff:** commits touching the protocol paths are all internal (sandbox / proxy / plugin-list / rollout / HTTP client factory / response-item-ID assignment `#34645` — plugin treats `item.id` opaque); the 3 touching `app-server-protocol` are all **additive**: new `configRequirements/read` fields (`sqlite_home`/`log_dir`/`model_catalog_json`/`feedback`/… on `ConfigRequirements`; `v2/config.rs`) + a `ConfigRequirementReadonly` write-error variant, `PluginListParams.forceRefetch`, new `PathUri`/`FeedbackRequirements`. **`config/read` (`ConfigReadResponse`) — what the plugin reads — untouched;** the new `configRequirements/read` endpoint is not called by the plugin. Zero diff lines hit a durable-checklist identifier. **Source-grounded:** confirmed every checklist item still exists with its expected shape in the 0.145.0 source — 10/10 sent requests in the v2 schema, `turn/start` params incl. `output_schema` on `turn.rs`, Bedrock `usesCodexManagedCredentials` (`common.rs`), `InitializeCapabilities` (`experimental_api`/`request_attestation`/`optOutNotificationMethods`), all 18 notifications + 9 item.type variants, all 8 server-request decline names (`server_request_definitions!`). `build:codex` regenerated types from the installed 0.145.0 CLI; `tsc` passed. Scope: diff + source-grounded checklist verification (proportionate to a patch bump), not the full multi-agent 11-dimension pass. (Plugin 1.4.0 = the unrelated model-auto-fallback feature, not driven by this sync.) |
| 2026-07-13 | `2b0b37abb7` | 1.2.0 → **1.3.0** | No breaking protocol drift. 4 health/observability improvements + 1 auth-label fix applied, then 2 follow-on races (broker intentional-close, reconcile deadline TOCTOU) + 2 nits (monotonic clock, UTF-8 byte count) hardened after an independent Codex (GPT-5.6) diff review. 432 codex + 109 shared green. |
| 2026-07-21 | `d5998e7452` (codex-cli 0.144.6) | 1.3.1 → **1.3.2** | **No breaking drift.** Re-ran all 11 dimensions (adversarially verified) + a coverage critic against 153 commits since `800715d201` (73 protocol-surface). 8 dimensions `none`; 3 non-none, all non-breaking. **Two source-grounded fixes applied in 1.3.2:** (1) **Bedrock auth label** — `account/read`'s `Account::AmazonBedrock` field was renamed/retyped `credentialSource` (string enum `awsManaged`/`codexManaged`) → `usesCodexManagedCredentials` (bool) and the `AmazonBedrockCredentialSource` enum deleted (`protocol/src/account.rs`, `app-server-protocol/src/protocol/v2/account.rs`); the plugin read `account.credentialSource` so the label silently dropped. `buildAppServerAuthStatus` (`codex.mjs`) now reads the bool, mapping true→`codexManaged`/false→`awsManaged`, with a legacy-string fallback for older CLIs. (2) **v1 decline shape** — `ReviewDecision::Denied` became a struct variant `{denied:{rejection}}` (`protocol/src/protocol.rs:4106`, snake_case externally tagged); the dead-path v1 `applyPatchApproval`/`execCommandApproval` replies in `app-server.mjs` were corrected from `{decision:"denied"}` to `{decision:{denied:{rejection}}}` (v2 turn/start flow uses `{decision:"decline"}`, unchanged — never triggered). Coverage critic: all_covered, only new methods are the Apps API (`app/read`/`app/installed`, plugin never calls); no request struct the plugin populates carries `deny_unknown_fields`. **Verified live:** real-engine e2e smoke vs codex-cli 0.144.6 (launch→cancel→wait, 0 violations) + `build:codex` typecheck vs types generated from the installed CLI + full `npm test` green. |
| 2026-07-16 | `800715d201` (rust-v0.144.5) | 1.3.1 (**unchanged**) | **No breaking drift — record-only, no plugin change.** Re-audited all 5 dependency dimensions (requests sent · notifications · item types · account/auth · initialize+server-requests) against 112 commits since `2b0b37abb7`, each finding adversarially refuted against current Rust. Every change touching the plugin's read surface is additive/cosmetic and ignored: `emittedAtMs` (notification timestamp — additive **top-level sibling** of `method`/`params`, not an envelope wrapper; `common.rs:1731-1742`), `cacheWriteInputTokens` (`thread/tokenUsage/updated`; `v2/thread.rs:1458`), `spendControlReached` (`account/rateLimits/updated`; `v2/account.rs:536`), pagination `next_cursor` (responses only — **`thread/list` still does NOT require cursor/limit**, both `Option`, no `deny_unknown_fields`). The two removed fields (`mcpToolCall.appContext.templateId`, `ThreadItemsListResponse.data`) are outside the plugin's read set. `server_request_definitions!` + `InitializeCapabilities` byte-identical since baseline. Launch path (bare `codex app-server` → stdio; `cli/src/main.rs:516`) and hard default model `gpt-5.6-sol` (`codex-companion.mjs:96`) both still valid. |
