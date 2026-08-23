---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`

**After presenting review findings, STOP.** Do not make code changes, do not fix anything, and
ask the user which issues (if any) they want fixed before touching a file — auto-applying fixes
from a review is forbidden even when the fix looks obvious. `/codex:review` and
`/codex:adversarial-review` carry this rule inline; this verb surfaces the same findings for a
stored job and was missing it. The fuller presentation contract (evidence boundaries, failed-run
handling, never substituting a Claude-side answer when Codex was not actually invoked) is the
`codex-result-handling` skill — consult it via the `Skill` tool when relaying anything more than
a status line.
