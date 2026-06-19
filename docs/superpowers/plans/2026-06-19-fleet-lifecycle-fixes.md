# Fleet Lifecycle Review-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness/contract bugs found in the `feat/p0-p1-fleet-lifecycle` review, then add black-box end-to-end tests that exercise each fixed bug through the real CLI as a subprocess.

**Architecture:** Each engine keeps its own native runtime authoritative (no protocol translation). Fixes are surgical edits to the already-shipped lifecycle commands plus their unit/integration tests, followed by a new per-engine e2e suite modeled on the existing `tests/delegate/e2e-cli.test.mjs` (real subprocess, real on-disk state, fake/absent engine — no API key, no network). Quality/dedup refactors are a clearly-separable Part C the codex gate may trim.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, `node:string_decoder`, Claude Code slash-command Markdown. Node >= 22.3.

## Global Constraints

- New scripts are zero-dependency, pure ESM `.mjs`. No new npm deps. (AGENTS.md › Conventions)
- Tests use only `node:test` + `node:assert/strict`, are hermetic — fake binaries / redirected `*_PLUGIN_DATA` / no network. (AGENTS.md › Conventions)
- Every commit ends with trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. (AGENTS.md › Conventions)
- Work continues on branch `feat/p0-p1-fleet-lifecycle` (this is a continuation of that cross-cutting feature; the IRONCLAD single-plugin rule does not apply to this feature branch, same as commit `d107fd7`). Do NOT rewrite the pushed `d107fd7`.
- Do not change the shared runtime `shared/lib/` (none of these fixes need it; avoids the sync-shared re-vendor obligation).
- After every task: `node --test tests/<plugin>/*.test.mjs` for the touched plugin must pass. Final gate: `npm test` (819+ green) AND `npm run test:e2e`.

---

## Codex validation gate (2026-06-19)

Plan reviewed by Codex (GPT-5.5, read-only). **Verdict: APPROVE-WITH-CHANGES.** All findings have been folded into the tasks below (marked "Codex-gate"). Highlights:
- T1 highest-risk check **confirmed**: `main()` does not reset `process.exitCode` on the success path, so `handleWait` setting it survives.
- Critical: T7 used a non-existent `readJobLog` (codex has none) → switched to `fs` + `resolveJobLogFile`; T9 UTF-8 e2e was a false positive (completed-job whole-file read) → rewritten as a true split-across-polls regression; T4 targeted the wrong test file and would break an existing index-fail assertion → retargeted to `job-control-snapshot.test.mjs` and flips that assertion.
- Important: T8 missing hermetic `./helpers.mjs` import; existing `fleet-status.test.mjs` `/codex:attach` assertion must be updated; `extractJobs` should also recognize a `{jobs:[…]}` envelope; T9 needs an explicit index-cancel case.
- Scope: Part A/B acceptable on this cross-cutting feature branch; **Part C deferred** to a follow-up PR.

---

## File Structure

**Part A — correctness/contract fixes (must)**
- Modify `plugins/codex/scripts/codex-companion.mjs` — wait exit codes (T1), timeout/poll falsy-zero (T2), logs no-id fallback (T7).
- Modify `plugins/antigravity/scripts/commands/logs.mjs` — UTF-8-safe follow streaming (T3).
- Modify `plugins/antigravity/scripts/lib/job-control.mjs` — multi-active cancel matching (T4).
- Modify `plugins/antigravity/scripts/lib/args.mjs` — boolean `--flag=value` coercion (T5).
- Modify `plugins/fleet/scripts/fleet-status.mjs` — unknown-shape row + action dedupe (T6).

**Part B — e2e coverage of the found bugs (must)**
- Create `tests/codex/e2e-cli.test.mjs` — T1/T2/T7 through the real CLI.
- Create `tests/antigravity/e2e-cli.test.mjs` — T3/T4 through the real CLI.
- Create `tests/fleet/e2e-cli.test.mjs` — T6 through the real CLI.
- Modify `package.json` — `test:e2e` runs all e2e files; `npm test` gains an e2e leg.

**Part C — quality/dedup (recommended, separable; codex gate decides)**
- Create `plugins/antigravity/scripts/lib/poll.mjs` — shared poll/terminal helper; rewire `wait.mjs`/`logs.mjs`.
- Create `plugins/fleet/scripts/lib/cli-args.mjs` — shared argv/parse; rewire `fleet-status.mjs`/`fleet-doctor.mjs`.
- Modify `plugins/fleet/scripts/fleet-status.mjs` — concurrent engine spawn.
- Modify `plugins/fleet/scripts/fleet-status.mjs` + `fleet-doctor.mjs` — realpath-normalized entry guard.

---

## Task 1: Codex `wait` returns lifecycle exit codes (0/1/2/10)

**Bug:** `handleWait` ignores `snapshot.waitTimedOut` and never sets a non-zero exit code; `main()` only sets exit 1 on a thrown error. So `/codex:wait` exits 0 on timeout, `failed`, and `cancelled` — opposite of antigravity `wait` (0 completed / 1 failed-or-missing / 2 cancelled / 10 timeout) and breaks `codex wait id && deploy`.

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`handleWait` ~968-989; add `waitExitCode`)
- Test: `tests/codex/wait-logs.test.mjs`

**Interfaces:**
- Consumes: `waitForSingleJobSnapshot(cwd, ref, {timeoutMs, pollIntervalMs}) -> {...snapshot, waitTimedOut, timeoutMs}`, `outputCommandResult`, `renderJobStatusReport`.
- Produces: `waitExitCode(snapshot) -> 0|1|2|10`; `/codex:wait` sets `process.exitCode`.

- [ ] **Step 1: Write the failing tests** (append to `tests/codex/wait-logs.test.mjs`)

```js
test("wait exits 0 for a completed job", () => {
  const workspace = makeTempDir();
  const { job } = writeCompletedJob(workspace, "codex-done-1");
  const result = run("node", [SCRIPT, "wait", `${job.id} --cwd ${workspace} --json`], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
});

test("wait exits 10 when it times out on a still-running job", () => {
  const workspace = makeTempDir();
  const { job } = writeRunningJob(workspace, "codex-run-1"); // helper below
  const result = run("node", [SCRIPT, "wait", `${job.id} --cwd ${workspace} --timeout-ms 0 --json`], { cwd: workspace });
  assert.equal(result.status, 10, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").pop()).status, "running");
});

test("wait exits 1 for a failed job and 2 for a cancelled job", () => {
  const workspace = makeTempDir();
  const failed = writeTerminalJob(workspace, "codex-fail-1", "failed");   // helper below
  const cancelled = writeTerminalJob(workspace, "codex-cancel-1", "cancelled");
  const r1 = run("node", [SCRIPT, "wait", `${failed.id} --cwd ${workspace} --json`], { cwd: workspace });
  const r2 = run("node", [SCRIPT, "wait", `${cancelled.id} --cwd ${workspace} --json`], { cwd: workspace });
  assert.equal(r1.status, 1, r1.stderr);
  assert.equal(r2.status, 2, r2.stderr);
});
```

Add small fixture helpers next to `writeCompletedJob` in the same file (mirror its shape, vary `status`):

```js
function writeRunningJob(workspace, jobId) { return writeTerminalJob(workspace, jobId, "running"); }
function writeTerminalJob(workspace, jobId, status) {
  const logFile = resolveJobLogFile(workspace, jobId);
  appendLogLine(logFile, `log for ${jobId}`);
  const job = {
    id: jobId, workspaceRoot: workspace, sessionId: "S1", status, phase: status,
    jobClass: "task", logFile,
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: status === "running" || status === "queued" ? null : "2026-01-01T00:01:00.000Z",
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return job;
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='wait exits' tests/codex/wait-logs.test.mjs`
Expected: the three new tests FAIL (current exit is 0 for timeout/failed/cancelled).

- [ ] **Step 3: Implement the fix** in `plugins/codex/scripts/codex-companion.mjs`

Add the helper (place near `isActiveJobStatus`, ~line 354):

```js
function waitExitCode(snapshot) {
  if (snapshot.waitTimedOut) return 10;
  const status = snapshot.job?.status;
  if (status === "completed") return 0;
  if (status === "cancelled") return 2;
  return 1; // failed, or any non-completed terminal state
}
```

Change the tail of `handleWait` to set the exit code:

```js
  const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
    timeoutMs: options["timeout-ms"],
    pollIntervalMs: options["poll-interval-ms"]
  });
  outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
  process.exitCode = waitExitCode(snapshot);
```

(`main()` does not reset `process.exitCode` on success, and only the `.catch` sets it to 1 on a thrown error — so a thrown "missing job" still yields exit 1, matching antigravity.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/codex/wait-logs.test.mjs`
Expected: PASS (including the three new tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/codex/wait-logs.test.mjs
git commit -m "fix(codex): /codex:wait returns 0/1/2/10 lifecycle exit codes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Codex `wait` honours `--timeout-ms 0` / `--poll-interval-ms 0`

**Bug:** `waitForSingleJobSnapshot` uses `Number(value) || DEFAULT`, so `0` (a valid "poll once" / "minimum interval" request) is treated as falsy and replaced by the default — `--timeout-ms 0` blocks for the full 4-minute default instead of returning immediately.

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`waitForSingleJobSnapshot` ~380-382; add `coerceMs`)
- Test: `tests/codex/wait-logs.test.mjs`

**Interfaces:**
- Produces: `coerceMs(value, fallback, floor) -> number` (private).

- [ ] **Step 1: Write the failing test**

```js
test("wait --timeout-ms 0 returns immediately (does not fall back to default)", () => {
  const workspace = makeTempDir();
  const { job } = writeRunningJob(workspace, "codex-run-0");
  const started = Date.now();
  const result = run("node", [SCRIPT, "wait", `${job.id} --cwd ${workspace} --timeout-ms 0 --json`], { cwd: workspace });
  assert.equal(result.status, 10, result.stderr);          // still running -> timeout
  assert.ok(Date.now() - started < 4000, "must not block for the 240s default");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='timeout-ms 0' tests/codex/wait-logs.test.mjs`
Expected: FAIL — either it hangs near the test timeout, or (pre-Task-1) exits 0.

- [ ] **Step 3: Implement the fix**

Add helper near the other coercion helpers (above `waitForSingleJobSnapshot`):

```js
function coerceMs(value, fallback, floor = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.max(floor, n);
}
```

Replace lines 381-382 inside `waitForSingleJobSnapshot`:

```js
  const timeoutMs = coerceMs(options.timeoutMs, DEFAULT_STATUS_WAIT_TIMEOUT_MS, 0);
  const pollIntervalMs = coerceMs(options.pollIntervalMs, DEFAULT_STATUS_POLL_INTERVAL_MS, 100);
```

(`timeoutMs: 0` → `deadline = now`, the `while (... && Date.now() < deadline)` body never runs, returns the current snapshot with `waitTimedOut = isActiveJobStatus(status)`.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/codex/wait-logs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/codex/wait-logs.test.mjs
git commit -m "fix(codex): wait honours --timeout-ms 0 / --poll-interval-ms 0 (falsy-zero)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Antigravity `logs --follow` is UTF-8-safe across poll boundaries

**Bug:** `followLog` reads appended bytes each poll and decodes each chunk independently with `bytes.toString("utf8")`. A multibyte character (CJK / emoji / box-drawing in agy output) straddling a poll's byte boundary is decoded as replacement garbage on both sides. Only reproduces in `--follow` with non-ASCII, so ASCII tests miss it.

**Files:**
- Modify: `plugins/antigravity/scripts/commands/logs.mjs` (`followLog`, `readFullLog`, `readAppendedLog`)
- Test: `tests/antigravity/commands.test.mjs`

**Interfaces:**
- `readFullLogBytes(workspaceRoot, jobId) -> {bytes: Buffer, offset: number}` (replaces `readFullLog`)
- `readAppendedBytes(workspaceRoot, jobId, offset) -> {bytes: Buffer, offset: number}` (replaces `readAppendedLog`)
- `followLog` uses a single `StringDecoder("utf8")` across all writes and flushes with `.end()`.

- [ ] **Step 1: Write the failing test** (append to `tests/antigravity/commands.test.mjs`; reuse that file's existing job/workspace helpers — match their names)

```js
test("logs --follow does not corrupt multibyte UTF-8 split across a poll boundary", async () => {
  // unit-level guard on the decoder seam: feed bytes split mid-character
  const { decodeStreamForTest } = await import("../../plugins/antigravity/scripts/commands/logs.mjs");
  const full = Buffer.from("héllo 中文 🚀 done\n", "utf8");
  const cut = 2; // splits the 'é' (0xC3 0xA9) across chunks
  const out = decodeStreamForTest([full.subarray(0, cut), full.subarray(cut)]);
  assert.equal(out, "héllo 中文 🚀 done\n");
  assert.ok(!out.includes("�"), "no replacement char");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --experimental-test-module-mocks --test-name-pattern='multibyte' tests/antigravity/commands.test.mjs`
Expected: FAIL — `decodeStreamForTest` is not exported yet.

- [ ] **Step 3: Implement the fix** in `plugins/antigravity/scripts/commands/logs.mjs`

Add the import at the top:

```js
import { StringDecoder } from "node:string_decoder";
```

Replace `readFullLog`/`readAppendedLog` with byte-returning variants:

```js
function readFullLogBytes(workspaceRoot, jobId) {
  const filePath = resolveJobLogFile(workspaceRoot, jobId);
  try {
    const bytes = fs.readFileSync(filePath);
    return { bytes, offset: bytes.length };
  } catch {
    return { bytes: Buffer.alloc(0), offset: 0 };
  }
}

function readAppendedBytes(workspaceRoot, jobId, offset) {
  const filePath = resolveJobLogFile(workspaceRoot, jobId);
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return { bytes: Buffer.alloc(0), offset: stat.size };
    fd = fs.openSync(filePath, "r");
    const length = stat.size - offset;
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, offset);
    return { bytes, offset: stat.size };
  } catch {
    return { bytes: Buffer.alloc(0), offset };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
  }
}
```

Rewrite `followLog` to carry one decoder:

```js
async function followLog(initialSnapshot, cwd, timeoutMs) {
  let snapshot = initialSnapshot;
  const jobId = snapshot.job.id;
  const deadline = Date.now() + timeoutMs;
  const decoder = new StringDecoder("utf8");
  let { bytes, offset } = readFullLogBytes(snapshot.workspaceRoot, jobId);
  if (bytes.length) process.stdout.write(decoder.write(bytes));

  let timedOut = false;
  while (!TERMINAL_STATUSES.has(snapshot.job.status)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) { timedOut = true; break; }
    await sleep(Math.min(POLL_MS, remainingMs));
    const appended = readAppendedBytes(snapshot.workspaceRoot, jobId, offset);
    offset = appended.offset;
    if (appended.bytes.length) process.stdout.write(decoder.write(appended.bytes));
    snapshot = buildSingleJobSnapshot(cwd, jobId);
  }

  if (!timedOut) {
    const appended = readAppendedBytes(snapshot.workspaceRoot, jobId, offset);
    if (appended.bytes.length) process.stdout.write(decoder.write(appended.bytes));
  }
  const tail = decoder.end();
  if (tail) process.stdout.write(tail);
  return { snapshot, timedOut };
}
```

Add the test seam at the bottom (before `export default run;`):

```js
// Test seam: prove the streaming decoder reassembles characters split across chunks.
export function decodeStreamForTest(chunks) {
  const decoder = new StringDecoder("utf8");
  let out = "";
  for (const chunk of chunks) out += decoder.write(Buffer.from(chunk));
  return out + decoder.end();
}
```

(The `--json` path still uses `readJobLog` to read the whole file at once — no boundary issue there.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test --experimental-test-module-mocks tests/antigravity/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/antigravity/scripts/commands/logs.mjs tests/antigravity/commands.test.mjs
git commit -m "fix(antigravity): UTF-8-safe logs --follow streaming across poll boundaries

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Antigravity multi-active `cancel` restores prefix/index matching

**Bug:** When >1 active job, `resolveCancelableJob` only accepts an exact full `job.id` (`activeJobs.find(j => j.id === reference)`), dropping the unique-prefix and 1-based-index matching that `matchJobReference` still provides with one active job. So `/antigravity:cancel 1` or a unique prefix works with one active job but errors with several — exactly when disambiguation matters. The safety goal (refuse to guess when NO reference is given) must be preserved.

**Files:**
- Modify: `plugins/antigravity/scripts/lib/job-control.mjs` (`resolveCancelableJob` 278-305)
- Test: `tests/antigravity/job-control-snapshot.test.mjs` (← the EXISTING home of `resolveCancelableJob` tests; NOT `job-control.test.mjs`)

> **Codex-gate correction:** the current `resolveCancelableJob` coverage lives in `tests/antigravity/job-control-snapshot.test.mjs` (the `describe('resolveCancelableJob', …)` block ~225-269). Crucially, line ~253 (`it('does not accept positional indexes as job ids when multiple active jobs exist', …)`) currently asserts `resolveCancelableJob(workCwd, '1')` THROWS. After this fix that behavior reverses, so this existing assertion MUST be updated in the same task or the suite breaks. Reuse that block's existing `workCwd` multi-active seeding fixture — do not invent a new `seedActiveJobs`.

- [ ] **Step 1: Flip the existing index assertion and add the new ones** in `tests/antigravity/job-control-snapshot.test.mjs`

Replace the body of the existing `it('does not accept positional indexes as job ids when multiple active jobs exist', …)` (~253) so it now asserts resolution succeeds, and add prefix + ambiguity coverage. Use the exact same multi-active seeding the surrounding `it` blocks already use (the `workCwd` with two active jobs):

```js
  it('accepts a 1-based positional index when multiple active jobs exist', async () => {
    // (same multi-active seeding the sibling tests use)
    const { job } = resolveCancelableJob(workCwd, '1'); // newest-first index
    assert.ok(job && job.id, 'index 1 resolves to the newest active job');
  });

  it('accepts a unique substring/prefix when multiple active jobs exist', async () => {
    // seed two active jobs whose ids share NO common substring, e.g. 'c1'..., 'd2'...
    const { job } = resolveCancelableJob(workCwd, /* unique fragment of one id */ 'c1');
    assert.ok(job && job.id.includes('c1'));
  });

  it('still refuses to guess with NO reference when multiple active jobs exist', async () => {
    assert.throws(() => resolveCancelableJob(workCwd, null), /Multiple active antigravity jobs/);
  });

  it('refuses an AMBIGUOUS fragment that matches more than one active job', async () => {
    // seed two active jobs that SHARE a fragment; that fragment must not resolve
    assert.throws(() => resolveCancelableJob(workCwd, /* shared fragment */ 'agy'), /No active job matched/);
  });
```

(Note: `matchJobReference` matches by substring `includes`, not strict prefix — keep the wording/test fragments consistent with substring semantics. It returns `null` when a fragment matches >1 candidate, so ambiguity still errors.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test --experimental-test-module-mocks --test-name-pattern='index when multiple active|unique substring|AMBIGUOUS' tests/antigravity/job-control-snapshot.test.mjs`
Expected: FAIL — index/substring currently throw "full id required".

- [ ] **Step 3: Implement the fix** — replace the `activeJobs.length > 1` block (289-296):

```js
  if (activeJobs.length > 1) {
    const ids = activeJobs.map((j) => j.id).join(", ");
    if (!reference) {
      throw new Error(
        `Multiple active antigravity jobs; pass a job id. Active jobs: ${ids}`
      );
    }
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job matched "${reference}". Active jobs: ${ids}`);
    }
    return { workspaceRoot, job: selected };
  }
```

(`matchJobReference` returns `null` when a partial prefix matches >1 job, so ambiguous references still error instead of cancelling the wrong job.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test --experimental-test-module-mocks tests/antigravity/job-control-snapshot.test.mjs`
Expected: PASS (including the flipped index assertion).

- [ ] **Step 5: Commit**

```bash
git add plugins/antigravity/scripts/lib/job-control.mjs tests/antigravity/job-control-snapshot.test.mjs
git commit -m "fix(antigravity): multi-active cancel accepts unique substring/index, still refuses to guess

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Antigravity `--flag=value` boolean coercion accepts falsy spellings

**Bug:** `args.mjs` line 48 coerces inline boolean values with `inlineValue !== "false"`, so `--json=0`, `--json=no`, `--json=off`, `--json=` all become `true`; only the exact string `false` disables. Surprising and asymmetric.

**Files:**
- Modify: `plugins/antigravity/scripts/lib/args.mjs` (line 48)
- Test: `tests/antigravity/args.test.mjs` (create if absent — there is no dedicated args test today; `tests/codex/args.test.mjs` exists as a style reference)

**Interfaces:**
- Produces: `parseBooleanFlagValue(inlineValue) -> boolean` (private to `args.mjs`).

- [ ] **Step 1: Write the failing test** — create `tests/antigravity/args.test.mjs`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../plugins/antigravity/scripts/lib/args.mjs";

const schema = { booleanOptions: ["json"], valueOptions: ["cwd"] };

test("bare boolean flag is true", () => {
  assert.equal(parseArgs(["--json"], schema).options.json, true);
});

test("falsy spellings disable a boolean flag", () => {
  for (const v of ["false", "0", "no", "off", "", "FALSE", "No"]) {
    assert.equal(parseArgs([`--json=${v}`], schema).options.json, false, `--json=${v}`);
  }
});

test("truthy spellings enable a boolean flag", () => {
  for (const v of ["true", "1", "yes", "on"]) {
    assert.equal(parseArgs([`--json=${v}`], schema).options.json, true, `--json=${v}`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --experimental-test-module-mocks tests/antigravity/args.test.mjs`
Expected: FAIL on the falsy-spellings case (`0`/`no`/`off`/``/`FALSE` currently yield `true`).

- [ ] **Step 3: Implement the fix** in `plugins/antigravity/scripts/lib/args.mjs`

Add the helper above `parseArgs`:

```js
const FALSY_FLAG_VALUES = new Set(["false", "0", "no", "off", ""]);
function parseBooleanFlagValue(inlineValue) {
  if (inlineValue === undefined) return true;
  return !FALSY_FLAG_VALUES.has(String(inlineValue).trim().toLowerCase());
}
```

Replace line 48:

```js
      } else if (booleanSet.has(key)) {
        options[key] = parseBooleanFlagValue(inlineValue);
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test --experimental-test-module-mocks tests/antigravity/args.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/antigravity/scripts/lib/args.mjs tests/antigravity/args.test.mjs
git commit -m "fix(antigravity): boolean --flag=value accepts false/0/no/off/empty as false

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Fleet status surfaces unrecognized engine JSON instead of faking "idle"; dedupes codex action

**Bug A:** `extractJobs` understands only `{running, recent, latestFinished}` or a bare array. Any other object shape (e.g. `{error}`, or a future `{jobs:[...]}`) silently yields zero jobs, so the board prints `idle / no known jobs` for an engine that may actually have running work — a wrong-but-plausible row, the hardest kind to notice.
**Bug B:** `buildActions` emits both `/codex:logs ${id}` and `/codex:attach ${id}` though `handleLogs` is literally `return handleAttach` — one capability, two rows.

**Files:**
- Modify: `plugins/fleet/scripts/fleet-status.mjs` (`extractJobs` ~181-191, `normalizeStatus` ~159-178, `buildActions` ~203-217)
- Test: `tests/fleet/fleet-status.test.mjs`

**Interfaces:**
- `extractJobs(payload) -> {jobs: object[], recognized: boolean}` (was `-> object[]`).
- `normalizeStatus` produces a row with `status: "unknown"` and an explanatory `summary` when `recognized` is false; `available` stays `true` (the command ran) but the row no longer claims "idle".

- [ ] **Step 1: Write the failing tests** (append to `tests/fleet/fleet-status.test.mjs`; reuse its existing `spawnSyncImpl` fake + `runStatus` import)

```js
test("an unrecognized status JSON shape becomes an explicit 'unknown' row, not idle", () => {
  const fakeSpawn = makeFakeSpawn({ codex: JSON.stringify({ unexpected: true }) }); // helper in this file
  const doc = JSON.parse(runStatus(["--only", "codex", "--json"], { spawnSyncImpl: fakeSpawn, existsSyncImpl: () => true, pluginRoot: "/x", cwd: "/x" }).stdout);
  const row = doc.rows.find((r) => r.engine === "codex");
  assert.equal(row.status, "unknown");
  assert.match(row.summary, /unrecognized|unknown/i);
  assert.notEqual(row.status, "idle");
});

test("codex actions do not list both logs and attach (same handler)", () => {
  const fakeSpawn = makeFakeSpawn({ codex: JSON.stringify({ running: [{ id: "codex-1", status: "running" }], recent: [] }) });
  const doc = JSON.parse(runStatus(["--only", "codex", "--json"], { spawnSyncImpl: fakeSpawn, existsSyncImpl: () => true, pluginRoot: "/x", cwd: "/x" }).stdout);
  const actions = doc.rows.find((r) => r.engine === "codex").actions;
  assert.ok(actions.includes("/codex:logs codex-1"));
  assert.ok(!actions.includes("/codex:attach codex-1"), "attach is redundant with logs");
});
```

If `makeFakeSpawn` is not already a helper in the file, add one that returns `{ status: 0, stdout, stderr: "" }` for the named engine (match the existing tests' fake-spawn shape).

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='unrecognized|both logs and attach' tests/fleet/fleet-status.test.mjs`
Expected: FAIL — unknown shape currently yields `status: "idle"`; codex actions currently include `/codex:attach`.

- [ ] **Step 3: Implement the fix** in `plugins/fleet/scripts/fleet-status.mjs`

Make `extractJobs` report recognition:

```js
function extractJobs(payload) {
  if (Array.isArray(payload)) return { jobs: payload, recognized: true };
  if (!payload || typeof payload !== "object") return { jobs: [], recognized: false };
  const hasKnownKeys =
    Array.isArray(payload.running) ||
    Array.isArray(payload.recent) ||
    Array.isArray(payload.jobs) ||   // Codex-gate: also recognize a {jobs:[...]} envelope
    payload.latestFinished;
  if (!hasKnownKeys) return { jobs: [], recognized: false };
  const jobs = [];
  if (Array.isArray(payload.running)) jobs.push(...payload.running);
  if (Array.isArray(payload.recent)) jobs.push(...payload.recent);
  if (Array.isArray(payload.jobs)) jobs.push(...payload.jobs);
  if (payload.latestFinished && !jobs.some((job) => job?.id === payload.latestFinished?.id)) {
    jobs.push(payload.latestFinished);
  }
  return { jobs, recognized: true };
}
```

Update `normalizeStatus` to handle the unrecognized case:

```js
function normalizeStatus(engine, payload) {
  const { jobs, recognized } = extractJobs(payload);
  if (!recognized) {
    return {
      engine, available: true, active: 0, recent: 0, status: "unknown",
      summary: `${engine}: status JSON in an unrecognized shape; cannot tally jobs`,
      actions: [`/${engine}:status`],
    };
  }
  const activeJobs = jobs.filter((job) => ACTIVE_STATUSES.has(job?.status));
  const recentJobs = jobs.filter((job) => !ACTIVE_STATUSES.has(job?.status));
  const active = activeJobs.length;
  const recent = recentJobs.length;
  const latest = activeJobs[0] ?? recentJobs[0] ?? null;
  const status = active ? "active" : latest?.status ?? "idle";
  return {
    engine, available: true, active, recent, status,
    summary: summarizeRow(engine, active, recent, latest),
    actions: buildActions(engine, latest),
  };
}
```

Drop the redundant `/codex:attach` line in `buildActions` (keep `/codex:logs`):

```js
  if (engine === "codex") {
    actions.push(`/codex:logs ${id}`);
  } else if (engine === "delegate") {
    actions.push(`/delegate:logs ${id} --follow`);
  } else {
    actions.push(`/antigravity:logs ${id} --follow`);
  }
```

- [ ] **Step 3b: Update the existing assertion that expects `/codex:attach`** (Codex-gate)

`tests/fleet/fleet-status.test.mjs` (~line 75) currently asserts the codex actions include `/codex:attach …`. T6 removes that action, so this existing assertion must be changed to expect `/codex:logs …` and to assert `/codex:attach` is absent. Do this before re-running the suite.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/fleet/fleet-status.test.mjs`
Expected: PASS. Also run the whole fleet suite to catch any snapshot assertions: `node --test "tests/fleet/*.test.mjs"`.

- [ ] **Step 5: Commit**

```bash
git add plugins/fleet/scripts/fleet-status.mjs tests/fleet/fleet-status.test.mjs
git commit -m "fix(fleet): status surfaces unrecognized engine JSON as 'unknown'; dedupe codex logs/attach action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Codex `logs` (no id) falls back to the latest job's persisted log

**Bug:** `handleLogs` delegates to `handleAttach`, whose no-reference branch only finds `queued`/`running` jobs and otherwise throws `No active Codex job to attach to`. So `/codex:logs` with no id fails on a finished job, contradicting the `logs [job-id]` usage and antigravity/delegate `logs` which can show terminal logs.

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`handleLogs` ~1264)
- Test: `tests/codex/wait-logs.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test("logs with no job id prints the latest job's persisted log even when finished", () => {
  const workspace = makeTempDir();
  writeCompletedJob(workspace, "codex-done-logs");
  const result = run("node", [SCRIPT, "logs", `--cwd ${workspace}`], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /final log line/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='logs with no job id' tests/codex/wait-logs.test.mjs`
Expected: FAIL — throws "No active Codex job to attach to" (exit 1).

- [ ] **Step 3: Implement the fix** — make `handleLogs` resolve the latest job when no id is given, else delegate to attach:

> **Codex-gate correction:** Codex state does NOT export `readJobLog` (verified — it exposes `resolveJobLogFile`/`writeJobFile`/`createJobLogFile`, and `handleAttach` reads logs via `fs.readFileSync(logFile)` directly). Read the persisted log with `fs` + `resolveJobLogFile`, not `readJobLog`.

```js
export async function handleLogs(argv, deps = {}) {
  const { positionals, options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "poll-interval-ms"],
    booleanOptions: ["json", "follow"]
  });
  // With no explicit id and no live job, fall back to the most recent job's
  // persisted log instead of erroring (attach semantics require a live job).
  if (!positionals[0]) {
    const workspaceRoot = resolveCommandWorkspace(options);
    const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
    const live = jobs.find((j) => j.status === "queued" || j.status === "running");
    if (!live && jobs[0]) {
      const logFile = jobs[0].logFile ?? resolveJobLogFile(workspaceRoot, jobs[0].id);
      let log = "";
      try { log = fs.readFileSync(logFile, "utf8"); } catch { /* no log yet */ }
      outputResult(log, false);
      return;
    }
  }
  return handleAttach(argv, deps);
}
```

Confirm the symbols used are in-scope in `codex-companion.mjs`: `fs` (imported), `resolveJobLogFile` (already imported from `./lib/state.mjs`), `sortJobsNewestFirst`, `listJobs`, `resolveCommandWorkspace`, `outputResult`, `parseCommandInput` — all used elsewhere in the module. Do NOT add a `readJobLog` import.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/codex/wait-logs.test.mjs`
Expected: PASS. Also `node --test tests/codex/attach-tail.test.mjs` to confirm live-attach is unaffected.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/codex/wait-logs.test.mjs
git commit -m "fix(codex): logs with no id prints latest job's persisted log when none is live

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Codex e2e — wait exit codes, timeout=0, logs no-id (real subprocess)

**Goal:** Black-box e2e that drives the real `codex-companion.mjs` CLI as a subprocess against real on-disk job state (no live engine needed for `wait`/`logs`, which only read disk), proving the T1/T2/T7 user-facing contracts.

**Files:**
- Create: `tests/codex/e2e-cli.test.mjs`

- [ ] **Step 1: Write the e2e tests** (model on `tests/delegate/e2e-cli.test.mjs`; seed jobs with the same `state.mjs`/`tracked-jobs.mjs` helpers `wait-logs.test.mjs` already uses)

```js
// Black-box e2e: drives the REAL codex-companion.mjs CLI as a subprocess against
// real on-disk job state. Covers the review-found wait/logs contract bugs.
import "./helpers.mjs"; // Codex-gate: hermetic CLAUDE_PLUGIN_DATA/HOME isolation (matches the rest of tests/codex)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveJobLogFile, saveState, writeJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { appendLogLine } from "../../plugins/codex/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function ws() { return fs.mkdtempSync(path.join(os.tmpdir(), "codex-e2e-")); }
function cli(cwd, args, timeout = 15000) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout });
}
function seedJob(cwd, id, status, line = `log ${id}`) {
  const logFile = resolveJobLogFile(cwd, id);
  appendLogLine(logFile, line);
  const terminal = !(status === "running" || status === "queued");
  const job = { id, workspaceRoot: cwd, sessionId: "S1", status, phase: status, jobClass: "task", logFile,
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z", completedAt: terminal ? "2026-01-01T00:01:00.000Z" : null };
  writeJobFile(cwd, id, job);
  saveState(cwd, { version: 1, config: { stopReviewGate: false }, jobs: [job] });
  return job;
}

test("e2e: codex wait exit codes — completed=0, failed=1, cancelled=2", () => {
  const cwd = ws();
  seedJob(cwd, "codex-c", "completed"); seedJob(cwd, "codex-f", "failed"); seedJob(cwd, "codex-x", "cancelled");
  // (seedJob overwrites state each call; seed each in its own workspace instead)
  const a = ws(); seedJob(a, "codex-c", "completed");
  const b = ws(); seedJob(b, "codex-f", "failed");
  const c = ws(); seedJob(c, "codex-x", "cancelled");
  assert.equal(cli(a, ["wait", "codex-c", "--cwd", a, "--json"]).status, 0);
  assert.equal(cli(b, ["wait", "codex-f", "--cwd", b, "--json"]).status, 1);
  assert.equal(cli(c, ["wait", "codex-x", "--cwd", c, "--json"]).status, 2);
});

test("e2e: codex wait on a running job times out with exit 10 and returns promptly", () => {
  const cwd = ws(); seedJob(cwd, "codex-r", "running");
  const t0 = Date.now();
  const res = cli(cwd, ["wait", "codex-r", "--cwd", cwd, "--timeout-ms", "0", "--json"]);
  assert.equal(res.status, 10, res.stderr);
  assert.ok(Date.now() - t0 < 5000, "timeout-ms 0 must not block for the default");
});

test("e2e: codex logs with no id prints the latest finished job's persisted log", () => {
  const cwd = ws(); seedJob(cwd, "codex-done", "completed", "FINAL_LINE_MARKER");
  const res = cli(cwd, ["logs", "--cwd", cwd]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /FINAL_LINE_MARKER/);
});
```

(Fix the first test's workspace reuse — keep only the per-workspace `a`/`b`/`c` seeding; delete the shared-`cwd` triple seed line. Shown here so the implementer sees the intent.)

- [ ] **Step 2: Run** — `node --test tests/codex/e2e-cli.test.mjs` → Expected: PASS (after T1/T2/T7).

- [ ] **Step 3: Commit**

```bash
git add tests/codex/e2e-cli.test.mjs
git commit -m "test(codex): e2e for wait exit codes, timeout=0, logs no-id fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Antigravity e2e — logs --follow UTF-8 + multi-active cancel (real subprocess)

**Goal:** Drive the real antigravity CLI entry as a subprocess against on-disk state, proving T3 (no mojibake in `--follow`) and T4 (prefix/index cancel with multiple active jobs). The bin entry is `plugins/antigravity/bin/antigravity.mjs`.

**Files:**
- Create: `tests/antigravity/e2e-cli.test.mjs`

> **Codex-gate corrections (both critical):**
> 1. **UTF-8 e2e must be a TRUE regression.** A *completed* job makes `followLog` read the whole file in one `readFullLogBytes` before any poll — so a whole-buffer decode never splits a codepoint and the test would PASS even unfixed. The test must: seed a **running** job, start `logs --follow` **asynchronously** (`child_process.spawn`, not `spawnSync`), append the first half of a multibyte codepoint, wait > `POLL_MS` (1000ms), append the second half + newline (so the two halves are read in *different* polls → split across reads), then flip the job to `completed` so the follow loop exits. Old code → `�`; fixed code → intact.
> 2. **Use the writers that actually exist.** antigravity `state.mjs` exports `resolveJobLogFile`, `ensureStateDir`, `writeJobFileUnlocked`, `appendJobLog` — there is **no** `saveState`/`writeJobFile`. Call `ensureStateDir(cwd)` before writing the log file directly (`resolveJobLogFile` only computes a path). Seed jobs by mirroring the exact shape used in `tests/antigravity/job-control-snapshot.test.mjs`; reuse that file's seeding utility if practical.
> 3. **Avoid dead-pid reconcile killing the running job.** `buildSingleJobSnapshot → listJobs → reconcileDeadPidJobs` auto-marks an active job `failed` if it has a `pid` that is not alive. Seed the running job with **no `pid`** (`defaultIsProcessAlive(undefined)` returns true → not reconciled), so `--follow` keeps polling until the test flips status.

- [ ] **Step 1: Write the e2e tests** — verify the precise `state.mjs` writer signatures and the job shape (read `plugins/antigravity/scripts/lib/state.mjs` + `tests/antigravity/job-control-snapshot.test.mjs`) before finalizing.

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
// Writers that ACTUALLY exist in antigravity state.mjs (verify before editing):
import { resolveJobLogFile, ensureStateDir, writeJobFileUnlocked /*, index writer */ } from "../../plugins/antigravity/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "plugins/antigravity/bin/antigravity.mjs");
const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), "agy-e2e-"));

// seedJob(cwd, id, status): write a job (NO pid for running jobs) + its index entry,
// mirroring the shape in tests/antigravity/job-control-snapshot.test.mjs.
// flip(cwd, id, status): rewrite the job file with a terminal status.

test("e2e: logs --follow keeps multibyte UTF-8 intact when a codepoint is split across two polls", async () => {
  const cwd = ws();
  const id = "agy-utf8-1";
  ensureStateDir(cwd);
  const logFile = resolveJobLogFile(cwd, id);
  fs.writeFileSync(logFile, ""); // empty; bytes arrive DURING the follow
  seedJob(cwd, id, "running");   // running, no pid

  const child = spawn(process.execPath, [BIN, "logs", id, "--follow", "--timeout-ms", "8000", "--cwd", cwd], { encoding: "utf8" });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });

  const e = Buffer.from("é", "utf8"); // 0xC3 0xA9
  await delay(300);
  fs.appendFileSync(logFile, e.subarray(0, 1)); // first byte only
  await delay(1300);                            // > POLL_MS so it is read alone
  fs.appendFileSync(logFile, e.subarray(1));     // second byte in the NEXT poll
  fs.appendFileSync(logFile, "X\n");
  await delay(1300);
  flip(cwd, id, "completed");                    // let the follow loop exit

  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  assert.match(out, /éX/);
  assert.ok(!out.includes("�"), "no UTF-8 replacement char");
});

test("e2e: cancel with multiple active jobs resolves a unique substring", () => {
  const cwd = ws();
  seedJob(cwd, "agy-c1-111", "running");
  seedJob(cwd, "agy-d2-222", "running");
  const res = runCli(cwd, ["cancel", "c1", "--cwd", cwd, "--json"]);
  assert.notEqual(res.status, 1, res.stderr);
  assert.doesNotMatch(res.stderr ?? "", /full id required/);
});

test("e2e: cancel with multiple active jobs resolves a 1-based index", () => {
  const cwd = ws();
  seedJob(cwd, "agy-c1-111", "running");
  seedJob(cwd, "agy-d2-222", "running");
  const res = runCli(cwd, ["cancel", "1", "--cwd", cwd, "--json"]);
  assert.notEqual(res.status, 1, res.stderr);
  assert.doesNotMatch(res.stderr ?? "", /full id required/);
});

test("e2e: cancel with multiple active jobs and no reference refuses to guess", () => {
  const cwd = ws();
  seedJob(cwd, "agy-c1-111", "running");
  seedJob(cwd, "agy-d2-222", "running");
  const res = runCli(cwd, ["cancel", "--cwd", cwd]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr ?? "", /Multiple active antigravity jobs/);
});

// runCli = synchronous spawnSync wrapper (import { spawnSync } separately for the cancel tests).
```

Implement `seedJob`/`flip`/`runCli` in this file. `seedJob` writes the per-job file (`writeJobFileUnlocked`) and the index entry the same way `job-control-snapshot.test.mjs` does; running jobs carry NO `pid`. `flip` rewrites the job file with `status:"completed"` + `completedAt`.

- [ ] **Step 2: Run** — `node --test --experimental-test-module-mocks tests/antigravity/e2e-cli.test.mjs` → Expected: PASS (after T3/T4).

- [ ] **Step 3: Commit**

```bash
git add tests/antigravity/e2e-cli.test.mjs
git commit -m "test(antigravity): e2e for UTF-8 logs --follow and multi-active cancel matching

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Fleet e2e + wire `test:e2e` into the suite

**Goal:** e2e for the fleet status board (T6) driving the real `fleet-status.mjs` against fake engine status scripts; then make `test:e2e` run every engine's e2e file and add an e2e leg to `npm test`.

**Files:**
- Create: `tests/fleet/e2e-cli.test.mjs`
- Modify: `package.json` (`test:e2e`, `test`)

- [ ] **Step 1: Write the fleet e2e** — point `fleet-status.mjs` at a temp `pluginRoot` containing fake engine status scripts that print a chosen JSON, and run the real CLI as a subprocess.

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/fleet/scripts/fleet-status.mjs");

// Build a fake plugin tree so fleet-status's relative engine-script paths resolve
// to scripts we control. fleet-status resolves "../codex/scripts/codex-companion.mjs"
// from its own dir, so place a fake fleet dir alongside fake sibling plugins.
function fakeTree(codexJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-"));
  const mk = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  mk(path.join(root, "codex/scripts/codex-companion.mjs"), `console.log(${JSON.stringify(codexJson)});`);
  mk(path.join(root, "antigravity/scripts/commands/status.mjs"), `console.log(JSON.stringify({running:[],recent:[]}));`);
  mk(path.join(root, "delegate/scripts/delegate-companion.mjs"), `console.log(JSON.stringify([]));`);
  // fleet-status.mjs is invoked from the real location but pluginRoot is derived
  // from its own dir; pass --cwd and rely on default sibling resolution by copying
  // the real script into root/fleet/scripts and invoking THAT copy.
  fs.mkdirSync(path.join(root, "fleet/scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "fleet/scripts/fleet-status.mjs"));
  return root;
}

test("e2e: unrecognized codex status JSON shows an 'unknown' row, not idle", () => {
  const root = fakeTree(JSON.stringify({ unexpected: true }));
  const script = path.join(root, "fleet/scripts/fleet-status.mjs");
  const res = spawnSync(process.execPath, [script, "--only", "codex", "--json"], { encoding: "utf8", timeout: 15000 });
  assert.equal(res.status, 0, res.stderr);
  const row = JSON.parse(res.stdout).rows.find((r) => r.engine === "codex");
  assert.equal(row.status, "unknown");
});

test("e2e: a running codex job yields a logs action but not a redundant attach action", () => {
  const root = fakeTree(JSON.stringify({ running: [{ id: "codex-1", status: "running" }], recent: [] }));
  const script = path.join(root, "fleet/scripts/fleet-status.mjs");
  const res = spawnSync(process.execPath, [script, "--only", "codex", "--json"], { encoding: "utf8", timeout: 15000 });
  const actions = JSON.parse(res.stdout).rows.find((r) => r.engine === "codex").actions;
  assert.ok(actions.includes("/codex:logs codex-1"));
  assert.ok(!actions.includes("/codex:attach codex-1"));
});
```

(If copying the script breaks its relative resolution, instead invoke the real `SCRIPT` with `--cwd root` and confirm `pluginRootFromModule()` still anchors to the real tree — then prefer driving via `pluginRoot` in a unit test and keep the e2e to the unknown-shape + dedupe assertions through the copied script. The implementer picks whichever resolves cleanly; the behavioral assertions are the contract.)

- [ ] **Step 2: Wire the suite** — edit `package.json`:

```json
    "test": "npm run test:structure && npm run test:shared && npm run test:delegate && npm run test:antigravity && npm run test:codex && npm run test:fleet && npm run test:e2e",
    "test:e2e": "node --test tests/delegate/e2e-cli.test.mjs tests/codex/e2e-cli.test.mjs tests/antigravity/e2e-cli.test.mjs tests/fleet/e2e-cli.test.mjs",
```

- [ ] **Step 3: Run** — `npm run test:e2e` then `npm test` → Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/fleet/e2e-cli.test.mjs package.json
git commit -m "test(fleet): e2e for status board; run all engine e2e suites in npm test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Part C — DEFERRED to a follow-up PR (codex gate ruling)

> **Codex gate ruled Part C over-reach for this PR.** Do NOT execute C1–C4 in this branch — land the correctness fixes (Part A) and the regression e2e (Part B) first. C3 (async `fleet-status` refactor) is the riskiest and is explicitly deferred. The tasks below are kept as the spec for that follow-up PR.

These are the review's quality findings. They reduce drift/latency but touch more surface and carry refactor risk. When picked up later, keep each behind its own task + green suite.

### Task C1: Extract antigravity poll/terminal helper

`wait.mjs` and `logs.mjs` duplicate `parseTimeoutMs`, `sleep`, `POLL_MS`, `TERMINAL_STATUSES`, and a `waitForTerminal` loop (logs has two copies). Create `plugins/antigravity/scripts/lib/poll.mjs` exporting `sleep`, `parseTimeoutMs(value, defaultMs)`, `TERMINAL_STATUSES` (re-export from `state.mjs` if it already defines one — verify), and `waitForTerminal(cwd, jobId, timeoutMs, deps)`. Rewire both commands to import it. Tests: existing `tests/antigravity/commands.test.mjs` + `wait`/`logs` tests must stay green; add one unit test per export. **Do this AFTER Task 3** (T3 changes `followLog`’s byte handling) to avoid churn.

### Task C2: Extract fleet shared CLI-args lib

`normalizeArgv` + `splitRawArgumentString` are byte-duplicated between `fleet-status.mjs` and `fleet-doctor.mjs`; `parseArgs`/`resolveEngines`/`UsageError` are near-duplicated and already drifting. Create `plugins/fleet/scripts/lib/cli-args.mjs` (fleet-local; importing a sibling plugin's args is forbidden by IRONCLAD, a fleet-local lib is fine) and rewire both. Tests: `tests/fleet/*.test.mjs` stay green; add a unit test for the shared module. **Do this AFTER Task 6.**

### Task C3: Concurrent engine spawn in fleet-status

`runStatus` runs three `spawnSync` calls sequentially (worst case 3×10s). Convert to concurrent child processes (async `spawn` collecting stdout, `await Promise.all`) so latency is the slowest engine, not the sum. Keep `runStatus` injectable (`spawnImpl`) and the output identical. Tests: existing fleet-status tests stay green (adapt the fake to the async seam); add a test asserting all engines are queried.

### Task C4: Realpath-normalized entry guard for fleet scripts

`fleet-status.mjs` and `fleet-doctor.mjs` use the fragile `import.meta.url === \`file://${process.argv[1]}\`` guard — the exact form hardened away in antigravity `cli-entry.mjs` this PR. Replace both with a realpath-normalized compare (a small fleet-local `isMainModule(importMetaUrl)` helper, mirroring `normalizeMainPath`). Tests: add a structure/behavior test that the script self-invokes via a symlinked path.

---

## Process note (not a code task)

- The already-pushed `d107fd7` lacks the required `Co-Authored-By` trailer. Do NOT rewrite that pushed commit; ensure every NEW commit in this plan carries the trailer (each Step-5 above does).

---

## Final Verification (gate for Task #4 in the session task list)

- [ ] `npm test` → all suites green (was 819; new tests add to that count).
- [ ] `npm run test:e2e` → all engine e2e suites green.
- [ ] `git diff --check` → no whitespace errors.
- [ ] `node --test tests/codex/*.test.mjs` re-run once if `runtime.test.mjs` flakes (known-flaky per AGENTS.md; not a regression).
- [ ] Confirm the diff contains only this plan's files; no `shared/lib/` change; no sibling-plugin file touched outside the lifecycle feature surface.

## Self-Review (done by the planner)

- **Coverage:** every review finding maps to a task — codex wait exit codes (T1), codex falsy-zero (T2), antigravity UTF-8 follow (T3), antigravity cancel matching (T4), args boolean coercion (T5), fleet unknown-shape + action dedupe (T6), codex logs no-id (T7); e2e covering each user-facing bug (T8/T9/T10); dedup/altitude/efficiency findings (C1–C4); commit-trailer convention (process note).
- **Type/symbol consistency:** `waitExitCode`/`coerceMs`/`waitForSingleJobSnapshot` (codex), `decodeStreamForTest`/`readFullLogBytes`/`readAppendedBytes` (antigravity logs), `parseBooleanFlagValue` (args), `extractJobs -> {jobs, recognized}` used consistently by `normalizeStatus` (fleet).
- **Known unknowns flagged for the implementer to verify before editing:** exact antigravity `state.mjs` writer signatures used in T9 seeding; whether `readJobLog` is already imported in codex-companion (T7); whether `tests/fleet/fleet-status.test.mjs` already has a `makeFakeSpawn` helper (T6); the fleet-status fake-tree resolution approach (T10).
