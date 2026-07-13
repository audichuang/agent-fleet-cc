# Re-introduce passive liveness observability for shared runWorker adopters (grok + antigravity)

**Context.** The two engines that use the shared runWorker runtime as their primary job driver —
grok and antigravity — can detect a *crashed* worker (dead-pid reconciliation) but cannot report
whether a *live* background job is progressing, stalled, or what it is doing. A detached job is a
black box for its whole run; the user only sees output when it finishes. codex does not share this
gap (it has its own app-server progress layer plus a watchdog). antigravity used to have progress
observability and removed it: the shared-runtime migration's **§7 behavior-change #4** dropped
`classifyRuntimeHealth`, `lastProgressAt`/`lastHeartbeatAt`/`healthStatus`/`possibly_stalled`,
`oauthUrl`, and `_watchdog.mjs`, replacing them with shared reconcile-per-poll +
`reconcileDeadPids`; its **Q1** decided `wantsWatchdog: false`, betting reconcile fully covers the
old watchdog. grok never had progress observability at all. The result is two engines with the
identical gap, and a fleet that answers "is my delegated job alive and doing something?"
inconsistently.

Note this is **§7 #4 / Q1**, NOT "D-16" — D-16 in that spec is the unrelated result-schema
projection decision. Earlier drafts mis-cited it; corrected here.

**Decision.** Re-introduce the **passive** half of what §7 #4 removed, as a single shared,
engine-agnostic **liveness projection** (`projectLiveness`) surfaced in grok's and antigravity's
`status`/`wait` output. Do **not** re-introduce the **active** half: no health classifier, no HUNG
detection, no auto-kill / watchdog. grok and antigravity keep `wantsWatchdog: false` and stay
watchdog-free; codex keeps its own watchdog.

The projection is computed once in the shared runtime core so the two adopters cannot drift. It is
a read-only fold of a job's existing record + normalized event log (plus observed pid-liveness and
a working-tree-change count), reporting: authoritative status, worker-alive (nullable), elapsed
run time, quiet time, last-activity snippet, and working-tree changes.

**Why.**
- The gap is shared by both runWorker adopters, so the fix belongs once in the shared runtime, not
  copied per plugin — a root-cause fix, and the only way to keep grok and antigravity from drifting.
- Passive observability is what users actually asked for ("I can't tell if the background job is
  still alive"). It is separable from — and much cheaper than — a watchdog.
- Keeping dead-detection (reconcile) untouched means §7 #4's central bet is preserved; we only add
  back the *reporting* it discarded alongside the watchdog. Q1's decision to drop the watchdog
  stands.
- **No B3 regression.** The projection never writes `job.json`; it folds existing records/events.
  The terminal-record-resurrection hazard that codex's progress layer was designed to avoid
  (progress writes racing a terminal transition) cannot arise here because there is no write.

**Considered options.**
- **Per-plugin liveness copies (grok-local, then antigravity-local).** Rejected: re-adds exactly
  what §7 #4 removed on a per-engine basis and lets the two implementations drift — the failure
  mode this fleet already suffers.
- **Re-introduce the full watchdog (classifier + auto-kill) too.** Rejected: users asked for
  visibility, not termination; a watchdog risks false-killing a slow-but-working turn and requires
  the confirm-rounds / broker-probe machinery codex carries. Out of scope; may be revisited under a
  future ADR if hung-job auto-recovery is actually wanted.

**Consequences.**
- §7 #4 is **partially reversed**: passive progress observability returns for grok + antigravity;
  the watchdog removal (and Q1's `wantsWatchdog: false`) is preserved.
- codex and cc receive the new shared module via `sync-shared` but do not call it — a vendored,
  unused file, not a behavior change. codex's own progress layer and watchdog are untouched.
- The metric named "working-tree changes" reflects the current `git status` of the job's cwd, not
  provenance; it can be non-zero from pre-existing dirt. It is labelled honestly and is not a
  claim of "files this job wrote".
- Design detail and the locked projection schema live in
  `docs/superpowers/specs/2026-07-14-fleet-liveness-observability-design.md`.
