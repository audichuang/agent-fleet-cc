# Follow-ups: codex attach UTF-8 + Part C refactors — Implementation Plan

> Codex implements each unit; Opus verifies. ultracode workflow, verify-as-you-go.

**Goal:** land the deferred follow-ups as four independently-verified units. FU1 is
a correctness robustness fix; C1/C2/C4 are behavior-preserving dedup/consistency
refactors; C3 is a behavior-preserving concurrency change (riskiest, done last).

**Global constraints (every unit):**
- Zero-dependency pure ESM `.mjs`; `node:string_decoder` is a built-in (allowed). No new npm deps.
- Tests: `node:test` + `node:assert/strict`, hermetic.
- **Refactors must be behavior-preserving** — the existing suite is the contract; it must stay green with no assertion weakened. Add focused unit tests for any new shared module.
- Do NOT touch `shared/lib/` (no sync-shared obligation).
- Branch `feat/p0-p1-fleet-lifecycle`. Cross-plugin is intended (continuation of the lifecycle work). Each unit commits with trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Full gate after each unit: `npm test` (865+ green) AND `npm run test:e2e`.

---

## Unit FU1 — codex live attach is UTF-8-safe across poll boundaries

**Bug:** in `plugins/codex/scripts/codex-companion.mjs`, `handleAttach`'s default
`readChunk` (~line 1239) does `buf.subarray(offset).toString("utf8")` every poll
and advances `offset` to `buf.length`. If a multibyte codepoint straddles the
byte boundary captured at one poll, it decodes as `�` on both sides — the same
class of bug already fixed in antigravity `logs.mjs` (persistent `StringDecoder`).

**Files:** `plugins/codex/scripts/codex-companion.mjs`; test `tests/codex/attach-tail.test.mjs`.

**Change:** make the default `readChunk` decode through a single persistent
`StringDecoder("utf8")` carried across calls, so a partial trailing multibyte
sequence is buffered until the next poll completes it. Extract the byte-reader +
decoder into a small named factory (e.g. `makeUtf8LogReader(logFile)` returning a
`readChunk` closure) so it is unit-testable, and wire `handleAttach` to use it.
Mirror antigravity's approach. The `streamAttach` loop (~1154) is unchanged.

**Test (TDD):** add a test that drives the reader over a file written in two
parts that split a multibyte char (e.g. `é` = `C3 A9`) across reads, asserting the
reassembled output equals the intact string and contains no `�`. Prove it
fails on the old per-chunk decode (revert the one line, watch it fail, restore).
Existing `attach-tail.test.mjs` cases must stay green.

---

## Unit C1 — extract antigravity poll/terminal helper

**Problem:** `plugins/antigravity/scripts/commands/wait.mjs` and `logs.mjs` each
duplicate `parseTimeoutMs`, `sleep`, `POLL_MS`, `TERMINAL_STATUSES`, and a
`waitForTerminal` poll loop (logs has two copies). Drift risk: a change to the
terminal-status set or poll cadence must be made in several places.

**Files:** create `plugins/antigravity/scripts/lib/poll.mjs`; rewire
`commands/wait.mjs` + `commands/logs.mjs`; test `tests/antigravity/*`.

**Change:** `poll.mjs` exports `sleep(ms)`, `POLL_MS`, `TERMINAL_STATUSES`,
`parseTimeoutMs(value, defaultMs)`, and `waitForTerminal(cwd, jobId, timeoutMs, deps?)`
(the shared snapshot-poll-until-terminal loop). If antigravity `state.mjs` already
exports a terminal-status set, import/re-export it there rather than minting a
third copy — verify first. Rewire both commands to import from `poll.mjs`; in
`logs.mjs`, the JSON-follow path uses the shared `waitForTerminal`, while
`followLog` keeps its byte-streaming loop but pulls `sleep`/`POLL_MS`/
`TERMINAL_STATUSES`/`parseTimeoutMs` from the shared module (no second copy).

**Behavior-preserving.** Add a unit test for `poll.mjs` (parseTimeoutMs valid/
invalid/zero, TERMINAL_STATUSES membership). The full antigravity suite
(`node --test --experimental-test-module-mocks tests/antigravity/*.test.mjs`)
plus the antigravity e2e must stay green.

---

## Unit C2+C4 — fleet shared CLI-args lib + realpath entry guard

**Problem (C2):** `plugins/fleet/scripts/fleet-status.mjs` and `fleet-doctor.mjs`
byte-duplicate `normalizeArgv` + `splitRawArgumentString` (~57-line tokenizer),
`UsageError`, `resolveEngines`, and the `CANONICAL` list, and have begun to drift.
**Problem (C4):** both end with the fragile `if (import.meta.url === \`file://${process.argv[1]}\`)`
entry guard — the exact form hardened away in antigravity `cli-entry.mjs`
(realpath-normalized). Symlinked invocation makes `main()` silently no-op.

**Files:** create `plugins/fleet/scripts/lib/cli-args.mjs`; rewire
`fleet-status.mjs` + `fleet-doctor.mjs`; test `tests/fleet/*`.

**Change:** `cli-args.mjs` exports the clearly-identical pieces —
`splitRawArgumentString`, `normalizeArgv`, `UsageError`, `resolveEngines(only, canonical)`,
`CANONICAL` — plus `isMainModule(importMetaUrl)` using realpath normalization
(mirror antigravity `normalizeMainPath`: `fs.realpathSync.native` with a fallback).
Rewire both fleet scripts to import these and replace their entry-guard line with
`if (isMainModule(import.meta.url)) { main(); }`. Each script keeps its own
flag-specific `parseArgs` (fleet-status has `--cwd`, fleet-doctor does not) — only
the genuinely shared, identical code moves. Do NOT import a sibling plugin's args
(IRONCLAD) — this is a fleet-local lib.

**Behavior-preserving.** Add unit tests for `cli-args.mjs` (tokenizer quote/escape
cases; `isMainModule` true for the real path, false for a different path). Full
fleet suite + fleet e2e stay green.

---

## Unit C3 — fleet-status queries engines concurrently (riskiest, last)

**Problem:** `runStatus` runs the three engine status commands sequentially with
synchronous `spawnSync` (`engines.map(runEngineStatus)`), each with a 10s timeout
→ worst case ~30s wall time. They are independent; concurrency caps it at ~10s.

**Files:** `plugins/fleet/scripts/fleet-status.mjs`; tests `tests/fleet/fleet-status.test.mjs` (+ e2e if it drives runStatus).

**Change:** make `runEngineStatus` and `runStatus` async; run the three engine
probes concurrently with `await Promise.all`. Replace the synchronous
`spawnSyncImpl` seam with an injectable async runner (e.g. `runEngineImpl({script,args,cwd}) -> {status,stdout,stderr,error}`) that defaults to a Promise wrapper around `child_process.spawn` collecting stdout/stderr with the 10s timeout; tests inject a fake async runner. `main()` becomes `await runStatus(...)`. **Output must be byte-for-byte identical** (same rows, same order = `CANONICAL` order, same `--json` shape, same human table). Update every `tests/fleet/fleet-status.test.mjs` call site to `await runStatus(...)` and adapt the fake to the async seam.

**Behavior-preserving except latency.** This is the only unit that changes a
function signature (sync→async); the verifier must confirm the full suite + e2e
are green and the `--json`/human output is unchanged. If preserving the exact
output/ordering proves to require risky surgery, STOP and report rather than
weakening any test.

---

## Final verification (controller)
- [ ] `npm test` green; `npm run test:e2e` green.
- [ ] No `shared/lib/` change; diff scoped to the named files per unit.
- [ ] Each unit's commit carries the trailer.
- [ ] Refactors changed no observable behavior (suite green, no assertion weakened); FU1 test proven non-vacuous; C3 output unchanged.
