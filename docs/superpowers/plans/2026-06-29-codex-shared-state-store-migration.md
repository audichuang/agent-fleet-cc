# Codex → Shared directory-per-job State-Store Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Calibration note (read first):** This is the highest-blast-radius change in the repo — it
> replaces the persistence layer underneath every job operation that themes A–E hardened.
> It is intentionally PHASED. Phase 0 and Phase 1 are specified to executable detail. Phases
> 2–4 are specified at the deliverable + test-strategy level, because their exact task code
> depends on what Phase 1 actually lands (the facade shape, the on-disk paths, which tests
> survive). Each phase gets its own detailed task plan once the previous phase is merged
> green. Do NOT attempt Phases 2–4 from this document alone.

**Goal:** Replace codex's bespoke job persistence (`state.mjs`: a flat `state.json` index +
per-job files guarded by `.lock`/`.wlock` file-lock CAS) with the shared
directory-per-job store (`shared/lib/core/state-store.mjs`: O_EXCL `terminal.lock` + atomic
rename + load-bearing unlink order), so the B/C cross-process races become structurally
impossible rather than mitigated, and `state.mjs` shrinks toward a thin facade.

**Architecture:** Codex adopts the shared **STATE STORE only** — NOT the shared
`runtime/worker.mjs` or the spawn-per-job `ProcessAdapter`. Rationale: the shared worker
model is "spawn one engine CLI per job, parse its stdout line-by-line, it exits"
(`claude -p`, `agy`). Codex's engine is a **persistent shared `codex app-server` broker**
reached over JSON-RPC with turn capture/interrupt/steer, shared across jobs and turns
(`lib/codex.mjs` 1506L, `lib/app-server.mjs` 495L, `lib/broker-lifecycle.mjs` 349L). That
does not fit `buildInvocation → spawn → parseEvent(stdout)`; forcing it would abandon the
broker architecture (a major regression). So the broker engine layer stays codex-specific;
only persistence (state, cancel, reconcile, wait, prune) moves to the shared store.

**Tech Stack:** Node ≥22.3, zero-dependency pure ESM `.mjs`, `node:test` + `node:assert/strict`,
hermetic tests (fake binaries, redirected `CLAUDE_PLUGIN_DATA`, no network). Shared source of
truth is `shared/lib/`; migrated plugins vendor it into `scripts/lib/shared/` via
`npm run sync-shared` (CI drift-checks both copies).

## Validation gate outcome (2026-06-29, Codex)

**Verdict: PROCEED-WITH-CHANGES.** The central scope decision (state-store-only; broker engine
stays; do NOT adopt `runtime/worker.mjs`) is **VALIDATED** against the source. Phase 0 is
confirmed safe. Phase 1 must NOT be implemented as originally written. Must-fix edits, now
reflected in this plan:

1. **Gap 2 / B3 (WRONG → fixed):** the `readJob→active-gate→writeJob` progress facade reopens
   B3. See the corrected Gap 2 section — it is now a Phase-1 blocker with Options A/B + an
   adversarial test as the first deliverable.
2. **Factual: `claimTerminalTransition` is NOT exported by shared `state-store.mjs`** (it is
   private, `state-store.mjs:83`). Codex calls its own `claimTerminalTransition` directly for
   missing-file recreate fallbacks (`codex-companion.mjs:1197`, `tracked-jobs.mjs:492`). FIX:
   the facade routes those recreate fallbacks through the public `finalizeJob` (which performs
   the O_EXCL claim internally) rather than a raw claim; do not assume a shared
   `claimTerminalTransition` export. (Also: `adapter-api.mjs` lives at `shared/lib/adapter-api.mjs`,
   not under `runtime/`; and the deferred broker-shaped target is `SessionAdapter`, per
   `shared/lib/adapter-api.md` — not `worker.mjs`.)
3. **`resolveStateFile` existence-gate (RISKY → fixed):** `session-lifecycle-hook.mjs:18,55`
   imports `resolveStateFile` and uses it as an "is there any state?" gate. It cannot just be
   deleted. FIX: replace that gate with "does the `jobs/` dir exist / `listJobs` non-empty"
   before removing `resolveStateFile`.
4. **Config migration (RISKY → fixed):** splitting config to `config.json` would silently reset
   `stopReviewGate` on existing installs (old value lived in `state.json`). FIX: `getConfig`
   one-time-migrates — if `config.json` is absent but an old `state.json` exists, seed
   `config.json` from its `config` block.
5. **`listJobs` ordering (RISKY → fixed):** shared `listJobs` sorts by `createdAt`; codex
   status/resume expects newest-by-`updatedAt`. FIX: the facade `listJobs` re-sorts by
   `updatedAt` desc (codex's existing `sortJobsNewestFirst` semantics) on top of shared
   `listJobs`, so consumers see unchanged ordering.
6. **Phase 1 is too large (RISKY → fixed):** split Phase 1 into 1A (the Gap-2 primitive +
   adversarial test), 1B (path/layout + CRUD facade + cross-workspace `jobs/<id>.json` →
   `jobs/<id>/job.json` at `state.mjs:764`), 1C (terminal CAS facade via `finalizeJob` +
   recreate-fallback rework), 1D (`.done`/signal split), 1E (config split + migration +
   session-cleanup gate), 1F (reconcile/active + full green). Each 1x is its own green PR.

Devil's-advocate (gate): the B/C races are already MITIGATED by A–E and CI-green; this upgrades
"mitigated → structural" + shrinks the god-file — valuable, not urgent. It may stop cleanly
after any green phase. Do not spend the blast radius unless each phase buys real safety.

## Global Constraints

- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (per AGENTS.md; note the personal global rule + settings.json strip attribution — follow whatever the repo's actual commits do).
- Branch from `main`; never commit features straight to `main`.
- IRONCLAD scope: touch only `plugins/codex/**`, `tests/codex/**`, and (for shared changes) `shared/lib/**` + the vendored `plugins/codex/scripts/lib/shared/**` + `scripts/sync-shared.mjs` + `package.json` + `tests/shared/**`. Do NOT modify `plugins/{cc,antigravity}/**` or their tests.
- After editing `shared/lib/`, run `npm run sync-shared` and commit BOTH the source and the vendored copy (CI drift-checks them).
- Every code change is TDD: failing test first, watch it fail, minimal code, watch it pass.
- CI gate is MORE than `npm test`: it also runs `npm run build:codex` (tsc checkJs) + the sync-shared drift check. Run all three locally before pushing.
- Per-plugin version bump on any shipped change: `npm run bump-version codex <patch|minor>` (writes plugin.json + marketplace.json in lockstep) + a CHANGELOG entry.
- `tests/codex/runtime.test.mjs` is occasionally flaky — an intermittent failure there is not a regression; re-run once.

---

## Background: the three semantic gaps the migration must reconcile

The shared store is NOT a drop-in for codex's state.mjs. Three behavioural differences drive
the phase design; each has a chosen resolution below.

### Gap 1 — the `.done` completion signal
Codex writes a per-job `.done` file (`writeCompletionSignalFile`) that a Claude-side
`until [ -f signalFile ]; do sleep; done` bash loop blocks on for background jobs; C5 added
`ensureTerminalSignal` to heal a torn `.done`. The shared store has **no `.done`** — it
records terminal state in `job.json` + a `finalized` event in `events.ndjson`, and
`waitForJob` polls `job.json.status`.
**Resolution:** keep `.done` as a codex-specific artifact written on finalize, living inside
the per-job directory (`jobs/<id>/done.json`). `writeCompletionSignalFile` and
`ensureTerminalSignal` stay codex-only, layered on top of the shared store (they read the
shared `job.json` as the source of truth). The host-loop contract is preserved unchanged.

### Gap 2 — progress updates (the B3 race source) — **PHASE 1 BLOCKER (gate-corrected)**
Codex writes live progress (threadId/turnId/phase) into `job.json` via
`applyJobPatchIfActive` under a per-job `.wlock` mutex, with a terminal O_EXCL claim for
terminal patches. B3 was: a cross-process progress write (worker) clobbering a terminal
status (watchdog/cancel). The shared model puts progress in append-only `events.ndjson` (no
clobber possible) and writes `job.json` only at `markJobRunning` / `finalizeJob`.

**The gate caught a WRONG resolution:** the original plan kept progress in `job.json` behind a
facade `readJob → active-gate → writeJob`. That REOPENS B3 — shared `writeJob` is
UNCONDITIONAL (`state-store.mjs:45`) with no cross-process mutex; `finalizeJob` only guards the
terminal writers. A check-then-write active-gate has exactly the read-check-write window the
`.wlock` was added to close. This must NOT ship.

**Corrected resolution — must be settled in Phase 1, before the facade work, via its own
focused design pass + adversarial test (the FIRST Phase-1 sub-step). Two viable options:**

- **Option A — progress → `events.ndjson` (structurally eliminates B3).** Progress no longer
  touches `job.json`. `job.json` writers reduce to: `markJobRunning` (with a one-shot
  turn-identity stamp), and `finalizeJob`. No two-writer race on `job.json` → B3 impossible.
  COST: the readers that today pull threadId/turnId/phase off `job.json` (the crash-net and
  watchdog interrupt, `lib/render.mjs`, status/result) must read turn identity from the
  markRunning snapshot + events. This pulls reader changes into Phase 1.
- **Option B — add a shared `patchJobIfActive(stateDir, jobId, patch)` primitive** that ports
  codex's proven safe active-patch into `shared/lib/core/state-store.mjs` as a reusable
  primitive with the SAME cross-process guarantee (it must make "progress cannot overwrite a
  terminal `job.json`" hold without the check-then-write window — e.g. by gating on the
  terminal lock the way `finalizeJob` does). COST: adds a progress-write primitive to the
  shared store (which today deliberately routes progress through events); must be adversarially
  tested and ideally adopted by cc too, and is a `shared/lib/` change (sync-shared + commit both).

**Recommendation:** Option B if the design pass can prove the no-clobber invariant without a
new lock file (reuse the terminal-lock signal); otherwise Option A. EITHER WAY this is the
first Phase-1 deliverable, gated by an adversarial cross-process test that reproduces B3 and
proves the new primitive/model closes it. Do not start the rest of Phase 1 until this is green.

### Gap 3 — config + index-shaped state
Codex's `state.json` holds BOTH the job index AND config (`stopReviewGate`).
`updateState`/`saveState`/`loadState`/`getConfig`/`setConfig` operate on that one file. The
shared store is jobs-only (directory listing IS the index; no `state.json`).
**Resolution:** split — config moves to a separate codex file `config.json` in the state dir
(`getConfig`/`setConfig` facade read/write it). The job "index" is gone; `listJobs` scans
`jobs/`. `saveState`'s prune+delete becomes shared `pruneJobs`. `updateState`/`saveState`
are decomposed (config writes → config.json; job mutations → per-job `writeJob`/`finalizeJob`)
and ultimately deleted once no consumer calls them.

---

## File Structure

| File | Responsibility after migration |
|------|-------------------------------|
| `plugins/codex/scripts/lib/shared/**` (vendored) | The shared core, copied from `shared/lib/` by sync-shared. Read-only here. |
| `plugins/codex/scripts/lib/state.mjs` | **Thin facade** over the vendored shared store: preserves codex's existing export surface (path helpers, readJobFile/writeJobFile/listJobs, applyJobPatchIfActive, claimTerminalTransition, reconcileDeadPidJobs, hasActiveBackgroundJobs, generateJobId) by delegating to shared `state-store.mjs`/`job.mjs`/`reconcile.mjs`. Shrinks from 864L by deleting the bespoke flat-index + `.wlock`/`.lock` machinery. |
| `plugins/codex/scripts/lib/codex-signal.mjs` (new) | Codex-only completion-signal layer: `writeCompletionSignalFile`, `ensureTerminalSignal`, `resolveJobDoneFile` (the `.done` artifact + heal). Extracted out of state.mjs so the facade is pure persistence. |
| `plugins/codex/scripts/lib/codex-config.mjs` (new) | Codex-only `getConfig`/`setConfig` over `config.json` (the `stopReviewGate` etc.), split out of the old index-shaped state. |
| `plugins/codex/scripts/codex-companion.mjs` | Unchanged in Phase 1 (imports the same names from state.mjs facade). Phase 4 repoints it directly at shared APIs and sheds state-glue. |
| `plugins/codex/scripts/lib/tracked-jobs.mjs`, `codex-watchdog.mjs`, `session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs`, `job-control.mjs`, `broker-lifecycle.mjs` | Unchanged in Phase 1 (facade preserves their imports). Phases 2/4 repoint them where the facade is pass-through. |
| Codex-only engine layer (stays as-is, NOT shared): `lib/codex.mjs`, `lib/app-server.mjs`, `lib/broker-lifecycle.mjs`, `lib/worktree-guard.mjs`, `lib/git.mjs`, `lib/render.mjs` | Broker/app-server, worktree gate, git/diff, output formatting. |

---

## Phasing overview

| Phase | Deliverable | Risk | Test gate |
|-------|-------------|------|-----------|
| **0** | Vendor `shared/lib/` into `plugins/codex/scripts/lib/shared/` (sync-shared targets codex). No behaviour change. | Low | `npm test` + drift check green; nothing imports the vendored code yet. |
| **1** | `state.mjs` becomes a facade over the shared store; `.done`/config split into `codex-signal.mjs`/`codex-config.mjs`. On-disk layout becomes directory-per-job. All existing consumers unchanged; the 23 state tests updated to the new layout/semantics. | **Highest** | full `npm test` + `build:codex` + e2e + conformance-subset green. |
| **2** | Repoint the 7 importers off the facade onto shared APIs where the facade was pass-through; delete dead facade shims. | Medium | green per-importer. |
| **3** (optional) | Move progress to `events.ndjson`; repoint status/result readers; B3 becomes structurally impossible. | Medium | green. |
| **4** | God-file shrink: state-glue in `codex-companion.mjs` that is now thin moves out; companion approaches cc's ~455L orchestration size. | Medium | green. |

Phases 2–4 are listed for direction only and are NOT detailed below.

---

## Phase 0: Vendor the shared runtime into codex (no behaviour change)

**Files:**
- Modify: `scripts/sync-shared.mjs` (TARGETS array)
- Create (generated): `plugins/codex/scripts/lib/shared/**` (vendored copy + `VENDORED.md`)
- Modify: `package.json` (no new script needed; `test:codex` glob already covers any new tests)

**Interfaces:**
- Produces: the vendored shared tree at `plugins/codex/scripts/lib/shared/` importable as
  `./lib/shared/core/state-store.mjs` etc. Nothing imports it yet.

- [ ] **Step 1: Add codex to the sync-shared targets**

Modify `scripts/sync-shared.mjs` — change the TARGETS array from `["cc"]` to `["cc", "codex"]`:

```javascript
// Plan C/D 把 antigravity、codex 加進來
const TARGETS = ["cc", "codex"].map((p) =>
  path.join(root, "plugins", p, "scripts", "lib", "shared"),
);
```

- [ ] **Step 2: Run sync-shared to vendor the tree**

Run: `npm run sync-shared`
Expected: creates `plugins/codex/scripts/lib/shared/` mirroring `shared/lib/` plus a `VENDORED.md` banner.

- [ ] **Step 3: Verify the drift check passes (source == vendored)**

Run: `npm run sync-shared && git status --porcelain plugins/codex/scripts/lib/shared | head`
Expected: the vendored files appear as new/untracked, identical to source; a second `sync-shared` produces no further diff.

- [ ] **Step 4: Run the full suite — nothing should change behaviourally**

Run: `npm test` then `npm run build:codex`
Expected: all green (the vendored code is present but unused; tsc must still pass — confirm the vendored `.mjs` typechecks under the codex tsconfig or is excluded like cc's).

- [ ] **Step 5: Bump + changelog + commit**

```bash
npm run bump-version codex patch   # 1.0.30 -> 1.0.31
# add CHANGELOG entry: "Vendor the shared runtime into codex (Phase 0; unused, sets up the state-store migration)."
git add -A
git commit -m "chore(codex): vendor shared/lib (Phase 0 of state-store migration)"
```

**Phase 0 gate:** green CI, vendored tree committed, zero behaviour change. STOP and get the
next phase's detailed plan before continuing.

---

## Phase 1: state.mjs becomes a facade over the shared store

> Phase 1 is itself large. It is broken into ordered sub-steps, each independently testable.
> Implement strictly in order; do not start a sub-step until the previous is green. The exact
> code for each sub-step is written when that sub-step is reached (it depends on the shared
> API shapes confirmed in Phase 0's vendored tree) — this plan fixes the CONTRACT each
> sub-step must meet, which is what the Codex gate validates.

**Files:**
- Modify: `plugins/codex/scripts/lib/state.mjs` (rewrite internals; preserve exports)
- Create: `plugins/codex/scripts/lib/codex-signal.mjs`, `plugins/codex/scripts/lib/codex-config.mjs`
- Modify (imports only): consumers that imported `writeCompletionSignalFile`/`ensureTerminalSignal`/`resolveJobDoneFile`/`getConfig`/`setConfig` from state.mjs now import them from the new modules (or state.mjs re-exports them to avoid touching consumers in Phase 1 — preferred).
- Test: every file under `tests/codex/` that touches state internals (state.test.mjs, apply-job-patch.test.mjs, tracked-jobs-race.test.mjs, completion-signal.test.mjs, terminal-signal-heal.test.mjs, reconcile-signal.test.mjs, session-cleanup-cas-order.test.mjs, prune-keeps-active.test.mjs, codex-watchdog.test.mjs, session-lifecycle.test.mjs, enqueue-background.test.mjs, e2e-cli.test.mjs, …).

**Contract each sub-step must meet (the spec the Codex gate checks):**

- [ ] **1a — On-disk layout.** Path helpers move to the shared layout: `resolveJobsDir` → `jobs/`, `resolveJobFile` → `jobs/<id>/job.json` (delegating to shared `jobFilePath`), `resolveJobLogFile` → `jobs/<id>/log`, `resolveJobDoneFile` → `jobs/<id>/done.json`. `resolveStateFile` (the old flat index) is removed; `getConfig`/`setConfig` use `config.json`. Tests that hardcode `<id>.json`/`<id>.done`/`state.json` paths are updated to the helpers (and the helpers' outputs).

- [ ] **1b — Job CRUD facade.** `writeJobFile(cwd,id,record)` → shared `writeJob(stateDir, {...record, id})`; `readJobFile(file)` keeps reading a job.json path (delegate to shared `readJob` by id where possible); `listJobs(cwd)` → shared `listJobs(stateDir)` then `reconcileDeadPidJobs` (or shared `reconcileDeadPids`); `generateJobId` → shared `newJobId`; `upsertJob` → `writeJob` (create-or-overwrite by id). Behaviour preserved: a job written then read round-trips; listJobs returns newest-first.

- [ ] **1c — Terminal CAS facade.** `claimTerminalTransition(cwd,id,status,stamp)` → shared `claimTerminalTransition(stateDir,id,status)` (O_EXCL `terminal.lock`). `applyJobPatchIfActive(...)`: terminal patch → shared `finalizeJob`; non-terminal (progress) patch → readJob + active-gate + `writeJob` (Gap 2 resolution, Phase-1 variant). The B-suite race tests (apply-job-patch, tracked-jobs-race, session-cleanup-cas-order) must still pass against the new store — these are the regression proof that the directory-per-job CAS preserves first-terminal-writer-wins and no progress-clobbers-terminal.

- [ ] **1d — Completion signal (codex-signal.mjs).** Move `writeCompletionSignalFile` + `ensureTerminalSignal` here, writing `jobs/<id>/done.json`, reading the shared `job.json` as source of truth. C5 behaviour preserved (heal a missing `.done` from a terminal record; never clobber a richer one; signal-only, never touches the index). completion-signal/terminal-signal-heal tests updated to the new path, same assertions.

- [ ] **1e — Config (codex-config.mjs).** `getConfig`/`setConfig` over `config.json`. `loadState`/`updateState`/`saveState` are reduced to job-only helpers or deleted if no consumer needs them; the `removedJobs` prune path → shared `pruneJobs`. session-lifecycle + prune-keeps-active tests updated.

- [ ] **1f — Reconcile + active-jobs.** `reconcileDeadPidJobs` → shared `reconcileDeadPids` (or a thin codex wrapper that also writes the codex `.done`); `hasActiveBackgroundJobs` → `listJobs(...).some(active && background)`. cross-workspace helpers (`findJobByIdAcrossWorkspaces`, `collectCandidateStateRoots`) re-point to scanning `jobs/` under each candidate state dir.

- [ ] **1g — Full green.** `npm test` + `npm run build:codex` + e2e all green. Add a state-store conformance-style test for codex's facade (the SUBSET of the shared conformance that applies to a non-worker adopter: terminal CAS, cancel race, prune-vs-finalize, reconcile dead pid) — NOT the full ProcessAdapter conformance (codex has no spawn-per-job adapter).

- [ ] **1h — Bump + changelog + commit + CI green.**

**Phase 1 gate:** the entire existing behaviour is preserved (every consumer + e2e green) on the
new directory-per-job store; `state.mjs` is materially smaller; the file-lock `.lock`/`.wlock`
machinery is deleted. Get Phase 2's detailed plan before continuing.

---

## Risks & mitigations

- **Highest blast radius in the repo.** Mitigation: facade strategy isolates the rewrite to
  state.mjs internals; consumers + most behavioural tests unchanged in Phase 1; phased with a
  green gate per phase; the B/C-suite tests are the regression proof.
- **The races are already MITIGATED (A–E), not open bugs.** This migration upgrades
  "mitigated" → "structurally impossible" + shrinks the god-file. It is valuable, not urgent —
  so it can stop cleanly after any green phase.
- **`.done`/progress/config semantic drift** (Gaps 1–3) is where behaviour could silently
  change. Mitigation: each gap has an explicit resolution above; the existing
  completion-signal / terminal-signal-heal / B-race / session-lifecycle tests are the
  guardrails — they must pass unchanged in intent.
- **tsc/`build:codex` on vendored `.mjs`.** Confirm in Phase 0 whether the vendored shared
  tree is in or out of the codex tsconfig (mirror cc).
- **Conformance mismatch.** The shared conformance suite tests the WORKER/adapter; codex is a
  state-store-only adopter. Do NOT claim full conformance — write a scoped state-store
  regression test instead.

## Self-review notes
- Scope decision (state-store-only, broker stays) is grounded in the three scope reports and
  is the single most important thing for the Codex gate to validate or refute.
- Phases 2–4 are deliberately deliverable-level (no fabricated step code) because they depend
  on Phase 1's landed shape; this is a conscious deviation from "every step has code", flagged
  per the calibration note.
