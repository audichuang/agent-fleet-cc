---
description: Stream live logs for a Codex background job
argument-hint: '[job-id] [--poll-interval-ms <ms>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Skill
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" logs "$ARGUMENTS"`

Preserve Codex native live log behavior: this command delegates to the existing attach implementation.

Present the streamed log output to the user as-is. Do not paraphrase, summarize, rewrite, condense, or add commentary before or after it.

Before any of that output reaches the user, load the `codex:codex` skill (via the `Skill` tool) and present it per that contract. Load it when the output arrives, not after you have read it — by then the tempting next move, quietly fixing what Codex flagged, has usually already happened.
