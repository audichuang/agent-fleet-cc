---
description: Print a grok job's raw event stream (Grok's thinking + text output)
argument-hint: "<job-id> [--follow]"
disable-model-invocation: true
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" logs $ARGUMENTS
```
