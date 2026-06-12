---
description: Show the stored final output for a finished Antigravity job in this repository
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/result.mjs" $ARGUMENTS`

Output rules:
- Present the full command output to the user.
- Do not paraphrase, summarize, condense, or add commentary.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Ask the user which issues, if any, they want fixed before touching a single file.

Auth note:
- If the stored result mentions an OAuth URL or "not authenticated", run `/antigravity:setup` to complete the OAuth flow, then re-dispatch the original request.
