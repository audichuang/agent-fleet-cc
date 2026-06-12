---
description: Check the claude CLI and validate delegate profiles
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" setup
```

If no profiles exist, walk the user through creating one (standard Claude Code
settings JSON with an env block: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model).
