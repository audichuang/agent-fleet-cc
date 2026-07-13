# Fleet liveness observability (shared runWorker adopters) — design

- Date: 2026-07-14
- Status: ready-for-agent (no issue tracker configured; repo convention is file-based specs)
- Revision: r3 — folds in TWO independent Codex reviews (2026-07-14). r2 fixed the r1 NOT-READY
  findings: B1 single cadence (one projection per wait return; no internal throttle); projection
  split into a pure fold + thin collector with a locked schema; files metric honestly named
  "working-tree changes"; terminal-lock as an authoritative input; explicit commander exit-code
  state machine; per-plugin delivery. r3 fixes the READY-WITH-FIXES defects Codex found in the
  r2 locked schema: `lastActivity` guards `typeof text === "string"` (grok end/error carry no
  text); added `elapsedOrigin` field + corrected the queued-time note; `alive` is nullable
  (queued/no-pid ≠ dead); exit 1 also covers a missing job; router validation corpus/reps/
  threshold locked to concrete numbers.
- Related: ADR-0002 (to be authored as a prerequisite; partial reversal of the antigravity
  shared-runtime migration's §7 behavior-change #4 + Q1), ADR-0001 (delegating-to-fleet
  routing index), `docs/superpowers/specs/2026-07-01-antigravity-shared-runtime-migration-design.md`.

## Problem Statement

When a user delegates work to a fleet engine and the job runs in the background, they have no
way to tell whether it is still alive and making progress. A grok (or antigravity) job launched
detached is a black box: the user waits — sometimes twenty minutes — with no signal that the
engine is still running, what it is currently doing, or which files have changed in the working
tree. The only feedback arrives when the job finishes and the whole result lands at once.

The fleet is inconsistent about this. codex already has rich progress observability (a liveness
classifier, a watchdog, and a phase/turn progress layer surfaced in status/result). antigravity
deliberately removed its progress observability (health/heartbeat fields and `lastProgressAt`)
under the shared-runtime migration's §7 behavior-change #4 (watchdog uncertainty recorded under
its Q1), betting dead-process reconciliation alone was enough. grok never had progress
observability at all. So the two engines that run the shared runWorker runtime as their primary
job driver — grok and antigravity — share the identical gap: they can tell you a worker
*crashed* (via dead-pid reconciliation), but not whether a *live* worker is progressing,
stalled, or what it is doing. (cc also runs the shared runWorker but is out of scope here — see
Out of Scope.)

Separately, grok exposes every one of its verbs (task, status, logs, result, cancel, wait,
setup) as model-invocable, unlike codex and antigravity which only let the delegation-entry
verbs auto-fire. And the `delegating-to-fleet` router skill triggers unreliably, competing for
the same phrasing as the per-engine verb entry points.

## Solution

From the user's perspective:

- When they delegate a long task to grok, the commander (Claude Code) launches it in the
  background and then reports, at a cadence the user controls, a compact "still alive" line:
  how long it has run, whether the worker is alive, what it last did, and how many files have
  changed in the working tree — instead of blocking silently and dumping everything at the end.
- `/grok:status` (and the antigravity equivalent) show the same liveness summary for any
  running job, so a single status check answers "is it still alive and what is it doing?".
- The user can dial the check cadence ("this one runs long, check every 10 minutes") and the
  commander honours it: the cadence is simply the `wait` timeout the commander passes, and one
  compact liveness line is reported each time `wait` returns.
- The same observability appears for antigravity jobs, not just grok — the fold is made once in
  the shared runtime and both engines adopt it.
- grok stops auto-firing lifecycle/query verbs the model should not trigger on its own; only the
  delegation entry verb (task) remains model-invocable, matching the rest of the fleet.
- The `delegating-to-fleet` router fires reliably on the decision to delegate.
- When the job finishes, the user still gets the full result exactly once — the heartbeat never
  replaces the actual answer.

## User Stories

1. As a developer delegating a long build to grok, I want the commander to launch it in the
   background rather than block, so that I am not staring at a frozen session.
2. As a developer, I want a "still alive" line each time a wait interval elapses with the job
   still running, so that I know the engine has not silently died (a terminal return gives me the
   full result instead).
3. As a developer, I want each liveness line to show elapsed run time, so that I can judge
   whether the job is taking abnormally long.
4. As a developer, I want each liveness line to show whether the worker process is actually
   alive (not just "not yet finished"), so that a hung or crashed worker is distinguishable from
   a slow one.
5. As a developer, I want each liveness line to show the engine's last activity (its most recent
   narrated line), so that I can see what it is currently doing.
6. As a developer, I want to see how many files have changed in the job's working tree, so that
   I can see the engine is actually editing code — labelled honestly as working-tree changes,
   not as a provenance claim.
7. As a developer, I want the liveness line to be compact (a line, not the full raw stream), so
   that watching a job does not flood the session or burn tokens.
8. As a developer, I want to control how often the commander checks in (e.g. every 10 minutes
   for a long job) by setting the wait interval, so that the cadence matches the work.
9. As a developer, I want the commander to default to a sensible interval when I don't specify
   one, so that I don't have to micromanage every delegation.
10. As a developer, I want `/grok:status` alone to show the liveness summary for running jobs,
    so that I can check in without launching a wait loop.
11. As a developer, I want the full result to arrive exactly once when the job completes, so
    that the heartbeat never replaces or duplicates the actual answer.
12. As a developer running an antigravity job, I want the same liveness summary in antigravity's
    status and wait surfaces, so that observability is consistent across the two adopters.
13. As a developer, I want the "still alive" signal to keep working even when the engine goes
    quiet for a while (thinking without narrating, or grok structured-output mode that emits no
    stream), so that silence is reported as "alive but quiet", not misread as dead and not left
    blank.
14. As a developer whose job runs outside a git repository, I want the liveness summary to
    degrade gracefully (omit the working-tree-change count) rather than error, so that
    observability never breaks the job.
15. As a fleet maintainer, I want the liveness computation to live in one shared place, so that
    grok and antigravity cannot drift apart on how they report progress.
16. As a fleet maintainer, I want grok's lifecycle/query verbs to be user-run only, so that the
    model cannot auto-fire cancel/logs/status/wait/result/setup.
17. As a developer, I want grok's task verb to remain model-invocable, so that the commander can
    still delegate to grok on its own.
18. As a developer, I want the commander's background-and-poll loop to keep driving the
    wait/status verbs even though they are user-run, so that gating them does not break the
    watch loop (the loop invokes the companion via shell, which the gate does not block).
19. As a developer, I want the commander to branch correctly on the wait exit code (timeout vs
    completed vs failed vs cancelled), so that a job that finalizes between polls is relayed
    correctly and a timeout is never misread as failure.
20. As a developer, I want the router to fire reliably when a task should be delegated, so that
    the commander reaches for the fleet instead of doing everything itself.
21. As a fleet maintainer, I want the router's triggering validated with a defined sample and
    pass threshold, so that we know the description change actually improved hit-rate.
22. As a fleet maintainer, I want the decision to re-introduce progress observability recorded in
    an ADR, so that a future reader understands why the fleet reversed course and how far.
23. As a fleet maintainer, I want codex and cc left functionally unmodified, so that codex's
    richer progress layer and watchdog are undisturbed (they only receive the unused vendored
    module via sync-shared).
24. As a developer, I do NOT want the engine auto-killed when it looks hung, so that a
    slow-but-working turn is never terminated out from under me.

## Implementation Decisions

### Architecture

- **Root-cause, shared fold.** The progress-observability gap is shared by the two engines that
  use the shared runWorker runtime as their primary job driver (grok and antigravity). The core
  computation is a new PURE function in the shared runtime core — not a per-plugin copy — so both
  engines compute liveness identically.
- **Passive observability only; no watchdog.** We re-introduce the *reporting* side (a liveness
  projection surfaced in status/wait). We do NOT re-introduce the *active* side that the
  migration removed (a health classifier that auto-kills hung jobs). grok and antigravity remain
  without a watchdog; codex keeps its own.
- **codex and cc receive no functional wiring.** codex uses the shared state-store only and has
  its own app-server progress layer and watchdog; cc runs the shared runWorker but is out of
  scope for surface wiring. The new shared module will be vendored into their copies by
  `sync-shared` (unused there) — a vendored file, not a behavior change. The change must not
  redden codex's typecheck.
- **Delivery is split per plugin** to respect the repo's plugin-isolation working rules, even
  though the user authorized the fleet-wide scope explicitly. Natural delivery units: (a) shared
  core + required vendoring, (b) grok wiring + verb gate, (c) antigravity wiring, (d)
  fleet-router trigger. See Testing/tickets.

### The liveness projection — a pure fold plus a thin collector

Two layers, so the logic is a genuinely pure, hermetically-testable fold and the I/O is isolated:

- **Pure fold (new shared function).** Takes ONLY already-observed values — no stateDir/jobId,
  no runners — and returns the projection. Inputs: the job record, the ordered event list, an
  observed terminal-lock status (or null), a `workerAlive` boolean, a `workingTreeChanges` count
  (or null), and a `nowMs`. It performs no I/O. This mirrors codex's `classifyLiveness` (pure
  decision function fed observations).
- **Thin collector (per caller, impure).** Reads the job record + events, reads the terminal
  lock, probes pid liveness (reuse `isPidAlive` from reconcile), and runs git — then calls the
  pure fold. Kept small; not the unit under test for the fold logic.

**Locked projection schema (field names / units / nullability):**

- `status` — the AUTHORITATIVE status. Resolved before/within the collector using the same
  precedence the worker/reconcile use: a terminal `terminal.lock` status wins over a `job.json`
  that still says running (closes the finalize-window race where a job is completing but
  `job.json` is stale). Never reports active when a terminal claim already exists.
- `alive` — nullable boolean, from `isPidAlive(job.pid)`. `null` when the job has no valid
  worker pid yet (a legitimately `queued` job created in the background before the worker stamps
  its pid — do NOT report `false`, which reads as "dead"); a boolean once a worker pid exists.
  Meaningful only while `status` is active.
- `elapsedMs` — integer ms, origin = the `spawned` event timestamp; fallback to `createdAt` only
  if no `spawned` event exists. Invalid/unparseable timestamps → `null`, never NaN.
- `elapsedOrigin` — `"spawned"` or `"createdAt"`, saying which timestamp `elapsedMs` was measured
  from. When it is `"createdAt"` the value INCLUDES queued time (there was no `spawned` event to
  measure run time from) and the render layer flags it as approximate. This replaces the r2 prose
  "approximate marker" that had no field; note the r2 parenthetical was backwards — the
  `createdAt` fallback necessarily counts queued time.
- `quietMs` — integer ms since the last event's timestamp (`nowMs − lastEventTs`); `null` if no
  events. Large `quietMs` with `alive:true` is the "alive but quiet" state — never treated as
  failure.
- `lastActivity` — `{ text, ts }` from the most recent engine-event whose
  `typeof text === "string" && text.trim() !== ""`, scanning backward. The `typeof` guard is
  mandatory: grok `end`/`error` events carry NO `.text`, so a bare `text.trim()` would throw on
  them; the guard skips them (and antigravity's blank paragraph-break lines) and finds the prior
  meaningful line. `text` is trimmed and truncated to a fixed snippet limit of 80 chars (exact
  constant, not "about"). When no such event exists yet, `lastActivity` is `null` and the RENDER
  layer shows an explicit GENERIC fallback ("no output yet"). The shared formatter cannot
  distinguish "grok structured-output/JSON-schema mode, which emits no stream until the buffered
  object closes right before finalization" from "merely quiet", so the wording is deliberately
  generic — NOT blank and NOT "dead". `text` is also whitespace-collapsed (inner newlines removed)
  so one activity chunk can never become several physical heartbeat lines.
- `workingTreeChanges` — integer count of changed entries in the job's working tree, or `null`
  outside a git repo / on git failure. **This is a working-tree delta, not provenance:** it
  reflects the current `git status --porcelain` of the cwd, so it can be non-zero from
  pre-existing dirt and can under-count a new directory of files as one entry. It is labelled as
  "working-tree changes" everywhere it surfaces; it is NOT claimed to be "files this job wrote".

**Engine-agnostic on `text`.** grok's adapter emits engine-events of kind text/end/error;
antigravity's emits one `line`-kind event per output line. grok text-kind and antigravity
line-kind events carry `.text`; grok `end`/`error` events do NOT — so the backward scan must
guard `typeof text === "string"` (see `lastActivity`) and skip the text-less kinds. The fold must
not assume grok-specific event kinds.

### grok wiring

- grok's `wait` reports **one compact liveness line on a non-terminal (timeout) return**; a
  **terminal** return relays the full result instead (a liveness line on a finished job is noise —
  the result render already carries the terminal status). There is NO internal sub-interval
  heartbeat: the check cadence IS the caller's `--timeout-s`. This removes the r1 two-cadence
  conflict and the "cannot heartbeat while quiet" problem (a single blocking shell call surfaces
  output only on return anyway). If the terminal-lock is claimed while `job.json` is still stale,
  the authoritative projected status drives the branch, so a completed job is relayed (not a false
  exit-10).
- grok's `status` renders the liveness projection for each running job (status/alive/elapsed/
  last-activity/working-tree-changes), leaving terminal jobs rendered as today.
- grok's `task` documentation gains a "long-running / watch" section describing the commander's
  background-and-poll loop and its EXACT exit-code state machine (see below). No new command is
  added — the loop is commander-driven across tool calls, which is what lets a liveness line
  surface between waits.

**Commander watch-loop state machine (documented in task.md, driven via shell companion calls):**

1. Launch with background, capturing the machine-readable job id (JSON output).
2. Invoke `wait <job> --timeout-s <interval>` (interval = the user's cadence; default guidance:
   short tasks small, long tasks large).
3. Branch on exit code:
   - `10` (WAIT_TIMEOUT_EXIT, still running) → report the compact liveness line, loop to step 2.
   - `0` (completed) → stop; relay the FULL existing result exactly once (not just the small
     projection).
   - `1` (failed / timed-out / job missing) → stop; relay whatever error payload `wait` produced
     (grok's `wait` also returns 1 when the job id is absent before/during the wait).
   - `2` (cancelled) → stop; relay cancellation.
4. A job that finalizes between polls is safe: the next `wait` invocation observes the terminal
   state and returns the appropriate non-10 code.

### antigravity wiring

- antigravity's status/wait surfaces render the same liveness projection for running jobs, via
  its existing status snapshot and single-job renderers. This is where the progress observability
  removed by the migration's §7 #4 is re-introduced for antigravity — passive only.

### grok verb gate

- grok's `task` verb stays model-invocable. grok's `cancel`, `logs`, `result`, `status`, `wait`,
  and `setup` verbs become user-run only (they gain the disable-model-invocation flag), matching
  codex/antigravity's policy of only auto-firing delegation-entry verbs.
- The commander's watch loop is unaffected: it drives `wait`/`status` by invoking the grok
  companion directly via shell, which the user-run flag does not block (the flag only stops the
  *model* from auto-firing the verb wrapper). The task.md guidance must therefore instruct the
  shell loop explicitly rather than telling the model to invoke `/grok:status`.

### delegating-to-fleet router trigger

- The router skill's description is sharpened to fire on the decision to delegate, with concrete
  trigger cues, worded to reduce collision with the per-engine verb entry points.
- The grok bullet is updated to describe the background-and-poll watch pattern and the tightened
  verb set.
- This is delivered as its OWN unit with a defined validation (see Testing).

## Testing Decisions

Good tests here assert externally observable behavior — the projection's output for given
observed inputs, and the lines a companion/command emits — not internal control flow. All tests
are hermetic: fabricated job records/event lists, injected terminal-lock/pid/git/clock values,
no real engine binaries, no network.

Seams — the pure fold is the highest seam; the remaining wiring is tested by threading
observations through EXISTING command seams (extending them, not adding new lower ones):

- **New seam — the pure liveness fold.** Unit-test the fold by feeding fabricated (job record,
  events, terminal-lock status, workerAlive, workingTreeChanges, nowMs) and asserting the locked
  schema output. Cases: active vs terminal; terminal-lock-wins-over-stale-running; worker alive
  vs gone; alive-but-quiet (large quietMs, no failure); empty event log; last-activity backward
  scan over blank lines; grok structured-mode `lastActivity:null` → fallback render;
  elapsed origin from `spawned` vs `createdAt` fallback marked approximate; invalid timestamp →
  null; `workingTreeChanges` present vs null (non-git). Prior art: codex's `classifyLiveness`
  tests (pure decision function) and the existing `tests/shared` suite.
- **Extended seam — grok `runCompanion(argv, deps)`.** Thread clock/sleep/pid/git through the
  existing `deps` (today it does not pass deps into status/wait; `waitForJob` already supports
  fake clock/sleep). Then assert: `wait` emits exactly one compact liveness line per return and
  branches exit codes 10/0/1/2 correctly; a completed `wait` relays the full result exactly
  once; `status` shows the liveness summary for running jobs. Prior art:
  `tests/grok/companion.test.mjs`.
- **Extended seam — antigravity command `run(argv, ctx)` + exported status renderers.** Thread
  pid/git/clock through `ctx` (today `run` consumes only `ctx.cwd`). Assert antigravity's
  status/wait surfaces include the liveness summary for running jobs. Prior art:
  `tests/antigravity/commands.test.mjs` and its render tests.
- **Reused seam — verb-gate frontmatter assertion.** Assert grok's lifecycle/query verbs carry
  disable-model-invocation and `task` does not. Prior art:
  `tests/antigravity/command-selfinvoke.test.mjs`; grok mirrors it (grok already has
  `tests/grok/plugin-structure.test.mjs`).
- **git seam.** `workingTreeChanges` is exercised through the injected git runner inside the fold
  collector; the porcelain-count semantics get their own assertions. Prior art:
  `tests/antigravity/git.test.mjs`.
- **e2e.** Extend grok's black-box CLI e2e so a fake engine emitting a slow stream drives the
  watch loop through a timeout (exit 10) then completion (exit 0), asserting a liveness line then
  the full result. Prior art: `tests/grok/e2e-cli.test.mjs`.

**Router trigger validation** is a separate, defined check (not a unit test), shipped as a named
fixture in the router delivery unit. Locked parameters (no placeholders):

- **Corpus: 20 prompts**, stored in the fixture — 12 should-delegate (covering each engine's task
  shape: implement-a-plan → codex, independent review / large-context second opinion → codex/agy,
  self-contained one-shot subtask → grok, parallel/cheaper full-CC task → cc) and 8 should-NOT
  (trivial one-liners, work tightly coupled to code being edited, tasks needing interactive
  back-and-forth).
- **Repetitions: 3 per prompt** (60 trials total).
- **Scoring, per trial:** a should-delegate trial is a HIT when `delegating-to-fleet` fires and
  routing lands on the correct engine verb without mis-routing to a bare verb skill; a should-NOT
  trial is a HIT when the router does not fire.
- **Pass threshold:** ≥ 90% hit-rate on should-delegate trials AND ≤ 10% false-fire rate on
  should-NOT trials.
- **Measured before and after** the description change (self-distill style); the after-run must
  meet the threshold and not regress the before-run's should-NOT false-fire rate.

Before any push: the full CI chain must be green — the `sync-shared` drift check (this change
genuinely re-vendors the new shared module into each migrated plugin), `npm test` (structure +
shared + cc + antigravity + codex + grok + fleet + e2e), and `build:codex` (tsc typecheck —
confirm the new shared module does not break codex's compile).

## Out of Scope

- **Watchdog / auto-kill.** No health classifier that terminates hung jobs. Passive reporting
  only.
- **Files-touched provenance / launch baseline.** We report current working-tree changes, not a
  per-job baseline delta. Capturing a launch-time baseline and diffing (to attribute changes to
  the job) adds persistence and worker-side write scope — deferred as a future upgrade.
- **Internal sub-interval heartbeat.** Removed by design; the cadence is the caller's wait
  timeout. A separate wall-clock streaming tick is not built.
- **New TS/PY wrapper layer.** The shared runtime already is the unified, engine-agnostic
  wrapper; no new language layer is introduced.
- **Normalizing grok tool-call events into the event log.** "Which files" comes from git and
  "what now" from the last text event; per-edit tool narration stays in the raw log
  (`/grok:logs`). Add only if a future need requires per-edit detail inside the digest.
- **Promoting codex's `codex-progress` to shared.** codex keeps its own richer progress layer
  untouched; the new shared fold is independent and minimal.
- **cc surface wiring.** cc also runs the shared runWorker and will receive the vendored fold, but
  wiring it into cc's status/wait surfaces is deferred — this spec scopes surface changes to grok
  and antigravity.
- **Multitasking commander (B2).** The commander babysits the job during the watch loop (B1);
  letting it do other work between non-blocking peeks is not built.

## Further Notes

- **ADR-0002 is a prerequisite deliverable** (it does not yet exist; only ADR-0001 does). It
  records the partial reversal: re-introduce passive progress observability across the shared
  runWorker adopters (grok + antigravity), but NOT the watchdog the migration removed. It must
  cite the antigravity shared-runtime migration spec's §7 behavior-change #4 (and Q1 for the
  watchdog) — NOT "D-16", which is that spec's unrelated resultText/result-schema decision — and
  explain the distinction between dead-detection (kept, via reconcile) and progress observability
  (re-introduced here). The Codex review confirmed the read-only fold does not reintroduce the
  B3 terminal-record resurrection risk (progress is never written into `job.json`).
- **Scope / plugin isolation.** The user explicitly authorized the fleet-wide change; the
  cross-plugin edits are nonetheless delivered as separate plugin-scoped units and flow through
  the sanctioned `sync-shared` mechanism, and both adopters are tested. codex/cc get only an
  unused vendored module.
- **Token efficiency** is the reason the heartbeat is a compact projection rather than the raw
  stream: watching a 20-minute job costs a handful of short lines, not the whole verbose
  transcript.
- **Independent review.** This r2 spec folds in an independent Codex (GPT-5.6) review that
  returned NOT-READY on r1 and identified the B1 two-cadence conflict, the projection
  purity/schema ambiguity (elapsed origin), the terminal-lock authoritative-status window, the
  git-provenance fallacy, the grok structured-mode blind spot, the commander exit-code state
  machine, the seam-threading gap, and the historical mis-citation of D-16.
