---
description: Show or follow a persisted Antigravity job log
argument-hint: '<job-id> [--follow] [--timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/logs.mjs" "$ARGUMENTS"`

Output rules:
- Present the job log exactly as returned.
- Do not summarize.
