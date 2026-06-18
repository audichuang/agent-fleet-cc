---
description: Wait for a single Codex job to reach a terminal status
argument-hint: '<job-id> [--timeout-ms <ms>] [--poll-interval-ms <ms>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait "$ARGUMENTS"`

This command requires a job id and is equivalent to `/codex:status <job-id> --wait`.

Present the full command output to the user. Do not paraphrase, summarize, rewrite, condense, or add commentary before or after it.
