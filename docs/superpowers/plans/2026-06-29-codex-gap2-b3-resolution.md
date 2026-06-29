# Decision: codex Gap-2 / B3 — Phase-1A state-store resolution

> **Validation:** Opus 4-angle / 4-lens adversarial panel → synthesized → **Codex (GPT-5.5) cross-model gate = PROCEED-WITH-CHANGES** (2026-06-29). The gate confirmed both core claims (lock-free Option B is impossible — its own best refutation, a generation/content-CAS + rename-claim scheme, failed; Option A is the right direction) and found **one hole the same-family panel missed** plus 3 more must-fixes, all folded in below and marked **[gate]**.

## 1. Recommendation

**Adopt Option A — move progress writes off `job.json` into `events.ndjson` (riding the existing `engine-event` type), in the SAME atomic change that routes the in-band terminal patch through shared `finalizeJob`.** This is *not* defer and *not* Option B.

Resolving the plan's conditional — *"Option B IF the no-clobber invariant is provable WITHOUT a new lock file, else Option A"* — **a lock-free Option B is NOT possible, so the conditional collapses to Option A.** One-line why: the shared store's only cross-process serializer is the one-shot `O_EXCL terminal.lock` (`claimTerminalTransition` `state-store.mjs:83-96`, `flag:"wx"` `:89`), which a progress writer cannot test-and-hold without *becoming* the terminal winner — so every lock-free `patchJobIfActive` reduces to `readJob → active-gate → writeJob` with `writeJob` unconditional and lockless (`state-store.mjs:45-50`), reopening the exact check-then-write window the codex `.wlock` exists to close.

I do not hedge this: Option A is the only resolution that makes B3 *structurally impossible* rather than *mitigated*, it is the only one that lets the fail-open `.wlock`+`.lock` be deleted (the migration's headline), and it costs **zero `shared/lib` change** provided progress rides `engine-event` (verified below). The cost is real — it pulls plan Phase 3 forward into 1A and forces 3–4 correctness readers to repoint to an events overlay *now*, and codex must START emitting `engine-event`s for the first time — but that is the only stop-after-green boundary that actually banks the migration's prize.

---

## 2. No-clobber analysis (per option)

**The invariant (NC), stated once:** once `job.json.status ∈ TERMINAL_STATUSES {completed,failed,cancelled}`, no later write may set it back to an active status (`queued`/`running`). B3 = NC violated across two processes: P_prog (worker progress, `tracked-jobs.mjs:169` `applyJobPatchIfActive({phase|threadId|turnId})`) interleaving with P_term (watchdog `codex-watchdog.mjs:139`, cancel `codex-companion.mjs:1189`, timeout, or dead-pid reconcile).

### Option A — progress → `events.ndjson` (RECOMMENDED)
**Exact invariant needed:** progress never opens `job.json`; the only `job.json` writers become `markJobRunning` (one-shot `queued→running`, `state-store.mjs:148-156`) and `finalizeJob` (terminal, `:119-143`).

**Proof it holds across processes:** B3 (the *progress*-clobbers-terminal race) requires a progress writer and a terminal writer to both mutate `job.json`. Under A, progress goes to `appendEvent(jobDir, "engine-event", …)` (`events.mjs:19-27`) — a **different file** (`events.ndjson`, `events.mjs:16`) than `job.json`. So the progress-vs-terminal pair no longer exists on `job.json` → **B3 (progress clobber) is structurally impossible**, strictly stronger than the `.wlock`, which only *serializes* two real `job.json` writers and is admittedly fail-open (`state.mjs:387-391`). Terminal-vs-terminal is closed by the single O_EXCL `terminal.lock`: `finalizeJob` reads `existing`, rejects if already terminal (`state-store.mjs:125-126`), claims (`:127`), re-reads `fresh` to detect a post-prune delete (`:132-138`), writes `{...fresh, ...patch}` (`:141`); a racing finalizer gets `EEXIST`/`false` (`:93`).

**[gate] BUT the proof is INCOMPLETE — `markJobRunning` is a SECOND active-status `job.json` writer the panel missed.** Under A the surviving `job.json` writers are `markJobRunning` (queued→running) **and** `finalizeJob` — and these two *can* race. `markJobRunning` pre-checks the lock + active status (`state-store.mjs:149-151`), writes `{...job, status:"running"}` (`:152`), then re-checks the lock (`:154`) and returns `null` — but it **never undoes the `:152` write**. Interleave: `markJobRunning` reads queued → a concurrent `finalizeJob` (cancel/watchdog) claims + writes terminal (`:127,:141`) → `markJobRunning` writes stale `running` over it (`:152`) → returns `null`. The on-disk record is now a stale `running` while `terminal.lock` says `cancelled`. This is **not** the B3 the `.wlock` closed (progress); it is a **pre-existing shared-store property** that cc already ships with — and the shared suite *documents it explicitly*: `tests/shared/worker.test.mjs:289-294` ("job.json will still have status='running' (stale, written by markJobRunning)"). The shared store's actual contract is therefore **"the `terminal.lock` (+`finalizeJob`) is authoritative; a transient stale-active `job.json.status` is tolerated and must be interpreted through the lock"** (worker.test.mjs's own fix: trust `job.json.status` only if terminal, else fall back). **Consequence for Phase 1A:** the honest invariant is *"B3-progress is structurally gone; the markRunning-vs-finalize stale window is resolved by lock-as-authority, not by elimination."* Phase 1A MUST make codex's status/list readers terminal-lock-aware (consult `readTerminalLock`/`finalizeJob` result, not raw `job.json.status`) — codex today reads `job.status` directly (e.g. `reconcileDeadPidJobs`, status/render) — AND add a deterministic `markJobRunning`-vs-`finalizeJob` test. Without this, a cancelled-during-promotion job can surface as `running`.

### Option B — shared `patchJobIfActive(stateDir, id, patch)` — the strongest case, then why every variant fails
**Exact invariant needed:** the read-active-gate-write sequence is atomic w.r.t. a concurrent `finalizeJob`, *without* a new lock file. Four lock-free constructions, each refuted:

1. **`terminal.lock` as a gate** — `if (readTerminalLock(...)) return; writeJob`. **Fails — precise interleave:** P_prog `readTerminalLock`→null (`state-store.mjs:100`) → P_term `finalizeJob` claims (`:127`) + `writeJob {status:"failed"}` (`:141`) → P_prog `writeJob {...,status:"running"}` (`:45`, unconditional, no lock) clobbers the terminal record. Window = between P_prog's `readFileSync` of the lock (`:103`) and its `renameSync` inside `writeJsonAtomic` (`:33`). **B3 reproduced.**
2. **Post-write recheck-and-self-heal** — P_prog `writeJob`s progress, re-reads the lock, and if now claimed re-applies the terminal patch. **Fails worse — it corrupts the record:** P_term's `finalizeJob` did a *fresh-merge* of fields written after its claim (`{...fresh, ...patch}`, `state-store.mjs:139-141`) — e.g. a worker's post-claim `pid` stamp that `cancelJob` relies on. P_prog cannot reconstruct `fresh`; its heal-write produces a structurally-wrong terminal record. Self-heal turns a clobber into a *corrupt* terminal.
3. **Content-CAS on `job.json` bytes** — write only if the file still equals the bytes P_prog read. **Fails:** there is no atomic conditional-write syscall on a file; emulating it (read-compare-`renameSync`) is the `.wlock` window again — P_term can finalize between P_prog's compare and its rename. POSIX `rename` is atomic but not conditional.
4. **Take-and-hold a mutex** — the only exclusive primitive is a *new* O_EXCL file. The one already present, `terminal.lock`, is one-shot `wx` (`state-store.mjs:89`): a progress writer that creates it *is* claiming the terminal transition (and would `EEXIST`-block every real finalizer forever). So variant 4 means adding a **separate** progress mutex into `shared/lib` — literally re-introducing the codex `.wlock` (`state.mjs:392`) the migration exists to delete (premise: a pure-fs file mutex cannot be made race-free, self-documented `state.mjs:387-391`), which `cc` would then inherit.

**Conclusion for B:** every lock-free variant either reopens the `state-store.mjs:45` unconditional-`writeJob` window or corrupts the terminal record; the only "locked" variant defeats the migration premise. **No lock-free Option B exists.**

### Defer / keep codex `.wlock`
**Exact invariant needed:** progress and terminal both serialize under the per-job `<id>.wlock`.

**How it holds today (verified):** both writers enter `applyJobPatchIfActive` (`state.mjs:486`), whose entire body runs inside `withJobWriteLock` (`:492`), so P_prog cannot execute its `writeJobFile` between P_term's `claimTerminalTransition` (`:522`) and `writeJobFile` (`:527`). This is codex 1.0.20, CI-green.

**The composition trap (load-bearing — variant (i) vs (ii)):** Phase-1A terminal CAS can be done two non-equivalent ways:
- **(i) Route terminal through shared `finalizeJob` while progress stays on codex `.wlock` — REOPENS B3.** `finalizeJob` takes `terminal.lock` (`state-store.mjs:127`) but **no `.wlock`**; progress holds `<id>.wlock` which `finalizeJob` never takes. The two writers serialize on **different files** = not at all. Interleave: P_term `finalizeJob` claims `terminal.lock` + writes terminal (`:127,:141`); concurrently P_prog (holding only `.wlock`) reads the job as active and `writeJob`s `{phase:"investigating"}`; if P_prog's write lands after P_term's, the terminal status is clobbered. **This is the precise shape the plan's own Phase-1C sketch (`plan:249`) describes — and it is broken.** The Option-A cutover MUST therefore be atomic: progress moves to `events.ndjson` in the *same* change that routes terminal to `finalizeJob` — never half-and-half.
- **(ii) Keep BOTH writers under codex `.wlock` for 1A** — NC holds as today, but Phase 1A then **ships the fail-open `.wlock` unchanged** (`state.mjs:432-433` proceeds without the lock after the 1000ms budget; `:419-426` one-syscall reclaim gap remains). This is "race-unchanged, not race-closed." It is honest but it preserves the exact thing the migration exists to delete, so it is not the recommendation.

---

## 3. Phase-1A blast radius (Option A)

**Shared/lib change required? NO — provided progress rides the existing `engine-event` type.** `EVENT_TYPES` is a CLOSED set already containing `engine-event` (`events.mjs:6-12`); `appendEvent` THROWS on an unknown type (`:20`). Progress (`{phase,threadId,turnId}`) must be carried as `engine-event` data. **A new `"progress"` type is FORBIDDEN** — it would force `events.mjs:6` edited + `npm run sync-shared` + committing BOTH `shared/lib/core/events.mjs` and the vendored `plugins/codex/scripts/lib/shared/core/events.mjs` (CI drift-checks them) + a `cc`-adoptability question. Riding `engine-event` keeps Phase-1A inside **`plugins/codex/**` + `tests/codex/**` only**, zero shared tax.

**NEW EMIT PATH (not "repoint" — codex emits nothing to `events.ndjson` today):** `appendEvent` is called nowhere in any live codex script; `events.ndjson` is never created for codex jobs. The vendored shared worker (`worker.mjs:218`) emits `engine-event`s but codex does not run it. So Option A's first task is to START emitting progress as `engine-event`s, then populate readers off it. Scope this as new emit-path work, not mere reader repointing.

**WRITERS that change (all `plugins/codex/`):**
- `tracked-jobs.mjs:132-171` `createJobProgressUpdater` — replace the `applyJobPatchIfActive(workspaceRoot,jobId,patch)` call (`:169`) with `appendEvent(jobDir(stateDir,jobId), "engine-event", {phase,threadId,turnId})`. Keep the changed-only dedup closure (`:133-158`) verbatim — it now means "append an event only when identity changed," which is the append-only semantics the spine wants.
- Terminal in-band writers route through shared `finalizeJob` per plan must-fix #2 (atomic with the progress move): `tracked-jobs.mjs:139`(watchdog)/`:260`(crash-net)/`:379`(promotion stays `markJobRunning`)/`:459`/`:584`; `codex-companion.mjs:1189`(cancel).
- **Standalone recreate-fallback claims (currently OUTSIDE any `.wlock`)** must route through PUBLIC `finalizeJob` (shared `claimTerminalTransition` is private, `state-store.mjs:83`): verified census = `tracked-jobs.mjs:496`+`:498`, `tracked-jobs.mjs:603`+`:605`, `tracked-jobs.mjs:269`+`:271` (crash-net guarded recreate), `codex-companion.mjs:1201`+`:1203`. The in-band `applyJobPatchIfActive` sites are `tracked-jobs.mjs:169,260,379,459,584` and `codex-companion.mjs:1189`. **This grep-verified census is a hard prerequisite** — any direct claim/`writeJobFile` outside both `.wlock` and `finalizeJob` is an independent B3 vector.
- Layout (must-fix): `resolveJobFile` (`state.mjs:694-696`, flat `${jobId}.json`) → `jobFilePath` `jobs/<id>/job.json` (`state-store.mjs:15-16`); `resolveJobFileInStateDir` (`:703-705`); **cross-workspace flat path `:764`** (`path.join(workspaceStateDir,'jobs',`${jobId}.json`)`) → directory layout.
- Config (must-fix): `getConfig`/`setConfig` (`state.mjs:659,668`) → `config.json` with a one-time seed from old state so `stopReviewGate` (default `:50`) is not reset.
- `listJobs` sort (must-fix): shared `listJobs` sorts by `createdAt` desc (`state-store.mjs:72-74`); codex `sortJobsNewestFirst` sorts by `updatedAt` desc (`job-control.mjs:13`, called `:270,299,339,365`). The facade must re-sort or callers regress.

**READERS that change — FOUR correctness readers (not 3), via one shared helper:**

**[gate] All four must fold events *in order*, keeping the latest non-null `threadId` AND `turnId` INDEPENDENTLY** — because the progress updater dedups the two ids separately (`tracked-jobs.mjs:148-157`), so a given `engine-event` may carry only one of them. "Last `engine-event` with a `turnId`" is WRONG (it can have a null `threadId`). Factor this into one helper, e.g. `readCurrentTurnIdentity(stateDir, jobId) → {threadId, turnId}`: fold valid `engine-event`s in order (`readEvents`), keep latest non-null of each, ignore torn/junk lines (`events.mjs:37-44`), and **do NOT bound on a `finalized` event** (externally-finalized jobs have none — see residual #3).

- **`codex-watchdog.mjs:118-119` → interrupt `:156-157` (load-bearing, separate process):** reads `job.threadId/job.turnId`, uses BOTH (gated AND) to interrupt the hung turn. Repoint to `readCurrentTurnIdentity`. A one-shot `markJobRunning` stamp is insufficient because `turnId` advances per turn.
- **`codex-companion.mjs:1169-1171` → interrupt `:1220` (`/codex:cancel`, separate process) [gate — MISSED in the panel doc]:** cancel reads `existing.threadId/turnId` from `readStoredJob` (job.json) then `interruptAppServerTurn({threadId,turnId})`. Under A, if cancel is not repointed it will finalize the job but **fail to interrupt the live app-server turn** (leaking a running turn on the shared broker). Repoint to `readCurrentTurnIdentity`, with a test.
- `tracked-jobs.mjs:238-240` (crash-net `readStoredJob` turn capture) and `:559-560` (timeout interrupt, gated AND at `:561`) — same helper.
- **Cosmetic readers — cheap.** `render.mjs:119,141-142,157-158` (`job.phase`, `job.threadId`) and `job-control.mjs:233` `enrichJob` (`enriched.phase ?? inferLegacyJobPhase`). `enrichJob` already has an events-derived `inferLegacyJobPhase(job, progressPreview)` fallback (`job-control.mjs:149,233`), so these are display-only, low risk.

**No `shared/lib` change → no `sync-shared`, no both-copies commit, no cc-adoptability cost.**

---

## 4. Phase-plan impact

Option A **pulls plan Phase 3 ("Move progress to events.ndjson", `plan:171`) forward into Phase 1A and collapses it** — the Phase-3 work *is* the Gap-2 resolution. This is MORE 1A scope than a pass-through facade: codex must start emitting `engine-event`s (new emit path), and the 3 correctness readers (watchdog `:118-119`, crash-net `:238-240`, timeout `:559-560`) must repoint to an events overlay NOW, not later. I state this plainly rather than implying 1A stays minimal. Mitigant: the cosmetic phase readers are cheap because `enrichJob` already has the `inferLegacyJobPhase` events fallback (`job-control.mjs:149,233`); only the 3 correctness readers carry real cost.

**Tradeoff vs "valuable not urgent, stop after any green phase":** Option A is the *only* choice whose green gate banks the migration's headline — after 1A, B3 is structurally gone and the fail-open `.wlock`+`.lock` (`state.mjs:360-449`) are genuinely deletable. Defer/variant-(ii) leaves a worse-or-equal resting state than today (ships the fail-open mutex forward); Option B pays `shared/lib` blast radius for a still-not-lock-free primitive. So A front-loads reader work but is the only stop-after-green boundary that is honest rather than rhetorical. It does NOT pull layout/CRUD/config/reconcile forward — those are independent 1A must-fixes already in scope.

---

## 5. Adversarial test design

**Primary gate (deterministic, in-process) + corroborating cross-process smoke.** The existing B-suite is 100% single-process/synchronous (`apply-job-patch.test.mjs` already asserts in-process "progress write does not resurrect a finalized job"; `tracked-jobs-race.test.mjs`, `session-cleanup-cas-order.test.mjs`). The repo's proven cross-process-CAS pattern is the **deterministic `_hooks.afterClaim` seam** on `finalizeJob` (`state-store.mjs:116-119,128-129`), used by `tests/shared/adversarial-races.test.mjs` with NO `child_process`. A probabilistic fork/spawn race is flakier (cf. the documented `tests/shared/worker.test.mjs` flake) and a weaker gate, so it must NOT be the sole gate.

**Where it lives:** `tests/codex/progress-no-resurrect.test.mjs` (exercises the codex facade + readers, not a raw shared primitive). It complements the in-process B-suite by adding the *correctness-under-the-new-model* dimension they lack — explicitly NOT duplicating the already-covered in-process resurrection case.

**Fails-first artifact (checked-in, runnable — not prose):** land a deliberately-naive facade `applyProgressNaive = readJob → active-gate → writeJob` — i.e. **variant (i): terminal via shared `finalizeJob`, progress via lock-free shared `writeJob` with no mutex** — and pin the test to it. This is the exact B3-reopening shape; the test must be demonstrated RED against it.

**[gate] Deterministic interleave — NO hook needed, and `afterClaim` is WRONG for this.** The panel's "run the progress write inside `finalizeJob`'s `afterClaim`" is broken: `afterClaim` fires *before* `finalizeJob` re-reads and writes the terminal record (`state-store.mjs:128-129` hook, then `:132` re-read, `:141` write). A naive progress write executed there lands *before* the terminal write and is overwritten by it → the test passes even against the broken facade (false green). The stale progress write must land **after** `finalizeJob` finishes. In one process that is just sequencing — no hook:
```js
const stored = readJob(stateDir, id);            // P_prog reads ACTIVE
assert.equal(stored.status, "running");
finalizeJob(stateDir, id, { status: "failed" }); // P_term fully finalizes
applyProgressNaive(stateDir, id, { phase: "x" });// P_prog's stale write lands AFTER
```
Against the naive facade this clobbers `failed`→`running` (RED); against Option A `applyProgress` appends an `engine-event` and never opens `job.json` (GREEN). Zero flake, no `child_process`. (`_hooks.afterClaim` is a synchronous in-process callback — it CANNOT orchestrate a cross-process fork; reserve it only for the *markRunning-vs-finalize* test below, where the interleave is *inside* a single store call.)

**[gate] Second deterministic test — `markJobRunning` vs `finalizeJob` (Blocker 1).** Drive `markJobRunning(stateDir, id, {}, { beforeRecheck })` and, inside `beforeRecheck` (fires after `markJobRunning`'s `:152` running-write, before its `:154` lock recheck), run a full `finalizeJob(...,{status:"cancelled"})`. This reproduces the stale-`running`-over-terminal window. The assertion is NOT "job.json.status is terminal" (it won't be — that's the documented shared-store behavior, worker.test.mjs:289-294); it is **"a terminal-lock-aware reader resolves the job as terminal"** — i.e. `readTerminalLock(stateDir,id).status === "cancelled"` and codex's status reader reports `cancelled`, proving the lock-as-authority contract holds.

**Exact assertions:**
```js
const job = readJob(stateDir, id);
assert.ok(TERMINAL_STATUSES.has(job.status),
  "a terminal record must never be resurrected to active (B3)");
assert.equal(job.status, "failed");          // winner preserved
// Reader-contract guard (else the test passes VACUOUSLY under Option A) — recover BOTH ids:
const { threadId, turnId } = readCurrentTurnIdentity(stateDir, id);
assert.ok(turnId && threadId,
  "current threadId AND turnId still recoverable from events.ndjson");
```
- Against `applyProgressNaive` (variant (i)): P_prog's `writeJob` overwrites → status `running` → **status assertion FAILS** (B3 reproduced).
- Against Option A: progress emits an `engine-event`, never touches `job.json` → status assertion PASSES regardless of interleave, **and** the second assertion proves the watchdog reader (`codex-watchdog.mjs:118-119,156-157`) can still recover the current turn — without it the status assertion would pass vacuously and prove nothing about A's actual risk.

**Do NOT** assert on `updatedAt` ordering: `writeJob` stamps `updatedAt` at millisecond ISO resolution (`state-store.mjs:48`), so same-ms writes tie and the assertion is unreliable. The single sound assertion all candidates share is the terminal-status guard above.

**Secondary smoke (optional, not the gate):** a `child_process` two-process barrier run with a shared `CLAUDE_PLUGIN_DATA` (e2e-cli.test.mjs style) as corroboration only — `_hooks.afterClaim` is a synchronous in-process callback and CANNOT orchestrate a cross-process interleave, so it is not used for timing there.

---

## 6. Required Phase-1A sub-tasks from the gate (do these or it is unsafe)

- **R1.** Make codex's status/list readers **terminal-lock-aware** so a stale `running` left by `markJobRunning` after a terminal claim is reported as terminal (lock-as-authority); add the deterministic `markJobRunning`-vs-`finalizeJob` test (§5). *(Blocker 1)*
- **R2.** Build the fails-first test as the **no-hook sequenced** in-process test against the naive variant-(i) facade; reserve `beforeRecheck` only for the markRunning test. *(Blocker 2)*
- **R3.** Repoint **`/codex:cancel`** (`codex-companion.mjs:1169-1171→:1220`) to the events overlay, with a test. *(Blocker 3)*
- **R4.** Implement one `readCurrentTurnIdentity` helper that recovers **both** ids independently (§3), used by all four correctness readers. *(Blocker 4)*
- **R5 (should-fix).** Update the now-known-broken Phase-1C sketch in the plan (`docs/superpowers/plans/2026-06-29-codex-shared-state-store-migration.md:249`, "non-terminal patch → readJob + active-gate + writeJob") before implementing — it is the exact reopened-B3 shape.

## Residual risks / open questions

1. **[gate — RESOLVED] turn-emit census.** Codex confirmed turn identity surfaces through `codex.mjs` progress on the root `turn/started` (`plugins/codex/scripts/lib/codex.mjs:555-571`) and that `app-server.mjs` is only the JSON-RPC dispatcher (no direct turn-identity write to the record). So every `turnId`/`threadId` flows through the progress updater and CAN become an `engine-event` under Option A. Still: re-grep before deleting the `job.json` `turnId` field, in case a future path writes it directly.
2. **PIPE_BUF atomicity is qualified, not absolute.** `appendFileSync` of a sub-`PIPE_BUF` line is atomic (`events.mjs:26`), but `engine-event` lines can carry a `raw` engine-output line that exceeds PIPE_BUF (4096 on Linux); a torn line is possible under concurrent appenders. The *progress* fields (`{phase,threadId,turnId}`) are small and safe; `readEvents` already tolerates junk lines (`events.mjs:42-44`), so a torn `raw`-bearing event degrades to a dropped event, not corruption. The reader must survive torn lines — assert this.
3. **Missing `finalized` sentinel for externally-finalized jobs.** A watchdog/cancel/dead-pid kill calls `finalizeJob` from another process, which writes NO `finalized` event (that line is emitted by the shared worker only, which codex does not run today). So an events-overlay reader bounding on "stop at finalized" is unsound for externally-finalized jobs — the reader contract must tolerate a missing `finalized` event and cross-check `job.json` terminal status. Also: a trailing `engine-event` appended after a `finalized` line must not resurrect a stale turn identity into the watchdog.
4. **`readEvents` has no tail-only fast path** (`events.mjs:29-47`): it reads+parses the whole file each call. The watchdog now scans `events.ndjson` per poll instead of one `job.json` field. Cheap for codex's short logs / MAX_JOBS≈50, but unbenchmarked for pathological turn churn — flag for 1A perf review.
5. **codex emits nothing to `events.ndjson` today.** `appendEvent` is called nowhere in any live codex script; the file is never created for codex jobs. Option A requires codex to START emitting `engine-event`s and to populate `events.ndjson` before any reader can fold it — this is new emit-path scope, not mere "repoint readers." (Accounted for in §3 WRITERS; flagged here for honesty.)
6. **Out-of-tree consumers unchecked:** whether any slash-command template under `plugins/codex/commands/**` instructs reading `job.json.turnId` directly — grep covered `plugins/codex/scripts/` only. Check before deleting the field.
