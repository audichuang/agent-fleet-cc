---
description: Show active and recent Antigravity jobs for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/status.mjs" $ARGUMENTS`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, Health, Last Progress, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
- Preserve health status, health message, recommended action, session ID, last heartbeat/progress/diagnostic timestamps, and any Recent Progress section.

Auth note:
- If `OAuth URL:` appears in the output, surface it prominently and tell the user to run `/antigravity:setup` to complete authentication.
