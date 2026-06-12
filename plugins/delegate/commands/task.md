---
description: Delegate an execution task to a cheap-model headless Claude Code instance
argument-hint: "<prompt> [--profile <name>|--settings <path>] [--background] [--resume-last|--resume-id <job>] [--timeout-ms <n>]"
---

Run the delegate companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" task $ARGUMENTS
```

- For long tasks add `--background`, then poll with /delegate:status.
- The prompt must be a complete, self-contained instruction — the delegate
  is a cheap model: spell out files, constraints, and the definition of done.
- Report the companion's output back to the user verbatim.
