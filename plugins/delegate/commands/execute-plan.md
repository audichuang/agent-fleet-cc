---
description: Hand a plan file to a cheap-model headless Claude Code for full implementation
argument-hint: "<plan-file> [--profile <name>|--settings <path>] [--background] [--timeout-ms <n>]"
---

Run the delegate companion and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" execute-plan $ARGUMENTS
```

Plans are executed literally — make sure the plan file is complete before delegating.
