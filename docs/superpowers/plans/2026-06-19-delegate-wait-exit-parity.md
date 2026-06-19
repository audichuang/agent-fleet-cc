# Delegate `wait` Exit-Code Parity Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** upgrade delegate's `wait` so its exit codes match codex and antigravity — `0` completed, `1` failed/missing, `2` cancelled, `10` timeout — making the cross-engine `wait` contract identical across all three engines.

**Why:** today delegate `cmdWait` returns `job.status === "completed" ? 0 : 1`, so a **cancelled** job exits `1` (lumped with failed), whereas codex (`waitExitCode`) and antigravity (`exitCodeFor`) return `2` for cancelled. A user scripting `wait $id; case $? in 2) ... ;; esac` across engines gets `2` from codex/antigravity but `1` from delegate. This closes that gap by moving delegate UP to the richer scheme.

**Tech Stack:** Node.js ESM `.mjs`, `node:test` + `node:assert/strict`. Node >= 22.3.

## Global Constraints
- Zero-dependency pure ESM. No new npm deps.
- Tests use only `node:test` + `node:assert/strict`; hermetic (fake engine shim, redirected `DELEGATE_PLUGIN_DATA`, no network/API key).
- Every commit ends with trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Do NOT edit `shared/lib/`.** The exit-code mapping lives entirely in `plugins/delegate/scripts/delegate-companion.mjs` (verified: `shared/lib/` only carries the engine process `exitCode`, which is null for session engines). So **no `sync-shared` is required.** If a change to `shared/lib/` becomes necessary, STOP and re-scope.
- Branch: continue on `feat/p0-p1-fleet-lifecycle` (this is the same cross-engine lifecycle work; delegate edit is explicitly authorized for this change).
- The conformance contract (`tests/shared/conformance/`) does NOT encode the wait exit code — no conformance change needed.

## The Canonical Contract (all three engines after this change)
`wait <job-id>`:
- `0` — job reached `completed`
- `2` — job reached `cancelled`
- `1` — job reached `failed` (or missing job / any other terminal state)
- `10` — timeout before any terminal state (`WAIT_TIMEOUT_EXIT`)

Reference implementations to match: antigravity `plugins/antigravity/scripts/commands/wait.mjs` `exitCodeFor(status, timedOut)`; codex `plugins/codex/scripts/codex-companion.mjs` `waitExitCode(snapshot)`.

---

## Task 1: Map cancelled → exit 2 in delegate `cmdWait`

**Files:**
- Modify: `plugins/delegate/scripts/delegate-companion.mjs` (`cmdWait`, the final return ~line 393-394)
- Test: `tests/delegate/companion-wait-logs.test.mjs`

- [ ] **Step 1: Write the failing test** (append to `tests/delegate/companion-wait-logs.test.mjs`; reuse the file's existing harness — the fake-engine shim, `runCompanion`/spawn helper, `stateDir`, and the job-seeding/cancel pattern already used by the wait-exit-0 and wait-exit-10 tests). Seed/drive a job to `cancelled`, then `wait` on it and assert exit 2.

```js
test("wait on a cancelled job exits 2 (parity with codex/antigravity)", async () => {
  // Seed a job already in terminal 'cancelled' state (mirror how the exit-0
  // test seeds a 'completed' job in this file), then wait on it.
  const { stateDir /*, ...harness */ } = makeWaitHarness(); // use this file's existing setup
  const jobId = seedTerminalJob(stateDir, "cancelled");     // mirror the file's seeding helper
  const code = await runWait([jobId, "--timeout-s", "5", "--json"]); // use the file's wait runner
  assert.equal(code, 2, "cancelled job must exit 2, not 1");
});
```

(Match the EXACT helper names/shape the existing tests in this file use — `makeWaitHarness`/`seedTerminalJob`/`runWait` above are placeholders for whatever the file already defines. If the file seeds via the real fake-engine + cancel flow rather than a direct terminal seed, do it that way instead — the assertion `code === 2` is the contract.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/delegate/companion-wait-logs.test.mjs`
Expected: FAIL — old code returns `1` for cancelled (`actual: 1, expected: 2`).

- [ ] **Step 3: Implement the fix** in `plugins/delegate/scripts/delegate-companion.mjs`

Add a small helper near `WAIT_TIMEOUT_EXIT` (line ~353):

```js
// wait exit-code contract, identical to codex/antigravity:
// 0 completed, 2 cancelled, 1 failed/other terminal, 10 timeout (handled separately).
function waitExitCode(status) {
  if (status === "completed") return 0;
  if (status === "cancelled") return 2;
  return 1;
}
```

Replace the final two lines of `cmdWait` (currently `if (!done) return WAIT_TIMEOUT_EXIT; return job.status === "completed" ? 0 : 1;`) with:

```js
  if (!done) return WAIT_TIMEOUT_EXIT;
  return waitExitCode(job.status);
```

Do NOT change `cmdResult`/foreground-task exit codes (lines ~289, ~341) — those are out of scope; only the `wait` command's contract is being aligned.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/delegate/companion-wait-logs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/delegate/scripts/delegate-companion.mjs tests/delegate/companion-wait-logs.test.mjs
git commit -m "fix(delegate): wait returns exit 2 for cancelled jobs (cross-engine parity)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: E2E proof through the real CLI

**Files:**
- Modify: `tests/delegate/e2e-cli.test.mjs`

The existing "two-stage cancel actually REAPS the running engine process" test already drives a job to `cancelled` via the real CLI. Add a follow-on assertion (or a sibling test) that runs the real `wait` CLI on that cancelled job and asserts exit **2**.

- [ ] **Step 1: Add the e2e assertion** — after the job is confirmed `cancelled` (the existing test polls `pollStatus(w, jobId, "cancelled")`), run:

```js
  // cross-engine parity: wait on a cancelled job exits 2 via the real CLI
  const waitCancelled = cli(w, ["wait", jobId, "--timeout-s", "5", "--json"], { timeout: 10000 });
  assert.equal(waitCancelled.status, 2, "wait on a cancelled job must exit 2");
  assert.equal(jsonOne(waitCancelled, { successStderrEmpty: false }).status, "cancelled");
```

(Place it inside the existing cancel test after the `cancelled` poll, OR as a new test that launches a `p-hang` job, cancels it, then waits — whichever keeps the engine-reap assertions intact. Reuse the file's `cli`/`jsonOne`/`pollStatus`/`makeWorkspace` helpers.)

- [ ] **Step 2: Run to verify**

Run: `npm run test:e2e`
Expected: PASS, 21/21 (was 20). The new assertion fails on pre-fix code (cancelled → exit 1).

- [ ] **Step 3: Commit**

```bash
git add tests/delegate/e2e-cli.test.mjs
git commit -m "test(delegate): e2e proves wait on a cancelled job exits 2

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final Verification
- [ ] `npm test` → full chain green (delegate count +1 unit test; e2e +1).
- [ ] `npm run test:e2e` → green.
- [ ] **Cross-engine parity confirmed:** codex `waitExitCode`, antigravity `exitCodeFor`, delegate `waitExitCode` all map completed→0 / cancelled→2 / failed→1, and all use 10 for timeout.
- [ ] `git diff --check` clean; diff touches ONLY `plugins/delegate/scripts/delegate-companion.mjs` + the two delegate test files; no `shared/lib/` change.

## Non-vacuity requirement
Both new tests MUST fail on the pre-change `delegate-companion.mjs` (which returns `1` for cancelled) — verify against the base commit.

## Out of scope (note, do not implement here)
- delegate `result`/foreground-task exit codes (only `wait` is being aligned).
- Version bump / CHANGELOG (optional follow-up; the lifecycle commands in d107fd7 shipped without per-feature bumps, so keep this surgical).
