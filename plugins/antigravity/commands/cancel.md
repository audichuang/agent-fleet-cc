---
description: Cancel an active background Antigravity job in this repository
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/cancel.mjs" $ARGUMENTS`

Output rules:
- Present the cancel report exactly as returned.
- Do not summarize.

Auth note:
- Cancelling a job that is stuck on `auth_required` is safe; the job will be marked cancelled. Run `/antigravity:setup` before retrying.
