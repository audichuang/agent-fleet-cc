---
description: Run read-only fleet readiness checks
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-doctor.mjs"`

Present the command output as-is. This slash wrapper intentionally runs the all-engine local prerequisite check without raw slash arguments. The underlying CLI supports `--only` and `--json` for automation, but the slash wrapper does not inject user-provided text into a shell command. This check does not verify auth or run any engine setup command.
