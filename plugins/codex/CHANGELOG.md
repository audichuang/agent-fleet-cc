# Changelog

## 1.5.0

**`gpt-5.6-luna` becomes a real lane.** OpenAI cut Luna 80% on 2026-07-30 ($0.20 / $1.20 per 1M
tokens; Terra −20% to $2 / $12), and Codex's own catalog declares `gpt-5.4-mini`'s upgrade target
as `gpt-5.6-luna` — the small-model lane is the supported one now. The `gpt-5-6-prompting` skill
had Luna written off as "rarely the right fit here" and still priced Terra pre-cut, so every
routing decision made from that table was wrong in the cheap direction.

- **Model selection routes on "how much thinking is left"** — **thinker** (`sol`) / **executor**
  (`terra`) / **ticket-runner** (`luna`) — in one table. `luna` takes work that fits on a
  **ticket**: one bounded change, spelled out, nothing left to decide.
- **`luna` is pinned to `--effort max`.** Its capability is an effort curve, not a fixed number
  (≈27 on the Artificial Analysis index with reasoning off, ≈51 at `max`), so a cheap model at low
  effort is the one combination that buys nothing. **One ticket per run** — bundling tickets into a
  single prompt walks into Luna's long-context weakness (MRCR v2 at 512K–1M ≈41% vs `sol` ≈74%;
  OSWorld 2.0 ≈46%, so GUI/computer-use stays on `sol`).
- **`codex-rescue` gained a Ticket lane.** Its charter excluded simple asks, so a ticket could not
  reach Codex at all; it now takes one and forwards it with `--model gpt-5.6-luna --effort max`.
  This is the only case where the forwarder picks the model itself.
- **New `references/delivery-paths.md`** — choosing *how* work reaches Codex (direct `task` ·
  `--resume-last` · the `codex-rescue` subagent · a conversation fork) is a separate decision from
  choosing the model, and it has measured costs: one trivial subagent forward is **20,732 tokens**,
  because `skills:` frontmatter preloads the full skill text at every spawn. That buys proactive
  discovery and the `tools: Bash` guardrail — **not** context isolation, which Codex's own context
  already provides. The two cheapest rows are both `/codex:task`, which is `disable-model-invocation`
  — Claude can only *recommend* those; the paths it can execute itself are the subagent and
  `/subtask`, so the cost table is a recommendation guide, not a menu Claude picks from silently.
  Also documents the three-way "fork" naming trap: `context: fork` is *not* a
  conversation fork ("It won't have access to your conversation history") and is what caused the
  #234 recursion.
- **Test hardening.** `fake-codex-fixture.mjs` now mirrors the live `model/list`: `gpt-5.6-luna` is
  `hidden:false`, and the `model-unsupported` branch carries the genuinely hidden `codex-auto-review`
  so setup's `!hidden` suggestion filter is actually exercised — previously that assertion passed
  whether or not the filter worked. Proven non-vacuous: dropping the filter reddens exactly it.

**Verified live on codex-cli 0.146.0** (not hermetically): a read-only turn and a write turn on
`gpt-5.6-luna --effort max`, with model and effort confirmed from Codex's own rollout records; the
write turn's diff and its generated `node:test` file independently re-run; and one real
`codex:codex-rescue` spawn end-to-end, confirming the `--model` / `--effort` pass-through strips the
flags from the prompt text. No runtime code changed in this release.

## 1.4.1

Read the app-server's **structured** error fields instead of only its prose. The v2 `TurnError`
carries `codexErrorInfo` (a machine-readable code: `unauthorized`, `usageLimitExceeded`,
`badRequest`, `contextWindowExceeded`, …) and `additionalDetails` next to `message`; both were
being dropped, so every failure decision and every surfaced reason came from regex-matching
English.

- **The model-fallback safety property is now structural, not regex-conservative.**
  `isModelUnavailableFailure` requires the code to be one that a model gate can actually arrive
  under (`badRequest` or `other`) — or absent, on an older CLI — before matching the gate phrase.
  An `unauthorized` / `usageLimitExceeded` / `contextWindowExceeded` failure can no longer be
  model-switched however its prose reads, and an unknown future code takes the safe direction (no
  switch). `other` is in the set by **live evidence, not guesswork**: Codex maps an error to a code
  by error VARIANT, not HTTP status, and an upstream 400 is `CodexErrorDetails::UnexpectedStatus` →
  the `_ => CodexErrorInfo::Other` catch-all (`codex-rs/protocol/src/error.rs`); a real rejected
  turn on 0.146.0 returned `[other]`. An allow-list of `badRequest` alone would have silently
  disabled the whole 1.4.0 fallback.
- **The fake engine now emits the real wire shape.** `tests/codex/fake-codex-fixture.mjs` sends
  `codexErrorInfo: "other"` on its terminal error notifications (its `turn.error` path stays
  code-less to keep covering the no-code branch), so the hermetic e2e stops modelling a payload the
  real engine never produces — it now fails on exactly the allow-list mistake above.
- **`errorMessage` keeps the actionable half.** `describeTurnError` appends `additionalDetails`
  (often the upstream HTTP body) when it isn't already in the message, and tags the code —
  `"Usage limit reached [usageLimitExceeded]"` — so a delegating commander can branch on a failed
  `--json` payload without parsing prose. Flows through `/codex:status`, `/codex:wait`, the
  persisted record, and the foreground `--json` alike (one seam: `failureReasonFor`).
- **`isTerminalTurnError`** treats a structured `unauthorized` as terminal when `willRetry` is
  absent, where the narrow auth regex was only guessing. `willRetry` still outranks it — a server
  promising a retry is never short-circuited.
- Tests: `turn-error-surfacing` (code tag, object-form tag, details de-duplication, malformed
  info), `model-fallback` (the never-switch-on-another-code property + `badRequest` still
  switches), `permanent-auth-shortcircuit` (structured auth vs. `willRetry` precedence). Proven
  non-vacuous: neutering the three branches fails 5 of them.

Also fixed, found by the real-engine smoke: **a job in the wrong state for an action was reported
as missing.** `/codex:cancel <id>` on a job that had just finished answered `No job found for
"<id>". Run /codex:status to list known jobs.` — telling the operator the record was gone when
`/codex:status` shows it plainly. Root cause in `matchJobReference` (`job-control.mjs`): it only
ever saw the pre-filtered list, so "excluded by the predicate" and "unknown id" collapsed into one
message. It now returns null for a reference that resolves against the unfiltered list, letting
each caller's own state-specific message run; an unknown or ambiguous reference still errors as
before. That also makes `resolveResultJob`'s authored "Job X is still running. Check
/codex:status and try again once it finishes." reachable — for an explicit reference it was dead
code. Live-verified: `already completed; nothing to cancel` / `already cancelled; nothing to
cancel`, and an unknown id still says `No job found`. Test:
`tests/codex/job-reference-state.test.mjs` (fails 2/5 on the pre-fix code).

Verified against codex-cli **0.146.0**: full `npm test` + `build:codex` green, and a real-engine
smoke (live 0.146.0) covering launch → `wait --timeout-ms 0` (79ms, no default block) → completed
`wait` exit 0 → cancel → `wait` exit 2, plus a real rejected turn confirming `codexErrorInfo`
reaches `errorMessage`. See the 2026-07-31 row in `docs/codex-protocol-sync-audit.md` — no protocol
drift in 0.145.0 → 0.146.0; everything here is a long-standing gap, not an adaptation.

## 1.4.0

Auto-fallback to `gpt-5.6-terra` when the frontier tier is unavailable. The default model
`gpt-5.6-sol` is intermittently gated on ChatGPT-account Codex and rejects a turn with HTTP 400
"The 'X' model requires a newer version of Codex" — the same turn succeeds on other days, so it
read as "the plugin is broken."

- `task`, `review`, and `adversarial-review` now retry the turn **once** on `gpt-5.6-terra` when it
  failed *specifically* because the model was unavailable (`isModelUnavailableFailure` — an
  anchored, conservative match, so auth / rate-limit / genuine turn errors that merely mention a
  model are never model-switched; both error sources are checked so neither masks the other). It
  never re-runs a turn that already executed a command or touched a file, so a `--write` task's
  side effects can't be duplicated.
- The degrade is **visible**, never silent: a progress line ("Model gpt-5.6-sol is unavailable;
  retrying on gpt-5.6-terra") plus a `modelFallback: { from, to }` field on the `--json` payload.
- Builds on 1.3.3's failure-surfacing: if `terra` also fails, the real reason is surfaced (not a
  bare "failed"). An explicit `--model gpt-5.6-terra` (or `CODEX_DEFAULT_MODEL=gpt-5.6-terra`)
  skips the redundant retry.
- Tests: `tests/codex/model-fallback.test.mjs` — detection units (varied phrasings + false-positive
  traps + both-sources) plus black-box e2e driving the real CLI for task / native review /
  adversarial review (sol rejected → terra succeeds), a retry-boundary attempt-count guard, and a
  terra-also-fails surfacing case; proven non-vacuous.

Independent review (Codex, gpt-5.6-sol) hardened the detection regex (dropped bare
`model … unsupported/unknown` that false-matched real turn errors), added the two-source check and
the did-work retry guard, and broadened the e2e coverage.

## 1.3.3

Fix a **silent failure**: a task/review turn ended by an app-server `error` notification
(e.g. HTTP 400 "model requires a newer version of Codex", permanent auth) RETURNED a failed
execution rather than throwing, and the failure reason never reached the structured
`errorMessage` field. So `/codex:status`, `/codex:wait`, the persisted record, AND the foreground
`--json` output showed a bare "failed" with an empty result — the reason lived only in the
log/rendered blob. A delegating commander parsing `--json` got `errorMessage: null, rawOutput: ""`
and had nothing to relay ("the job just died and I don't know why").

- `runTrackedJob` persists `errorMessage` on a failed RETURN — the one point every runner's failed
  return converges — mirroring the throw/crash paths that already did.
- Every failed runner return now carries a structured `errorMessage` on **both** the foreground
  `--json` payload and the persisted record, across all three shapes: `task`, native `review`, and
  `adversarial-review`. On failure it never degrades to a success-sounding summary
  ("… finished." / "Review completed."); a messageless error yields a definite reason.
- New `describeTurnError` unwraps the app-server error shape (including the observed case where
  `.message` is a JSON-encoded `{ error: { message } }` envelope) to the human sentence — bounded
  parse/length so an oversized external error can't bloat the record.
- Covers **both** failure shapes: a standalone `error` notification, and a terminal
  `turn/completed` carrying `turn.error` with no preceding notification — the reason is taken from
  `turn.error` first, then the error notification, then stderr, then a definite fallback.
- Regression tests (`tests/codex/turn-error-surfacing.test.mjs`): finalize + extraction units, plus
  black-box e2e that drives the real CLI against a fake app-server emitting a terminal error for
  `task`/`review`/`adversarial-review` `--json`. Both seams are proven non-vacuous (they fail on
  pre-fix code).

Two independent review passes (Codex, gpt-5.6-sol): the first caught that the initial cut fixed
only the persisted record and the adversarial-review path; the second caught the `turn.error`
failure shape. This entry reflects the completed fix.

## 1.3.2

Protocol-sync pass against codex HEAD `d5998e7452` (2026-07-21, codex-cli 0.144.6) — 153 commits
past the 1.3.1 baseline `800715d201`. **No breaking drift** (multi-agent audit, all 11
dimensions adversarially verified plus a coverage critic; full details in the source repo's
`docs/codex-protocol-sync-audit.md`). Two source-grounded should-upgrade fixes:

- **Amazon Bedrock auth label** — upstream replaced the `account/read` Bedrock field
  `credentialSource` (string enum) with `usesCodexManagedCredentials` (bool);
  `buildAppServerAuthStatus` now reads the new bool and falls back to the legacy string for
  older CLIs, so the codexManaged/awsManaged label no longer silently drops.
- **v1 approval-decline shape** — `ReviewDecision::Denied` became a struct variant
  `{ denied: { rejection } }`; the (dead-path, v2-only client) `applyPatchApproval` /
  `execCommandApproval` decline replies were corrected to match, so an unexpected v1 request
  still declines cleanly instead of hitting `-32601`.

Verified live: real-engine e2e smoke against codex-cli 0.144.6 (launch → cancel → wait
contract, 0 violations) plus `build:codex` typecheck against types generated from the installed
CLI. Full suite green.

## 1.3.1

Docs-only: realign the `gpt-5-6-prompting` skill with the latest official GPT-5.6 prompting
guide. Adds a tool-routing rule (parallelise independent reads, keep dependent ones
sequential, try one or two fallbacks before concluding a search/read is empty), a `Tools`
section in the suggested prompt structure, a matching reusable Tool-routing block, and a note
that the user's-language handoff convention is a deliberate product choice — not the blanket
"always respond in the user's language" rule the guide warns against. Guide additions that
this plugin can't action from the prompt layer (Programmatic Tool Calling, `text.verbosity`,
prompt caching / persisted state, frontend-visual guidance) were deliberately omitted.

## 1.3.0

Long-run health + observability hardening and a protocol-sync pass, from a two-part audit
against codex HEAD `2b0b37abb7` (2026-07-13), then hardened after an independent Codex
(GPT-5.6) review. Full details in the source repo's `docs/codex-protocol-sync-audit.md`.
Full suite green (432 codex + 109 shared).

**Long-running task (~20 min) robustness & observability**

- **Broker tears down when its app-server dies.** If the underlying `codex app-server`
  crashes/OOMs while the broker Node parent survives, the broker now ends every client
  socket the moment `appClient.exitPromise` resolves. Previously the worker's socket stayed
  open and silent, so an in-flight turn hung until the 1-hour hard cap; now its transport
  watchdog finalizes it in seconds (`app-server-broker.mjs`).
- **Command-output heartbeat.** A single long command (e.g. a 15-min build/test) used to go
  dark on `/codex:logs` and `/codex:status` between `item/started` and `item/completed`. The
  plugin now surfaces a throttled liveness line from `item/commandExecution/outputDelta`
  (≤1 per 20s, byte count only — never the raw chunks), which also keeps the watchdog's
  `quietMs` fresh during a long command (`codex.mjs`).
- **Deadline backstop in dead-PID reconcile.** `reconcileDeadPidJobs` now finalizes a job
  that blew past its persisted `timeoutAt` (+60s grace) regardless of PID liveness — closing
  the recycled-PID hole and giving foreground jobs (which never get a watchdog) a wall-clock
  backstop instead of sticking at "running" (`state.mjs`).
- **Transport-watchdog regression test.** The mid-turn-disconnect finalizer is now covered by
  a test that resolves `exitPromise` (previously every test stubbed it to never resolve): the
  no-final-answer case asserts the turn rejects promptly; the post-final-answer case asserts a
  success outcome.
- **Post-review hardening (independent Codex review).** Broker teardown now runs a single
  shared shutdown promise and ignores the app-server exit that an *intentional* shutdown
  causes (so idle/SIGTERM close cleanly without a spurious `exit(1)` racing cleanup); the
  reconcile deadline backstop re-checks the deadline on the *fresh* record inside the CAS
  guard (closing a TOCTOU where a just-refreshed deadline could false-finalize a healthy job);
  the heartbeat uses a monotonic clock + real UTF-8 byte length.
- Audited and confirmed already solid (no change): watchdog false-kill safety, idle-broker
  reaping vs. an active turn, and live background progress durability to the per-job log.

**Protocol sync**

- **`amazonBedrock` account type** — `account/read` can return `Account::AmazonBedrock
  { credentialSource }`. `buildAppServerAuthStatus` now reports `Amazon Bedrock login active
  (awsManaged|codexManaged)` with `authMethod:"amazonBedrock"` instead of the generic
  "provider does not require OpenAI authentication" fallthrough with `authMethod:null`.
  Status-label only — login gating was already correct.
- The rest of the app-server surface (initialize handshake, `turn/completed` terminal errors
  #32280, notification names, effort values incl. `ultra`, default model, review/guardian
  flow, server→client declines, thread params, item types) was audited and confirmed in sync.

## 1.2.0

`/codex:setup` now verifies the default model is usable by the account.

- **Model-support check** — setup probes the app-server `model/list` and confirms the
  effective default model (`resolveDefaultModel()`, honoring `CODEX_DEFAULT_MODEL`) is in
  the account's catalog. Not every Codex version/account is gated into 5.6 yet, so an older
  install would otherwise pass setup and only 400 on the first task. When the default is
  missing, setup adds a **warning** (never blocks `ready`) pointing to `codex update` or a
  `CODEX_DEFAULT_MODEL` override, and lists models the account actually has.
- The probe needs an authenticated app-server, so it is skipped when Codex is logged out
  (the existing login nextStep covers that) and degrades to "not checked" on any app-server
  error — setup never fails on the model probe.

## 1.1.1

Docs cleanup finishing the 5.6 migration. No functional change.

- **`gpt-5-6-prompting` skill** — dropped the leftover GPT-5.5 transition wording; 5.6 is now
  the baseline. The `terra` variant is described as cheaper than `sol` rather than compared to
  the retired 5.5. Historical CHANGELOG / spec / plan mentions of 5.5 are kept as-is (they
  record what was true at the time).

## 1.1.0

GPT-5.6 support. Codex now defaults to the new frontier model and can dial its new top
reasoning tier. Full suite green (420 codex tests).

- **Default model → `gpt-5.6-sol`** — `resolveDefaultModel()` now defaults to the frontier
  GPT-5.6 tier instead of `gpt-5.5`. Uses the **explicit** `gpt-5.6-sol` slug, not the
  `gpt-5.6` family alias — the alias is not resolvable on ChatGPT-account Codex (400).
  Verified live: `gpt-5.6-sol` and `gpt-5.6-terra` both work; the alias fails. Still
  forwarded verbatim and overridable via `--model` / `CODEX_DEFAULT_MODEL`.
- **`max` reasoning effort** — added to the accepted `--effort` values
  (`none|minimal|low|medium|high|xhigh|max`); `max` is GPT-5.6's tier above `xhigh`,
  reserved for the hardest quality-first tasks.
- **Prompting skill renamed `gpt-5-5-prompting` → `gpt-5-6-prompting`** and rewritten for
  5.6: model-selection guidance (sol vs terra; luna rarely needed), shorter-prompt bias,
  the "don't ask for generic brevity" caveat, and a one-shot autonomy/permissions policy.
  The 5.5 outcome-first methodology carries over unchanged.

## 1.0.35

A follow-up to the 1.0.34 adversarial review found a background-launch race the
directory-per-job migration left untouched. Full suite + e2e green.

- **Bootstrap race (background jobs)** — `enqueueBackgroundTask` spawns the detached
  task-worker *before* it writes the job record (`spawnWorker` then `writeJobFile`, no
  await between). Normally the parent's synchronous write wins against the child's Node
  bootstrap, but under scheduler pressure the child could reach `readStoredJob` first and
  hard-throw `No stored job found`, killing the background job instantly. `handleTaskWorker`
  now bounded-waits via `readStoredJobWithRetry` (~2s: 40 × 50ms) instead of betting on the
  order. New regression tests (`tests/codex/enqueue-background.test.mjs`, `wait-logs.test.mjs`).
- **`wait` ergonomics** — document `--timeout-ms`/`--poll-interval-ms` in usage (the flags
  already worked as of 1.0.34) and make the missing-job-id error point at `/codex:status`.

## 1.0.34

A follow-up adversarial review (cross-model, read-only) of the 1.0.31→1.0.33 range
found two defects the changeset itself introduced. Both fixed; the other two findings
were pre-existing code outside this range and are deferred to the shared-runtime
migration. Full suite + e2e green.

- **R5 (blocker)** — codex's own duplicate orphan-lock repair
  (`state.mjs` `reconcileDeadPidJobs`) wrote with the default `writeJob()`, missing the
  R3 `ensureDir:false` hardening the shared `reconcileDeadPids` got: a concurrent prune
  that deleted the job dir between the fresh-read and the write would be resurrected
  (TOCTOU). Now mirrors the shared pattern (`ensureDir:false` + try/catch + abort).
  New regression test (`tests/codex/reconcile-no-resurrect.test.mjs`), teeth-proven.
- **R6 (reporting)** — `/codex:cancel` on a CAS loss reported `result.stored.status`,
  the pre-claim snapshot (still `"running"`), mis-stating a finished job as active. Now
  resolves the authoritative status (terminal.lock) first, then the legacy index. No
  safety impact (a lost CAS never signalled the pid).

Deferred (pre-existing, not in the 1.0.31→1.0.33 diff): the session-end cleanup hook
still decides off raw `job.json.status` before the CAS, and the shared public
`waitForJob`/`cancelJob` readers do not overlay the terminal.lock. Both land with the
shared-runtime migration (which also deletes codex's duplicate reconcile).

## 1.0.33

Close the Phase 1A read-side gaps a 4-lens adversarial review found: the
lock-as-authority overlay was wired into `listJobs` but not the readers that read
`job.json` directly, so the markJobRunning-vs-finalizeJob window (the `.wlock`
removal opened) could over-wait/over-tail a finished job. TDD; 8 regression tests;
hermetic suite + real-engine smoke + completed happy-path all green.

- **R1 (major)** — `/codex:attach` and `/codex:logs --follow` (`handleAttach`'s
  `readStatus`) read raw `job.json.status`; now read through
  `resolveAuthoritativeStatus` (terminal.lock over a stale job.json).
- **R2 (minor)** — the cross-workspace lookup (`findJobByIdAcrossWorkspaces`) now
  overlays the terminal.lock (mirrors `listJobs`), so `/codex:wait <foreign-id>`
  no longer polls to timeout on a finished job.
- **R3 (shared)** — `writeJsonAtomic`/`writeJob` gain `ensureDir:false`; the
  reconcile lock-repair (shared + codex) writes with it + try/catch, so a dir a
  concurrent prune deleted fails cleanly instead of being resurrected (TOCTOU).
- **R4 (shared)** — new `sweepOrphanLockDirs` (called by `pruneJobs` + codex
  `saveState`) reaps a lock-only zombie dir left by a prune that crashed between
  the `job.json` and `terminal.lock` unlinks; in-flight dirs (no lock) untouched.

Shared changes re-vendored into cc + codex.

## 1.0.32

Phase 1A of the shared state-store migration (no behaviour change — every consumer + e2e
preserved). codex's persistence moves onto the shared directory-per-job store
(`shared/lib/core/state-store.mjs`), making the B/C cross-process races structurally
impossible rather than mitigated, and shrinking `state.mjs`.

- **1a** directory-per-job layout (`jobs/<id>/{job.json,log,done.json,terminal.lock}`);
  `saveState` deletes in the load-bearing unlink order (job.json before terminal.lock).
- **1c-i** `listJobs` scans the per-job directory (the per-job file is the single source of
  truth; the `state.json` index is dead-for-reads, still written until 1e).
- **1c-ii-a** live progress (phase/threadId/turnId) moves to append-only `events.ndjson`
  (`engine-event`), so `job.json` is written only by `markJobRunning`/`finalizeJob` —
  **B3 (a progress write clobbering a terminal record) is structurally eliminated**. The
  four interrupt readers (watchdog/cancel/crash-net/timeout) and the status/result display
  fold turn identity from the event log.
- **1c-ii-b** terminal transitions route through the shared `finalizeJob`; the bespoke
  fail-open per-job write mutex (`.wlock`) and codex's own terminal-claim + stale-reclaim
  machinery are **deleted**. `listJobs` treats the `terminal.lock` as authoritative over a
  stale-active `job.json` (lock-as-authority).
- **Shared store hardening** (benefits cc too): `finalizeJob`/`markJobRunning` gain an
  optional `guard` checked atomically on the fresh record after the claim;
  `reconcileDeadPids` reclaims an orphaned `terminal.lock` based on the CLAIM owner's
  liveness + a TTL (not the worker pid), so a separate finalizer (cancel/watchdog) that
  crashed mid-transition — while the worker is still alive — is recovered, and a malformed
  lock self-heals once stale. A live finalizer's fresh claim is never reclaimed.

Validated by a 4-round cross-model Codex review (final: PROCEED).

## 1.0.31

Internal scaffolding (no behaviour change) — Phase 0 of the shared state-store migration
(see `docs/superpowers/plans/2026-06-29-codex-shared-state-store-migration.md`). Adds `codex`
to `scripts/sync-shared.mjs` targets and vendors `shared/lib/` into
`plugins/codex/scripts/lib/shared/`. The vendored runtime is NOT imported yet — it sets up the
later phases that move codex's persistence onto the shared directory-per-job store (the
structural root-fix for the B/C cross-process races). The vendored `.mjs` is outside the
`build:codex` tsconfig (mirroring cc), so it is not typechecked here.

## 1.0.30

Theme E — process / docs honesty (bounded items; the foreign-broker fake-Codex e2e
remains a follow-up, and `resolveSandboxMode` was already documented + tested).

- **Background-durability docs corrected** (`commands/review.md`, `adversarial-review.md`,
  `handoff.md`): these flows run the companion in the FOREGROUND and rely on
  `Bash(run_in_background: true)`, which backgrounds only within the current session. The
  docs implied that was a durable background job. They now state plainly that it is
  session-scoped and best-effort — NOT the detached worker + liveness watchdog that
  `/codex:task --background` provides (that one survives the session). No behaviour change.
- **execute-plan no longer tells Codex to commit to `main`** (`commands/execute-plan.md`):
  the embedded prompt said "commit after each major step", violating the repo's
  branch-from-main / commit-trailer rules. It now instructs: never commit to `main`; if
  committing, branch first and follow `AGENTS.md`/`CLAUDE.md` conventions; otherwise leave
  the work uncommitted for review.

Repo tooling (not plugin-scoped): added `scripts/bump-version.mjs` + `npm run bump-version`
/ `npm run check-version` — a multi-plugin version bump that writes a plugin's version to
BOTH its `plugin.json` and the `marketplace.json` entry in lockstep, plus a `--check` gate
(the lockstep that `tests/fleet-structure.test.mjs` enforces). `test:structure` now also
runs the tool's unit tests. This release's own bump was produced by the tool.

## 1.0.29

Theme D hardening — diagnosability, signal handling, env hygiene, and notification
visibility (four bounded fixes; the larger god-file split / shared-runtime migration
remain roadmap).

- **Foreground SIGTERM/SIGINT finalizer** (`tracked-jobs.mjs`): a foreground run lives
  inside the companion process itself, with no detached watchdog. The crash net only
  caught uncaught throws, so a host kill / Ctrl-C / shell timeout left the per-job record
  stuck "running" with no `.done` (a waiter hangs, `/codex:status` shows a phantom job).
  `installJobCrashNet` now also finalizes on SIGTERM/SIGINT (recorded as
  `terminatedBySignal`, not a misleading "uncaught error"), writing `.done` before exit.
- **No global env mutation** (`worktree-guard.mjs`): `sanitizeGitEnv` defaulted to
  `process.env` and deleted `GIT_*` IN PLACE, silently stripping them from the whole
  companion process. It now returns a sanitized COPY used only for the git probes; the
  deliberate broker-endpoint isolation in expected mode is preserved.
- **Watchdog stderr captured** (`codex-companion.mjs`): the detached liveness watchdog —
  the sole actor that recovers a hung/dead background turn — was spawned `stdio:"ignore"`,
  sending any crash stack to /dev/null. Its stderr now routes into the job log, mirroring
  the worker.
- **Cost/safety notifications surfaced** (`codex.mjs`): six notifications this client does
  NOT opt out of (only the high-frequency token deltas are) were dropped in the dispatch
  `default` arm and thus invisible — `model/rerouted` (a safety signal), `guardianWarning`,
  `thread/tokenUsage/updated`, `turn/plan/updated`, `turn/diff/updated` (logged compactly,
  never the raw diff), and the account-level `account/rateLimits/updated`. Each now emits a
  defensively-built progress line. Shapes grounded in the app-server-protocol v2 types.
- **Queued-job deadline** (`codex-companion.mjs`): `timeoutAt` was only stamped when a job
  promoted queued→running, so a job whose worker died/wedged before starting stayed
  "queued" with no deadline — `missedOwnDeadline` never tripped and a reachable broker kept
  it HEALTHY forever. The queued record now carries a `timeoutAt` (reset fresh on
  promotion, so it only bounds the queued phase).

## 1.0.28

Heal a stranded terminal signal (C5). A background job's terminal side-effects — the
per-job record, the `state.json` index, and the `<jobId>.done` signal a Claude-side
`until [ -f signalFile ]` waiter blocks on — are written separately, not as one
transaction. If a finalizer crashed (or an fs write threw) after the terminal record but
before its `.done`, the waiter hung forever — and the liveness watchdog, observing the job
already terminal, hit its `stop` branch and exited *without* writing the signal (the exact
"watchdog exits without writing `.done`" the audit flagged).

- `state.mjs`: new `ensureTerminalSignal(cwd, jobId, record?)` writes the missing `.done`
  from the authoritative per-job record (the source of truth) when the record is terminal
  and no signal exists. Idempotent — a present signal is a no-op. It is SIGNAL-ONLY by
  design: it never touches the `state.json` index, because an index write routes through
  `saveState → pruneJobs`, which (with a full set of active jobs) would evict this terminal
  job and DELETE its own record + `.done`. A stale index is a separate, rarer, non-hanging
  symptom (`wait` has a deadline) whose safe fix is the state-store migration (roadmap).
- Invoked from the two points a finalizer observes an already-terminal record:
  `applyJobPatchIfActive` (after the per-job write lock releases, when it lost the
  active-state gate) and `runWatchdog`'s `stop` branch (before returning). So a torn
  finalize self-heals on the next watchdog tick or the next late finalizer.

Residuals (documented, accepted): the `exists → write` is not atomic, so a healer can still
overwrite a caller's richer `.done` written in that window; and a healed reason is
record-derived (a non-error completion summary that lives only in the index becomes null).
Both are cosmetic — `/codex:result` reads the per-job record for detail, not `.done` — and a
torn-write recovery with a slightly-less-rich signal beats a hung waiter.

## 1.0.27

Self-heal a wedged terminal claim (C3). `claimTerminalTransition` reclaims a stale
per-job `.lock` only when its owner pid is recoverable AND dead. Two crash shapes
escaped that and deadlocked an active job forever — it could never transition to a
terminal status:

- a claimer that crashed between `openSync('wx')` and `writeSync` left an EMPTY,
  unparseable lock — `isStaleTerminalClaim` read it as "live holder, refuse";
- a claimer's pid that was later RECYCLED by an unrelated live process read as alive,
  so the dead-owner reclaim never fired.

`state.mjs`: `isStaleTerminalClaim` now also reclaims when a claim outlives a 60s TTL
on a still-active job — the claim is held only for the microseconds between the O_EXCL
CAS and the terminal-record write, so any lock older than that on an active job is a
crashed claimer, whatever the pid liveness says. Age is read from the lock's recorded
`stamp`, falling back to the file mtime for an empty/malformed lock. A FRESH empty lock
is still treated as a live holder mid-acquire (not stolen), and a finalized job's lock
still stands (the active gate). TTL, not process start-time identity: pid reuse is slow
enough that the TTL catches a recycled pid cleanly without Linux-only `/proc` code.

## 1.0.26

Reply to server-initiated requests with typed graceful declines (C2). The app-server
can send the CLIENT requests — approvals, `requestUserInput`, MCP elicitation,
ChatGPT auth-token refresh, … — and `handleServerRequest` answered every one with a
blanket `-32601`. Codex does unwind on that (it is not the hang — an UNANSWERED
request is), but with poor semantics: a command approval rendered as "failed" rather
than "declined", and an auth-token refresh surfaced as a generic IO error.

- `app-server.mjs`: `handleServerRequest` now sends the typed decline each method's
  response expects (command/fileChange approval → `{decision:"decline"}`; permissions
  → empty grant; `requestUserInput` → `{answers:{}}`; MCP elicitation →
  `{action:"decline"}`; dynamic tool call → unsupported result), and a clear `-32000`
  "re-login to Codex" error for `account/chatgptAuthTokens/refresh` (which the client
  genuinely cannot perform). Genuinely unknown methods keep `-32601`. Every server
  request is now logged (method + id + outcome) so a turn that stalls/declines on one
  is debuggable in the job log. Shapes grounded in the Codex app-server-protocol v2.
  (Under `danger-full-access` + `approval:never` the approval/permissions variants are
  auto-resolved server-side; `requestUserInput`, elicitation, and auth refresh are the
  ones that realistically reach the client.)

## 1.0.25

Fix cancel ordering + pid source (C1). `/codex:cancel` interrupted the turn and killed
the worker BEFORE the terminal CAS, and signalled `job.pid` from the index snapshot
rather than the authoritative per-job pid. Two hazards: a cancel that LOST the CAS (the
worker finalized itself moments earlier) had already killed a pid that may have been
recycled to an unrelated process; and a stale/absent index pid meant the real worker
(recorded only in the per-job file) was never signalled.

- `codex-companion.mjs` `handleCancel`: claim the terminal transition FIRST, then —
  only when this cancel won the CAS — interrupt the turn and signal the worker, using
  the per-job pid the CAS read (`result.stored.pid`, authoritative over the index
  snapshot). A CAS loser never signals. Mirrors the shared `cancelJob` (CAS-first,
  re-read pid, winner-only signal). This also removes the interrupt-await-before-CAS
  TOCTOU window.

## 1.0.24

Finish wiring the expected-worktree gate (C4). `task`/`review`/`task-worker` asserted
the `--expected-worktree`/`--expected-branch`/`--expected-base` triplet, but the
query/cancel commands only used it to disable the cross-workspace fallback without
ASSERTING — so a host that passed the triplet believed it was guarded while these
commands still operated on the current cwd's workspace in the WRONG worktree (e.g.
cancelling the right job id in the wrong worktree).

- `codex-companion.mjs`: `status`, `wait`, `result`, `cancel`, `attach` now call
  `assertWorktreeAlignment` immediately after parsing the triplet — assert-before-query,
  so a mismatch fails before any job lookup. `logs` previously ignored the triplet
  flags entirely (not even parsed) and its no-id fallback read the current cwd's latest
  job log unguarded; it now parses + asserts the triplet, gating both the fallback and
  the `handleAttach` delegation. The gate stays a no-op when no triplet is passed, so
  ordinary (non-handed-off) invocations are unaffected.

## 1.0.23

Close the last theme-A gap (A5): a turn/start ACK that fails or times out no longer
orphans a turn Codex already started.

- `captureTurn` (`codex.mjs`): the turn id was known only after the ACK resolved, so
  if the ACK rejected (the per-RPC timeout rejects after CODEX_REQUEST_TIMEOUT_MS,
  default 120s) while Codex had already started the turn, there was no id to interrupt
  with and the turn was orphaned on the broker. Now a root-thread `turn/started`
  buffered before the ACK has its thread/turn id captured (and surfaced for the
  per-job record), and on an ACK failure `captureTurn` best-effort interrupts that
  turn over the live connection (bounded to 3s) before propagating the error. This
  completes theme A (A1–A5).

## 1.0.22

Finish the turn-lifecycle hardening (theme A) in `captureTurn` (`codex.mjs`).

- A2 (terminal-notification schema guard): the `turn/completed` handler dereferenced
  `message.params.turn.status` unguarded. After the v1.0.21 shared dispatch wrapped
  every notification in skip-and-log, a reshaped `turn/completed` missing its `turn`
  object no longer crashed — it was SWALLOWED, so the turn never converged and hung
  to the hard cap. A `turn/completed` for the root thread now converges the turn even
  when `turn` is absent (`completeTurn` synthesizes a completed turn from null).
- A3 (final-message fallback for failures): the task result's `finalMessage` came
  only from the live-accumulated `lastAgentMessage`. New `resolveFinalMessage` keeps
  that as the answer source (it is captured from agentMessage notifications
  independent of phase, so a reshaped `final_answer` phase does not lose it) and, when
  it is empty because the turn FAILED before producing a message, falls back to
  `Turn.error.message` so the result surfaces why instead of an empty string. (Note:
  `turn/completed` carries an empty item list in the live app-server —
  `items_view: NotLoaded` — so `turn.items` is not a usable backfill; the agentMessage
  notification is the only answer source.)

## 1.0.21

Harden the turn lifecycle in `captureTurn` (`codex.mjs`) against two failure modes
the v1.0.19 crash-net did not cover. Found by the same Codex deep-audit (theme A).

- A4 (buffered-notification replay): the live notification handler wrapped each
  notification in a skip-and-log guard, but the post-ACK replay of notifications that
  arrived before the turn id was known called the renderer UNGUARDED. One malformed
  buffered notification threw on replay — not a timeout, so no turn interrupt — and
  orphaned the turn. Both paths now go through one shared `dispatchNotification`
  (per-message skip+log). The shared path also fixes a replay-only bug: a buffered
  `thread/started` was routed by `belongsToTurn` (a brand-new subthread is not yet
  tracked) and misdelivered to the previous handler instead of being applied.
- A1 (turn-id ACK): the turn id was read only from `response.turn.id`; if the ACK
  ever lacked it, `state.turnId` stayed null and every notification buffered forever
  — a silent hang to the hard cap. `extractTurnIdFromStartResponse` now reads
  `response.turn?.id ?? response.turnId` (the real field plus a forward-compat
  fallback) and, when no id is recoverable, `captureTurn` fails fast with a protocol
  error instead of buffering indefinitely. Covers `turn/start` and `review/start`.

## 1.0.20

Close three cross-process state races in the background-job store (flat `state.json`
index + per-job files). Found by a Codex deep-audit, cross-checked against source.

- `state.mjs` (B1): `saveState` computed its deletion set from a FRESH disk read of
  the index but its retention set from the caller's (possibly stale) snapshot, so a
  job another process enqueued after the caller loaded got its per-job file (the
  watchdog's source of truth) plus `.log`/`.done`/`.lock` deleted. It now deletes only
  jobs the caller knew about and dropped — explicit removals threaded from
  `updateState`, plus jobs pruned out of the caller's own snapshot. `updateState`
  diffs the job ids before/after the mutation; `session-lifecycle-hook.mjs` (a direct
  `saveState` caller) passes its dropped jobs explicitly.
- `state.mjs` (B3): a non-terminal (progress) patch in `applyJobPatchIfActive` could
  re-persist `{...stored, ...patch}` after another process won the terminal claim and
  wrote the terminal record, restoring a stale `running` status (progress patches
  carry no status) and losing the terminal transition. `applyJobPatchIfActive` now
  runs its read-check-write under a per-job write mutex (`<id>.wlock`, O_EXCL, taken
  by progress AND terminal writers), closing the common-case interleaving. The acquire
  treats an empty/unparseable lock as a live holder mid-acquire (never steals it),
  reclaims a crashed holder's lock at most once via an atomic rename (so a racing
  reclaimer cannot displace a freshly-created lock), and is fail-open (never wedges a
  job). A leaked `.wlock` is cleaned up with the job's other artifacts in `saveState`.
  The earlier `existsSync(.lock)` gate is removed — it was still check-then-write and,
  lacking stale-lock reclamation, would have let a crashed finalizer's orphan lock
  permanently block progress writes and queued promotions. NOTE: a pure-fs file mutex
  cannot be made fully race-free without OS advisory locks; the irreducible residual
  (two concurrent reclaimers of a leaked lock in a one-syscall window) degrades to the
  same fail-open last-writer-wins the design already tolerates. Eliminating it needs
  the directory-per-job state-store migration (roadmap).
- `tracked-jobs.mjs` (B2): `runTrackedJob` promoted queued->running with an
  unconditional write, reviving — and running the runner for — a job cancelled while
  still queued (or already terminal when the worker read it). Promotion is now gated
  through `applyJobPatchIfActive` on the on-disk record still being `queued` (the
  unconditional write is reserved for foreground jobs, which have no pre-written
  status); if not still queued, the worker aborts without running. The promotion also
  passes a merged `indexPatch` so `background`/`request` survive even if the flat
  index lost the job's row, keeping `hasActiveBackgroundJobs` correct.

## 1.0.19

Stop a Codex worker from dying silently. A notification whose shape changed across a
Codex upgrade could make a handler dereference throw inside the transport stream
listener; on Node 26 that uncaught exception killed the worker mid-turn with no
terminal status, surfacing only later as the cryptic "exited without reporting a
terminal status" dead-PID reconcile.

- `app-server.mjs`: wrap the notification dispatch chokepoint (`handleLine`) in
  try/catch — a throwing handler is logged and skipped instead of tearing down the
  connection / killing the turn (the same policy already used for unparseable lines).
  This also covers the broker's own notification router.
- `codex.mjs`: guard `captureTurn`'s notification handler and log the skipped method
  to the job log (visible in both foreground and background).
- `tracked-jobs.mjs`: add `installJobCrashNet` — for the duration of a tracked job,
  an uncaught exception / unhandled rejection CAS-finalizes the job as failed (with
  the real error), writes the `.done` signal, best-effort interrupts the orphaned
  turn on the broker (when thread/turn id is known), then exits non-zero.
  First-terminal-writer-wins: it never resurrects a terminal job or stomps another
  actor's `.done`.
- `codex-companion.mjs`: route a detached background worker's stderr (fd2) into the
  job log so crash stacks survive (was `stdio: "ignore"` → /dev/null).

## 1.0.18

- Raise the background-job hard timeout from 15 minutes to 1 hour, so a long but
  healthy delegated task is no longer cut off early.

## 1.0.17

Docs/test-clarity polish from the 1.0.16 review. **No behavior change.**

- `session-lifecycle-hook.mjs`: documented the one residual window in the
  cleanupSessionJobs pid guard — if a worker is SIGKILLed before writing a
  terminal status, its per-job file stays "running" with a dead pid, so a
  recycled pid could still be signalled (only the common cleanly-finished case is
  closed; `isProcessAlive` can't catch a recycled-but-live pid).
- Renamed the cleanup test from "CASes before terminating" to "checks the per-job
  source-of-truth before terminating" — the safety comes from the terminal-status
  guard, not CAS ordering (terminate runs before the CAS, which only records the
  failure); the assertions were already correct.

## 1.0.16

Fixes from a Codex deep-review pass (it reproduced each with read-only probes).
TDD; suite 305 green, stable across repeated runs.

- **BLOCKER — `sendBrokerShutdown` settled on a partial socket chunk**
  (`lib/broker-lifecycle.mjs`). The data handler called `done()` after ANY chunk,
  so a busy `-32001` reply fragmented across two reads was misread as
  `busy:false`, letting SessionEnd tear down a still-busy shared broker. Now it
  settles only after a COMPLETE newline-terminated JSON line is parsed (bounded
  by the existing timeout/close). Regression test feeds a split busy reply.
- **BLOCKER — `pruneJobs` could evict an ACTIVE job** (`lib/state.mjs`). The
  index was capped at the newest `MAX_JOBS` by `updatedAt`, so a queued/running
  job with a stale `updatedAt` could be dropped — and `saveState` then deletes
  the evicted job's per-job JSON/log/.done/.lock, destroying the watchdog's view
  of a live/hung background job. Active jobs are now never pruned (kept even
  beyond `MAX_JOBS`); only terminal jobs fill the remaining budget.
- **MAJOR — `cleanupSessionJobs` could SIGTERM a reused pid**
  (`session-lifecycle-hook.mjs`). It terminated the (possibly stale) index pid
  before checking job state. Now it consults the per-job file (source of truth):
  it never signals a job already terminal there, and prefers the per-job pid over
  the index pid. Added a `terminateProcessTree` seam + tests for both branches.
- **MAJOR — adversarial-review prompt cap ignored framing size**
  (`codex-companion.mjs`). The cap only truncated `REVIEW_INPUT`; an oversized
  `focusText`/`USER_FOCUS` could still push the rendered prompt past the API
  limit. Added a final whole-prompt byte backstop. Test drives a ~1.2 MB focus.
- **MINOR — idle watchdog armed before the turn/start ACK** (`lib/codex.mjs`).
  The idle timer now arms only after the ACK (the ACK is separately bounded by
  the per-RPC timeout), and `state.completion` gets an early handler so a
  pre-await idle/transport rejection can never surface as an unhandled rejection.

Deliberately NOT changed: `reapStaleBroker` keeps its asymmetric design
(unconditional graceful SIGTERM, identity-verified SIGKILL escalation) — gating
the SIGTERM on the `/proc`-based identity check would break broker reaping on
hosts without `/proc` (macOS/Windows), a worse regression than the very narrow
pid-reuse window it would close.

## 1.0.15

Post-1.0.14 review polish (all findings were MINOR/NIT — the two 1.0.14 BLOCKER
fixes were independently verified correct, one via a revert-to-red mutation
check). TDD throughout.

- **`captureTurn` no longer fabricates a synthetic `state.error` for a
  malformed, non-terminal `error` notification** (`lib/codex.mjs`). A protocol
  error notification missing its `error` object on a turn that then completes
  normally previously left a phantom "unknown error" that could surface on the
  no-output failure path. We now record `state.error` only for a real error
  object; the terminal-failure branch still installs a fallback reason when it
  actually fails the turn. Locked by an extended `permanent-auth-shortcircuit`
  test asserting `state.error` stays unset.
- **Test robustness:** `strings` "no O(n^2)" test now asserts a coarse
  wall-clock ceiling so a correct-but-quadratic `stripAnsi` refactor is caught
  (the prior output-equality assertion alone would not catch a perf regression);
  a new behavioral `terminate-process-tree` test drives the real
  `readProcessTable` parse path with a multi-thousand-row table and asserts
  every descendant is reaped; `sandbox-mode` test now imports `./helpers.mjs`
  for ambient-env isolation per convention.
- **`testing-with-seams` skill:** fixed a self-contradiction (the Common
  Mistakes row recommended `setImmediate`, which the Determinism section
  forbids) and corrected the `enqueueBackgroundTask` seam signature to
  `cwd, job, request, deps`.
- **Docs:** refreshed a stale `resolveSandboxMode` line reference in
  `reliability-backlog.md`.

Suite: 300 tests, deterministic green (verified stable under 4x concurrent runs;
the apparent flake during multi-agent review was CPU contention from ~9 parallel
full-suite runners, not a suite defect).

## 1.0.14

Follow-up review fixes (verified against the current code; TDD, +9 tests):

- **SessionEnd no longer reaps the shared broker out from under an active
  background job (the real gap behind #355).** `handleSessionEnd` sent the
  graceful `broker/shutdown` RPC *unconditionally* before the background-job
  check — and the broker's busy-gate only refuses while another socket owns an
  in-flight request/stream, so a background job that is queued / connecting /
  between its `thread/start` and `turn/start` was not seen as busy and the broker
  would exit, orphaning that job's app-server. The RPC is now gated on
  `hasActiveBackgroundJobs` too (symmetric with the already-gated local teardown).
  `handleSessionEnd` is exported with an injectable deps seam and has an
  integration test.
- **The turn idle watchdog now actually interrupts the wedged turn.** An
  `ETURNIDLE` rejection (from `captureTurn`'s idle timer) previously took the
  plain-failure path: the job was marked failed but the orphan turn kept running
  on the shared broker (closing the socket does not stop it). `runTrackedJob` now
  treats `ETURNIDLE` like the hard-cap timeout — best-effort `turn/interrupt` +
  process-tree terminate — and tags the record `idleTimedOut`. (Still disabled by
  default; only arms when `CODEX_TURN_IDLE_TIMEOUT_MS` is set.)
- **A malformed `error` notification no longer crashes the host process.** The
  `case "error"` handler dereferenced `params.error.message` with no guard; a
  notification missing the `error` field threw a `TypeError` inside the stream
  listener (no try/catch), crashing the process. All dereferences are now guarded.
- **`stripAnsi` is linear again.** The OSC branch used an unbounded lazy
  `[\s\S]*?` that re-walked to end-of-string on every unterminated `ESC]` opener
  (O(n²) — a long opener-dense line stalled the broker line parser for seconds).
  Replaced with a bounded negated-class body + optional terminator.
- **`CODEX_SANDBOX_MODE` is validated.** A typo (e.g. `readonly`) was forwarded
  verbatim to the app-server (opaque `thread/start` failure); it now falls back to
  the default with a warning. The stale `resolveSandboxMode` comment is corrected,
  and the README's now-false "read-only / will not perform any changes" review
  claims are reworded with a new **Sandbox** section documenting the override.
- **`terminateProcessTree`'s `ps` read gets an explicit 16MB maxBuffer** so a very
  large process table can't truncate (ENOBUFS) into an empty descendant sweep.
- **Test hermeticity:** the harness now redirects `HOME`/`USERPROFILE` so
  cross-workspace lookups never read the developer's real `~/.claude`.
- **Docs:** `reliability-backlog.md` #3 (process-group reaping) marked DONE — it
  was implemented in 1.0.9 but still labelled a gap.

## 1.0.13

- **Default the sandbox to `danger-full-access` (hardcoded).** `resolveSandboxMode`
  now returns `danger-full-access` by default instead of preserving the requested
  `read-only`/`workspace-write` mode. This fork runs on hosts that cannot start
  Codex's `bwrap` sandbox (nested sandbox / restricted network namespace — bwrap
  aborts with `loopback: Failed RTM_NEWADDR: Operation not permitted` before any
  command runs), so Codex now always skips bwrap and reads files normally;
  isolation comes from the outer environment. `CODEX_SANDBOX_MODE` still overrides
  the default (e.g. `read-only` on a host where bwrap works). Note: upstream lists
  blanket `danger-full-access` as a do-not-adopt coercion; it is applied here
  deliberately for this fork's environment.

## 1.0.12

Reliability batch 4 (UX / observability) + the SessionEnd background-job decision:

- **Background jobs survive their session (decision on #355).** A `--background`
  job — especially a subagent-dispatched `--background` rescue — is designed to
  outlive the dispatching turn, but SessionEnd unconditionally terminated every
  session job (the subagent's turn end ≈ SessionEnd), killing the just-detached
  worker. Background jobs are now marked `background: true` and skipped by
  `cleanupSessionJobs` (kept running and retained in the index so the parent
  session's later `/codex:status` still finds them). The shared broker is also
  kept alive at SessionEnd while any background job is still active
  (`shouldTeardownBroker` + `hasActiveBackgroundJobs`), composing with the
  existing busy-gate. Background jobs remain bounded by the liveness watchdog and
  the 15-minute hard cap.
- **`/codex:attach` — live log tail.** New thin command that streams a job's log
  as it is produced and exits when the job reaches a terminal status. Resolves a
  job by id (local, then across workspaces) or the newest active job. The tail
  loop (`streamJobLog`) is seam-injectable and bounded by `maxPolls`.
- **Cross-workspace job lookup.** A job id obtained in one workspace no longer
  dead-ends as "Job not found" when queried from another: `findJobByIdAcrossWorkspaces`
  (+ `collectCandidateStateRoots`) is used as a read-only fallback for an explicit
  id not found locally. The default (no id) selection stays workspace/session-scoped.
- **Dispatch sentinel.** Background launches print a machine-readable
  `[[codex-task status=dispatched id=<id>]]` line so a consumer scanning stdout
  can detect the dispatch and capture the job id without parsing prose.
- **app-server type alignment (clean `npm run build`).** Aligned the JSON-RPC
  params with the current Codex app-server schema: declare the now-required
  `requestAttestation: false` capability (serde-default on the wire, so no
  behavior change) and drop the removed `experimentalRawEvents` thread-start field
  (Codex ignored it). `tsc` now passes with zero errors.

## 1.0.11

Reliability batch 3 (output & failure visibility):

- **Cap the adversarial-review prompt under the Codex input limit.** The prompt
  inlined the collected review content verbatim, so a large self-collected diff
  could blow past Codex's ~1 MB input hard limit and fail outright. The final
  rendered prompt is now capped (`MAX_REVIEW_PROMPT_BYTES`), truncating only the
  review input on a UTF-8 boundary (`truncateToByteBudget`, never splitting a
  multi-byte sequence) with a truncation notice — a huge diff degrades to a
  truncated-but-valid prompt instead of a hard failure.
- **Surface companion failures on stdout.** `main()` failures wrote only to
  stderr; the `codex:codex-rescue` subagent captures stdout only, so a failure
  was invisible to it (looked like an empty/successful result). Failures now also
  emit a structured `{"status":"error","error":"...","exitCode":1}` envelope on
  stdout (stderr keeps the human-readable message), and the rescue subagent
  surfaces it instead of swallowing it.
- **Short-circuit non-retryable turn errors.** An `error` notification only
  recorded the error and waited for `turn/completed` — which never arrives for a
  terminal failure (e.g. a permanent auth error), hanging the turn until the hard
  cap. The turn is now completed as failed when the error is non-retryable, using
  the protocol's authoritative `willRetry === false` signal (with a narrow
  permanent-auth regex fallback when `willRetry` is absent). Transient/server
  errors (429, 5xx, rate-limit, overloaded) are never short-circuited.

## 1.0.10

Reliability batch 2 (process / connection lifecycle):

- **Reap the codex app-server subtree on close (no orphaned MCP children).** The
  app-server spawns its own MCP/tool subprocesses; on POSIX `close()` used to send
  a bare `SIGTERM` to the direct child only, orphaning that subtree. `close()` now
  reaps the whole tree via `terminateProcessTree` on every platform.
- **`terminateProcessTree` reaches non-group-leader subtrees (POSIX).** It now
  enumerates descendant pids (best-effort, via `ps`; degrades to a plain kill if
  `ps` is unavailable) and signals them, and a `kill(-pid)` `ESRCH` (which also
  happens for a *live* process that is not a group leader, e.g. the codex
  app-server inside the broker's group) now falls back to a direct `kill(pid)` —
  only concluding the process is gone when that also `ESRCH`s. This also means a
  wedged tracked-job worker is now actually terminated on hard timeout (previously
  a silent no-op for a non-leader worker). The codex app-server is deliberately
  NOT spawned detached: keeping it in the broker's process group means the
  watchdog's `terminateProcessTree(brokerPid)` still reaps the whole subtree, with
  the descendant sweep covering both the close-from-codex and reap-from-broker
  paths — avoiding the orphan-on-reap regression that detaching would introduce.
- **Don't reuse a dead broker.** `ensureBrokerSession` now gates reuse on the
  recorded broker pid being alive (`isSessionStale`), not just the endpoint
  answering — a crashed broker can leave a lingering unix socket that still pings.

Deferred: stale broker after switching accounts (backlog #303). Replacing a
per-workspace *shared* broker on an account mismatch conflicts with the
shared-broker safety rules (busy-gated; never torn down unconditionally), and —
verified against the Codex source — reading `account/read` *through* the broker
cannot even detect an external switch (the long-lived app-server returns its own
stale cached account). A correct fix must probe fresh on-disk auth and replace
only an idle broker; tracked as a dedicated follow-up.

## 1.0.9

Reliability batch 1 (most-defensive, smallest, pure-backend fixes):

- **Robust stdout JSONL parsing.** `AppServerClientBase.handleLine` — the single
  chokepoint that parses raw Codex app-server stdout for both the direct client
  and the broker's in-process client — now strips ANSI/terminal escapes and skips
  any non-JSON line (launcher banners, stray logs) instead of tearing down the
  whole connection (and killing the running turn) on the first unparseable line.
  Only a line that *looks* like JSON yet fails to parse is still a fatal protocol
  error. New `lib/strings.mjs#stripAnsi` (ECMA-48 OSC + CSI incl. bracketed-paste)
  is a no-op on clean JSONL and never corrupts a JSON-encoded escape.
- **Hook stdin tolerates pipe jitter.** The SessionStart/End and stop-gate hooks
  shared a single-shot `fs.readFileSync(0)` with no error handling; an `EAGAIN`
  on a non-blocking pipe crashed the hook and dropped the `session_id`. Both now
  use `lib/hook-input.mjs#readHookInput`: a chunked read loop with a bounded
  EAGAIN/EWOULDBLOCK retry (budget resets on progress) that returns `{}` on empty
  input, jitter, or malformed JSON instead of throwing.
- **captureTurn idle watchdog.** Added an opt-in per-turn idle timer
  (`CODEX_TURN_IDLE_TIMEOUT_MS`, **disabled by default**) that resets on every
  inbound notification and, after a stretch of total silence, rejects with an
  error carrying the thread/turn id so a caller can interrupt + reap a wedged
  turn whose socket stayed open. Disabled by default because all delta
  notifications are opted out, so a healthy turn can legitimately be silent for
  minutes inside a single long item; background jobs keep the 15-minute hard cap.

## 1.0.8

- Fix two shared-broker correctness bugs found by a Codex review of 1.0.5–1.0.6:
  - SessionEnd no longer tears down the broker when it refuses shutdown as busy
    (`sendBrokerShutdown` now reports busy), so ending one session can't abort
    another client's in-flight Codex turn.
  - The liveness watchdog only reaps the broker for a genuine HUNG turn with
    thread/turn identity, an attempted-but-unconfirmed interrupt, and an
    unreachable broker — never for a DEAD job, a busy broker, or one still
    reachable.
- Harden the terminal-job CAS: the stored===null recreate fallbacks (runner
  success/failure and cancel) now go through the same O_EXCL claim, and a claim
  left behind by a crashed owner (dead pid + still-active job) is reclaimable so
  a job can't wedge un-finalizable.
- `reapStaleBroker` verifies process identity before escalating to SIGKILL, so a
  recycled pid (an unrelated process reusing the old broker's pid) is never
  killed.
- Document a known Windows limitation: an npm-installed `codex.cmd` shim can't be
  spawned with shell:false; a cmd.exe-wrapper fix is deferred until it can be
  validated on Windows.

## 1.0.7

- Add a `CODEX_SANDBOX_MODE` escape hatch. Codex normally runs commands in its
  own `bwrap` sandbox, which needs to create a network namespace; on hosts that
  forbid that (nested sandboxes / some containers, where `unshare --net` returns
  EPERM) even a `read-only` turn aborts with `bwrap: loopback: Failed
  RTM_NEWADDR` and Codex can't read the repo. Setting
  `CODEX_SANDBOX_MODE=danger-full-access` makes the plugin pass that sandbox mode
  to Codex so it skips bwrap; isolation is then provided by the outer
  environment. The per-command default (read-only / workspace-write) is
  unchanged when the variable is unset.

## 1.0.6

- `/codex:handoff` now **sends the composed GPT-5.5 prompt to Codex by default**
  and returns Codex's response (reflect → compose → run → bring back). Use
  `--print` (or `--prompt-only`) to only emit the prompt to paste yourself;
  `--background` runs it as a background job and `--write` lets a task edit code.
  Mode A (session review) stays read-only.

## 1.0.5

- Add the `/codex:handoff` command (build a paste-able GPT-5.5 prompt from the
  current session or a given task; never runs Codex itself).
- Default Codex delegation to `gpt-5.5` at `xhigh` reasoning effort; replace the
  internal `gpt-5-4-prompting` guidance with `gpt-5-5-prompting`.
- Reliability and correctness hardening (cross-referenced against the upstream
  Codex CLI): cross-process terminal-job CAS via an O_EXCL lock, atomic state
  writes, a time-bounded broker shutdown with guaranteed SessionEnd teardown,
  watchdog escalation that reaps a hung turn's broker, a busy-gated
  `broker/shutdown`, SIGKILL escalation for stale brokers, no-shell process
  spawns (Windows argument-injection fix), and several smaller fixes. Remove the
  fabricated `spark` model alias (`--model` is now forwarded verbatim).

## 1.0.0

- Initial version of the Codex plugin for Claude Code
