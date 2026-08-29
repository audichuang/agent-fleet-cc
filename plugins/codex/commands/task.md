---
description: Send a task to Codex and present Codex's response
argument-hint: '[--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Skill
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "$ARGUMENTS"`

Return the command stdout verbatim to the user. Do not paraphrase, summarize, rewrite, or add commentary before or after it.

Before any of that output reaches the user, load the `codex-result-handling` skill (via the `Skill` tool) and present it per that contract. Load it when the output arrives, not after you have read it — by then the tempting next move, quietly fixing what Codex flagged, has usually already happened.
