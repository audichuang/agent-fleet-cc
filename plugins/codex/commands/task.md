---
description: Send a task to Codex and present Codex's response
argument-hint: '[--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "$ARGUMENTS"`

Return the command stdout verbatim to the user. Do not paraphrase, summarize, rewrite, or add commentary before or after it.
