---
description: Show a read-only status board across installed fleet engines
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-status.mjs"`

Present the command output as-is. This slash wrapper intentionally runs the all-engine compact CLI board without raw slash arguments. The underlying CLI supports `--only` and `--json` for automation, but the slash wrapper does not inject user-provided text into a shell command. This is not a full TUI, and it only calls each engine's own read-only status command.
