---
description: Check the claude CLI and validate cc profiles (auto-creates native on first run)
---

Run and relay:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-companion.mjs" setup
```

`cc:setup` checks the claude CLI and lists profiles. On first run with no profile,
it **auto-creates a `native` profile** (empty settings `{}` = your native Claude
Code login + default model), so `/cc:task` works out of the box.

To add another engine (e.g. a cheap endpoint), create a `<name>.json` under the
profiles dir — a standard Claude Code settings JSON with an `env` block
(`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, model).
