---
description: Free-form Antigravity task with state tracking (background by default)
argument-hint: '[--wait] [--foreground] [--continue] [--conversation <id>] [--add-dir <path>] [--json] <prompt>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/task.mjs" $ARGUMENTS`

Flags:
- Default execution is `--background`. A job id is returned immediately.
- `--wait` block until the worker finishes and stream its final output.
- `--foreground` run inline instead of forking a worker.
- `--continue` resume the most recent agy conversation.
- `--conversation <id>` resume a specific conversation.
- `--add-dir <path>` extra workspace directory (repeatable).
- `--json` emit structured JSON.

Auth note:
- If output mentions an OAuth URL or "not authenticated", run `/antigravity:setup` to complete the OAuth flow, then retry.

Output rules:
- Present the command output verbatim — do not paraphrase or summarize.
- After a background dispatch, mention the returned job id so the user can poll with `/antigravity:status <id>`.
