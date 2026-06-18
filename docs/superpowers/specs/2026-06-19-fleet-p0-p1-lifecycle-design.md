# Fleet P0/P1 Lifecycle Design

**Goal:** finish the P0/P1 lifecycle and observability work for `agent-fleet-cc` without adding a full TUI or a protocol-translation layer.

**Approved direction:** preserve each engine's native runtime. Codex stays on `codex app-server`, Antigravity stays on `agy --print`, and Delegate stays on `claude -p` through profiles. Fleet only unifies the outer control plane: doctor, status, wait, logs, result, cancel, JSON envelopes, and command discoverability.

## Requirements

1. Keep native engine semantics.
   - Do not translate Codex or Antigravity model output into Anthropic `tool_use` or transcript formats.
   - Codex tool/file/command visibility remains native through Codex logs and attach-style streaming.
   - Antigravity must not invent tool events; `agy --print` only exposes stdout/stderr/final status.
   - Delegate continues to expose shared-runtime events from its existing job store.

2. P0 lifecycle consistency.
   - Every engine must expose discoverable `status`, `result`, `cancel`, `wait`, and `logs` commands at the slash-command layer where the engine supports them.
   - `cancel` must be safe: when multiple active jobs exist, the command must require a job id instead of silently choosing the newest active job.
   - `--background` means the command returns a job id that can be inspected by `status`, `result`, `cancel`, `wait`, and `logs`.
   - Existing baseline test failures must be fixed before the branch can be considered complete.

3. P1 discoverability and fleet operations.
   - Add `/codex:task` because the companion already supports `task` but the slash surface does not expose it.
   - Add slash wrappers for Delegate `wait` and `logs`; the companion already implements both.
   - Add Antigravity `wait` and `logs` commands. Logs may be limited to persisted stdout/job log output because `agy --print` has no live tool stream.
   - Add `/fleet:doctor` as a direct read-only diagnostic entry point.
   - Add `/fleet:status` as a read-only board that shells out to each installed engine's own status command and renders a compact non-TUI table with follow-up actions.

4. Doctor and status output.
   - `fleet-doctor` must remain network-free and must not verify auth.
   - Doctor JSON should keep backward compatibility with the existing fields and add actionable fix metadata without breaking current tests.
   - Fleet status should tolerate missing engine plugins or malformed output and render those as unavailable rows, not crashes.

5. Testing.
   - Use test-first changes for new behavior and regression fixes.
   - Add focused tests for every new command surface and safety rule.
   - Run targeted suites during development and the full `npm test` before claiming completion.

## Architecture

`shared/lib` remains the common runtime foundation for Delegate and future process-style engines. This P0/P1 branch does not force Codex into `ProcessAdapter`; Codex needs app-server/session semantics and should only share the outer job-control contract later.

Antigravity remains on its current runtime for this branch, but its lifecycle surface will be aligned with Delegate and Codex by adding explicit `wait` and `logs` commands and making cancel selection safer. A later migration can move Antigravity onto `shared/lib ProcessAdapter`.

Fleet status is intentionally a CLI board, not a full TUI. It invokes each engine's own read-only status command with `--json`, normalizes a minimal row shape, and prints action hints such as `/codex:attach <id>`, `/antigravity:logs <id>`, or `/delegate:logs <id> --follow`.

## Non-Goals

- No full terminal UI.
- No Anthropic protocol bridge for Codex or Antigravity.
- No fake tool events for Antigravity.
- No network auth checks in fleet doctor/status.
- No migration of Codex onto `ProcessAdapter` in this branch.

## Self-Review

- No placeholders remain.
- The spec covers P0 lifecycle, P1 discoverability, no-TUI constraint, native-runtime constraint, and complete-test requirement.
- The scope is large but still one branch because the command changes share one observable contract.
