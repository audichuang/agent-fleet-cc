---
name: e2e-testing
description: >-
  Complete end-to-end testing for the agent-fleet-cc plugin marketplace (codex /
  antigravity / cc / grok). Use this whenever you need to verify engine
  behavior end-to-end, run or write E2E tests, run the real-engine smoke check,
  confirm a control-plane fix actually works against the live CLIs, prove a test
  is a true regression, or answer "did you actually run it end-to-end?". Triggers
  on: e2e, end-to-end, smoke test, test:e2e, real engine test, "verify the fix
  works", "test against real codex/agy/claude/grok", launch/wait/logs/cancel exit
  codes, before-release verification, and any doubt about whether testing was
  hermetic (fake engine) vs real. Reach for this skill BEFORE claiming any
  end-to-end verification is done — there are two distinct layers and it is easy
  to conflate them. Scope: this is about TESTING the engines' job lifecycle
  (launch/wait/logs/cancel/status) in THIS repo — not generic uses of the phrase
  "end-to-end" (e.g. end-to-end encryption) and not plain unit tests of a single
  function.
---

# Complete E2E Testing for agent-fleet-cc

This repo has **two distinct E2E layers**. The single most important thing to
get right is to never conflate them, and to be explicit about which one you ran.

| Layer | What it drives | Engine | Auth/network | Determinism | Where it runs |
|---|---|---|---|---|---|
| **Hermetic E2E** (`npm run test:e2e`) | the REAL plugin CLIs as subprocesses | **fake shim / seeded on-disk state** | none | deterministic | CI + `npm test` |
| **Real-engine smoke** (manual gate) | the REAL plugin CLIs as subprocesses | **real codex / agy / claude + real model** | required | non-deterministic, costs money | local, by hand, pre-release |

Both are "end-to-end" at the **CLI/process boundary** (real `argv`, real spawn,
real on-disk state machine). They differ only in whether a **live model engine**
is behind the job. Most control-plane bugs (`wait`/`logs`/`cancel`/`status` exit
codes, log streaming, job matching, the status board) are fully covered by the
hermetic layer, because those commands only READ disk state — they never need a
live engine. The real-engine smoke exists to catch integration drift the fakes
can't model, and is a **manual gate** kept out of CI on purpose (non-determinism
+ real cost). If someone asks for "real e2e", they mean the second layer — do
not answer with the first and imply it was real.

## Layer 1 — Hermetic E2E suite

```bash
npm run test:e2e     # the 4 black-box e2e files (cc + codex + antigravity + grok)
npm test             # full chain; test:e2e is the last && leg, so it gates the build
```

`test:e2e` runs `tests/{cc,codex,antigravity,grok}/e2e-cli.test.mjs`.
Each spawns the real plugin CLI (`cc-companion.mjs`, `codex-companion.mjs`,
`antigravity/bin/antigravity.mjs`,
`grok-companion.mjs`) as a subprocess against an isolated workspace with
fake/seeded state. `tests/cc/e2e-cli.test.mjs` is
the canonical template — read it before writing a new one.

## Layer 2 — Real-engine smoke (manual gate)

**Step 1 — know what it will skip.** The smoke script probes each engine's
binary itself (`codex`, `agy`, `claude`) and skips the ones that are not on
PATH, so you do not gate it by hand. Only ENOENT counts as missing — a binary
that runs and exits non-zero is treated as present, because **auth is never
checked**: an unauthed engine surfaces as its job failing, which is the point of
a real-engine run.

**Step 2 — run the bundled smoke script:**

```bash
node .claude/skills/e2e-testing/scripts/real-engine-smoke.mjs
```

It drives each ready engine through a real background job and asserts the live
exit-code contract (see below), then cleans up after itself. It exits non-zero if
any engine violates the contract, and skips engines that aren't ready. Read
[scripts/real-engine-smoke.mjs](scripts/real-engine-smoke.mjs) to see exactly
what it runs; extend it when a new behavior needs a live-engine check.

It costs real model tokens (it cancels jobs fast to keep that minimal). Run it
before a release or after a change to the shared control plane — not on every
edit.

## The cross-engine `wait` exit-code contract

All three engines agree on this (verify any change against all three):

| Outcome | exit |
|---|---|
| job `completed` | `0` |
| job `cancelled` | `2` |
| job `failed` / missing | `1` |
| timeout before terminal | `10` |

Reference implementations: cc `waitExitCode` (`cc-companion.mjs`),
codex `waitExitCode` (`codex-companion.mjs`), antigravity `exitCodeFor`
(`antigravity/scripts/commands/wait.mjs`). If you touch any one, grep the other
two and keep them identical — a divergence here silently breaks orchestrators
that script `case $? in 2) ...`.

## Writing a new hermetic E2E test

Follow the shape in `tests/cc/e2e-cli.test.mjs`:

1. **Isolated workspace per test** — `fs.mkdtempSync`; redirect the engine's data
   dir env (`CC_PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, …) so nothing leaks.
2. **Drive the real CLI** via `spawnSync(process.execPath, [COMPANION, ...args])`
   — this exercises the genuine `argv`/entry path, not an in-process helper.
3. **Seed state, not a live model** — either a fake engine shim (cc's
   `fake-claude.mjs`) or write `job.json` + log files directly with the plugin's
   own state writers, so `wait`/`logs`/`cancel`/`status` have something to read.
4. **Assert the contract** — exit codes (`res.status`) AND the `--json`
   projection a real orchestrator consumes (assert exactly one clean JSON line;
   stderr empty on success).
5. **Prove non-vacuity** — a test that passes on the *unfixed* code tests
   nothing. Two ways, pick by change size:
   - **Small / single-line / still-uncommitted fix:** temporarily revert just the
     fix line in the working tree, run the new test, watch it fail, then restore.
     Fastest feedback for a one-liner like `waitExitCode`'s `cancelled → 2`.
   - **Multi-file or already-committed fix:** `git worktree add /tmp/old <base>`,
     copy the new test in, run it there, see it fail, then
     `git worktree remove /tmp/old --force`. Isolated, no risk of leaving the
     working tree half-reverted.

## Gotchas (hard-won — read before you waste an hour)

These are the traps this repo's engines specifically set. Each one cost real
debugging; internalize the *why* so you adapt rather than copy blindly.

- **`task --json` is MULTI-LINE pretty JSON** for codex and antigravity. Parsing
  `stdout.split("\n").pop()` gives you `}`, not the object. Parse the **whole**
  stdout: `JSON.parse(entireStdout).jobId`. (cc emits single-line JSON, so
  this bites only when you generalize a cc helper to the others.)

- **Seed an *active* ("running"/"queued") job with NO `pid`.** `wait`/`logs`/`status`
  call `listJobs → reconcileDeadPidJobs`, which auto-marks an **active** job
  `failed` if it carries a `pid` that isn't alive. A seeded running job with a
  bogus pid flips to `failed` on the first poll and your test breaks. Omit `pid` →
  `isProcessAlive(undefined)` is treated as alive → the job stays running until
  you flip it. (This same reconcile is *why* `wait` doesn't hang on a dead worker
  — don't "fix" it.) This only matters for active seeds: a **terminal** seed
  (`completed`/`failed`/`cancelled`) is never touched by reconcile, so don't bother
  adding/removing `pid` there — e.g. a "wait on a cancelled job exits 2" test just
  seeds `status: "cancelled"` directly.

- **A UTF-8 `logs --follow` regression must split a codepoint ACROSS polls.** A
  completed-job test reads the whole file in one shot and never splits — a false
  positive. Use async `spawn` on a *running* job, append the first byte of a
  multibyte char, wait > `POLL_MS` (1000ms), append the rest in the next poll,
  then flip to `completed`. Old code emits `�`; fixed code (one `StringDecoder`
  carried across polls) emits the intact character.

- **Clean up real jobs.** A real background job spawns a detached worker AND a
  watchdog. `cancel` reaps the worker (cc's two-stage cancel is asserted to
  kill the engine PID), but: prune the leftover `state/<slug>/` records, and don't
  orphan watchdogs. The smoke script does this; if you run engines by hand, end
  with a readiness/status check showing `0` running.

- **`pgrep -f` / `pkill -f` SELF-MATCH footgun.** The pattern string appears in
  your own command line, so `pgrep -f "_worker.mjs"` returns your own shell's PID;
  `pkill -f "_worker.mjs"` (or `kill $(pgrep …)`) then kills your shell — it dies
  with exit 144 and you chase a ghost. Match on something that can't appear in the
  pgrep command, or `pgrep` then `kill` only PIDs whose `ps -o cmd=` is an actual
  `node …/_worker.mjs`, never a `/bin/bash -c`.

- **Real smoke leaves harmless terminal job records** in the plugin-data state
  dir (`~/.claude/plugins/data/codex-agent-fleet/state/`). They're inert; prune
  the `real-*` slugs the smoke script created so the dir stays tidy.

## Reporting honestly

When you claim E2E verification, say which layer: "hermetic e2e suite
(`npm run test:e2e`, fake engines)" or "real-engine smoke (live codex/agy/claude)".
If you only ran the hermetic layer, say so — do not imply the live engines were
exercised. The `IRONCLAD` rule in `AGENTS.md` still applies to any test edits:
don't touch sibling plugins' files unless the change is genuinely cross-cutting.
