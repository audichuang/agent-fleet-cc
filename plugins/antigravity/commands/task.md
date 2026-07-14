---
description: Free-form Antigravity task with state tracking (background by default)
argument-hint: '[--wait] [--foreground] [--continue] [--conversation <id>] [--add-dir <path>] [--json] [--apply] [--dangerously-skip-permissions] <prompt>'
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
- `--apply` let agy edit files in the repo (binds the cwd as the project and auto-applies edits). Off by default: without it agy does not edit your repo and returns text/a proposed patch (not a hard read-only guard — agy may still write to its own `~/.gemini` scratch).
- `--dangerously-skip-permissions` auto-approve every tool call, not just edits. Only takes effect with `--apply`.

Auth note:
- If output mentions an OAuth URL or "not authenticated", run `/antigravity:setup` to complete the OAuth flow, then retry.

Output rules:
- Present the command output verbatim — do not paraphrase or summarize.
- After a background dispatch, mention the returned job id so the user can poll with `/antigravity:status <id>`.
