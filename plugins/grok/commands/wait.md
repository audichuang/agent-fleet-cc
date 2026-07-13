---
description: Wait for a grok job to finish
argument-hint: "<job-id> [--timeout-s <n>] [--json]"
disable-model-invocation: true
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" wait $ARGUMENTS
```
