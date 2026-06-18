# Fleet P0/P1 Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** complete P0/P1 lifecycle, discoverability, and read-only fleet operations for `agent-fleet-cc`.

**Architecture:** Keep native engine runtimes authoritative and unify only the command/control surface. Antigravity gets explicit lifecycle commands, Codex gets missing slash discoverability plus wait/logs aliases, Delegate exposes existing companion verbs, and Fleet gets non-TUI doctor/status entry points.

**Tech Stack:** Node.js ESM, `node:test`, Claude Code slash-command Markdown, existing engine companion scripts.

---

## File Structure

- Modify: `plugins/antigravity/scripts/lib/cli-entry.mjs`  
  Make direct-entry detection robust against realpath/symlink differences.
- Modify: `plugins/antigravity/scripts/lib/job-helpers.mjs`  
  Pass an explicit workspace root to background workers.
- Modify: `plugins/antigravity/scripts/commands/_worker.mjs`  
  Read the explicit workspace root before falling back to `process.cwd()`.
- Modify: `plugins/antigravity/scripts/lib/job-control.mjs`  
  Require a job id when multiple active jobs exist.
- Create: `plugins/antigravity/scripts/commands/wait.mjs`  
  Dedicated `wait` command wrapping the existing status wait behavior.
- Create: `plugins/antigravity/scripts/commands/logs.mjs`  
  Print or follow persisted Antigravity job logs.
- Create: `plugins/antigravity/commands/wait.md`
- Create: `plugins/antigravity/commands/logs.md`
- Modify: `plugins/codex/scripts/codex-companion.mjs`  
  Add `wait` and `logs` subcommands as machine-friendly aliases.
- Create: `plugins/codex/commands/task.md`
- Create: `plugins/codex/commands/wait.md`
- Create: `plugins/codex/commands/logs.md`
- Create: `plugins/delegate/commands/wait.md`
- Create: `plugins/delegate/commands/logs.md`
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs`  
  Add backward-compatible `category`, `fixHint`, and `fixCommand` metadata.
- Create: `plugins/fleet/scripts/fleet-status.mjs`  
  Read-only non-TUI fleet status board.
- Create: `plugins/fleet/commands/doctor.md`
- Create: `plugins/fleet/commands/status.md`
- Modify: `tests/antigravity/*.test.mjs`, `tests/codex/*.test.mjs`, `tests/delegate/*.test.mjs`, `tests/fleet/*.test.mjs`  
  Add regression and command-structure coverage.
- Modify: `README.md`  
  Document the new P0/P1 lifecycle surface.

### Task 1: Repair Baseline Antigravity Failures

**Files:**
- Modify: `plugins/antigravity/scripts/lib/cli-entry.mjs`
- Modify: `plugins/antigravity/scripts/lib/job-helpers.mjs`
- Modify: `plugins/antigravity/scripts/commands/_worker.mjs`
- Test: `tests/antigravity/cli-entry.test.mjs`
- Test: `tests/antigravity/background-integration.test.mjs`

- [ ] **Step 1: Verify existing red tests**

Run:

```bash
rtk npm run test:antigravity -- --test-name-pattern='runAsMain|background job end-to-end'
```

Expected: the current branch fails the `runAsMain` exit-code tests and the background worker finalization test.

- [ ] **Step 2: Harden `runAsMain` entry detection**

Replace URL-string equality with normalized file path comparison:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sameEntryFile(moduleUrl, entryPath) {
  if (!entryPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const normalize = (value) => {
    const resolved = path.resolve(value);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  return normalize(modulePath) === normalize(entryPath);
}
```

Use `sameEntryFile(moduleUrl, process.argv[1])` inside `runAsMain`.

- [ ] **Step 3: Pass explicit workspace root to Antigravity worker**

In `startBackgroundJob`, add an environment variable:

```js
env: {
  ...env,
  ANTIGRAVITY_WORKSPACE_ROOT: workspaceRoot,
  [SESSION_ID_ENV]: env[SESSION_ID_ENV] ?? "",
}
```

Apply the same explicit env to the watchdog spawn.

- [ ] **Step 4: Read explicit workspace root in `_worker.mjs`**

Use:

```js
const workspaceRoot = process.env.ANTIGRAVITY_WORKSPACE_ROOT
  ? resolveWorkspaceRoot(process.env.ANTIGRAVITY_WORKSPACE_ROOT)
  : resolveWorkspaceRoot(process.cwd());
```

This keeps production behavior compatible while making detached workers independent from cwd realpath drift.

- [ ] **Step 5: Verify green**

Run:

```bash
rtk npm run test:antigravity -- --test-name-pattern='runAsMain|background job end-to-end'
```

Expected: the targeted Antigravity regression tests pass.

### Task 2: Add Antigravity Wait/Logs and Safe Cancel

**Files:**
- Modify: `plugins/antigravity/scripts/lib/job-control.mjs`
- Create: `plugins/antigravity/scripts/commands/wait.mjs`
- Create: `plugins/antigravity/scripts/commands/logs.mjs`
- Create: `plugins/antigravity/commands/wait.md`
- Create: `plugins/antigravity/commands/logs.md`
- Test: `tests/antigravity/job-control.test.mjs`
- Test: `tests/antigravity/commands.test.mjs`
- Test: `tests/antigravity/command-selfinvoke.test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests proving:

```js
assert.throws(
  () => resolveCancelableJob(cwd, null),
  /Multiple active antigravity jobs/
);
```

when two active jobs exist, and proving `wait.mjs` / `logs.mjs` self-invoke from the command path.

- [ ] **Step 2: Make cancel selection safe**

In `resolveCancelableJob`, before `matchJobReference`:

```js
if (!reference && activeJobs.length > 1) {
  const ids = activeJobs.map((j) => j.id).join(", ");
  throw new Error(`Multiple active antigravity jobs; pass a job id. Active jobs: ${ids}`);
}
```

Allow no-reference cancel only when exactly one active job exists.

- [ ] **Step 3: Implement `wait.mjs`**

Create a command that parses `<job-id>`, `--timeout-ms`, `--json`, and `--cwd`, then delegates to the existing status wait path. Exit `0` on completed, `1` on failed/missing, `2` on cancelled, and `10` when the timeout expires before terminal state.

- [ ] **Step 4: Implement `logs.mjs`**

Create a command that parses `<job-id>`, `--follow`, `--json`, and `--cwd`. Without `--follow`, print the current persisted job log. With `--follow`, poll the job log until terminal state and print appended bytes. For `--json`, emit `{ engine:"antigravity", jobId, status, log }`.

- [ ] **Step 5: Add slash command wrappers**

`plugins/antigravity/commands/wait.md` runs:

```markdown
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/wait.mjs" "$ARGUMENTS"`
```

`plugins/antigravity/commands/logs.md` runs:

```markdown
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/logs.mjs" "$ARGUMENTS"`
```

- [ ] **Step 6: Verify**

Run:

```bash
rtk npm run test:antigravity
```

Expected: all Antigravity tests pass.

### Task 3: Add Codex Task/Wait/Logs Discoverability

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Create: `plugins/codex/commands/task.md`
- Create: `plugins/codex/commands/wait.md`
- Create: `plugins/codex/commands/logs.md`
- Test: `tests/codex/commands.test.mjs`
- Test: `tests/codex/attach-tail.test.mjs`

- [ ] **Step 1: Write failing command-surface tests**

Add assertions that the Codex plugin ships `task.md`, `wait.md`, and `logs.md`, and that each forwards to `codex-companion.mjs`.

- [ ] **Step 2: Add companion aliases**

In `main()`, add:

```js
case "wait":
  await handleWait(argv);
  break;
case "logs":
  await handleLogs(argv);
  break;
```

Implement `handleWait(argv)` by requiring a job id and calling the same wait path as `status <job> --wait`. Implement `handleLogs(argv)` by delegating to `handleAttach(argv)` so Codex keeps native live-log behavior.

- [ ] **Step 3: Add slash wrappers**

`task.md` calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "$ARGUMENTS"`.  
`wait.md` calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait "$ARGUMENTS"`.  
`logs.md` calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" logs "$ARGUMENTS"`.

- [ ] **Step 4: Verify**

Run:

```bash
rtk npm run test:codex
```

Expected: all Codex tests pass.

### Task 4: Expose Delegate Wait/Logs Slash Commands

**Files:**
- Create: `plugins/delegate/commands/wait.md`
- Create: `plugins/delegate/commands/logs.md`
- Test: `tests/delegate/commands.test.mjs`

- [ ] **Step 1: Write failing tests**

Extend the delegate command structure test so `wait.md` and `logs.md` must exist and forward to `delegate-companion.mjs wait` / `delegate-companion.mjs logs`.

- [ ] **Step 2: Add wrappers**

`wait.md`:

```markdown
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" wait "$ARGUMENTS"`
```

`logs.md`:

```markdown
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" logs "$ARGUMENTS"`
```

- [ ] **Step 3: Verify**

Run:

```bash
rtk npm run test:delegate
```

Expected: all Delegate tests pass.

### Task 5: Add Fleet Doctor/Status Entry Points

**Files:**
- Modify: `plugins/fleet/scripts/fleet-doctor.mjs`
- Create: `plugins/fleet/scripts/fleet-status.mjs`
- Create: `plugins/fleet/commands/doctor.md`
- Create: `plugins/fleet/commands/status.md`
- Test: `tests/fleet/fleet-doctor.test.mjs`
- Create: `tests/fleet/fleet-status.test.mjs`
- Modify: `tests/fleet/plugin-structure.test.mjs`

- [ ] **Step 1: Write failing doctor metadata tests**

Assert every engine report contains:

```js
assert.equal(typeof engine.category, "string");
assert.equal(typeof engine.fixHint, "string");
assert.ok(engine.fixCommand === null || typeof engine.fixCommand === "string");
```

Existing fields such as `deepFixCommand` must remain.

- [ ] **Step 2: Add doctor metadata**

For every `check*` return object, add:

```js
category: "core",
fixCommand: deepFixCommandValueOrNull,
fixHint: "Plain-language next action."
```

Use `"optional"` only for future non-blocking checks; all current binary/profile probes are core.

- [ ] **Step 3: Implement `fleet-status.mjs`**

Export `runStatus(argv, deps)` with injectable `spawnSyncImpl`, `cwd`, and `pluginRoot`. For each engine, run the engine status command with `--json`, parse the result, and normalize rows:

```js
{
  engine,
  available,
  active,
  recent,
  status,
  summary,
  actions
}
```

Default command paths:

```js
codex: "../codex/scripts/codex-companion.mjs status --json"
antigravity: "../antigravity/scripts/commands/status.mjs --json"
delegate: "../delegate/scripts/delegate-companion.mjs status --json"
```

Missing scripts or bad JSON become unavailable rows.

- [ ] **Step 4: Add slash wrappers**

`doctor.md` runs `fleet-doctor.mjs`.  
`status.md` runs `fleet-status.mjs`.

- [ ] **Step 5: Verify**

Run:

```bash
rtk npm run test:fleet
```

Expected: all Fleet tests pass.

### Task 6: Documentation, Full Test, and Multi-Agent Verification

**Files:**
- Modify: `README.md`
- Test: all suites

- [ ] **Step 1: Update README**

Document:

```text
/fleet:doctor
/fleet:status
/codex:task
/codex:wait
/codex:logs
/antigravity:wait
/antigravity:logs
/delegate:wait
/delegate:logs
```

Also state that Fleet status is a read-only CLI board, not a full TUI.

- [ ] **Step 2: Run full verification**

Run:

```bash
rtk npm test
```

Expected: all suites pass.

- [ ] **Step 3: Dispatch multi-agent validation**

Use reviewer subagents:

1. Spec compliance reviewer: verify P0/P1 requirements from this plan against the current diff.
2. Code quality reviewer: inspect lifecycle safety, command wrappers, JSON compatibility, and test coverage.
3. Native-runtime reviewer: verify no Codex/Antigravity Anthropic translation path was introduced.

- [ ] **Step 4: Fix reviewer findings**

Fix every critical or important finding, then rerun the targeted failing tests and `rtk npm test`.

- [ ] **Step 5: Final completion audit**

Check:

```bash
rtk git status --short
rtk git branch --show-current
rtk npm test
```

Expected: branch is `feat/p0-p1-fleet-lifecycle`, tests pass, and the diff contains only this feature's files.
