---
description: One-time Antigravity (agy) setup — verify the CLI is installed and complete the OAuth flow
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/setup.mjs" $ARGUMENTS`

What it does:
- Verifies `agy` is on PATH (prints the install URL if not).
- Triggers an authenticated probe so the OAuth URL surfaces; complete the flow in your browser if prompted. Idempotent once the token cache is valid.

Output rules:
- Present the command output verbatim. If an OAuth URL appears, surface it so the user can open it.
