---
description: Check the grok CLI and report auth status (XAI_API_KEY or grok login)
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup
```

`grok:setup` verifies the `grok` binary is runnable and reports whether auth is
available. Grok Build handles auth itself — either set `XAI_API_KEY`, or run
`!grok login` (SuperGrok / X Premium+). This plugin never stores your key.
