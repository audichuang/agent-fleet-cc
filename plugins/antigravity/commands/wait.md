---
description: Wait for an Antigravity background job to finish
argument-hint: '<job-id> [--timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/wait.mjs" "$ARGUMENTS"`

Output rules:
- Present the command output exactly as returned.
- Do not summarize.
