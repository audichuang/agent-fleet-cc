---
description: Review uncommitted changes (or a branch diff) with Google Antigravity (agy)
argument-hint: '[--base <ref>] [--scope <auto|working-tree|branch>] [--background] [--wait] [--continue] [--conversation <id>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/review.mjs" $ARGUMENTS`

Flags:
- `--base <ref>` review the diff between HEAD and `<ref>` (e.g. `main`).
- `--scope <auto|working-tree|branch>` overrides the auto-detection. Default `auto`.
- `--background` fork a worker, return immediately. Use `/antigravity:status` to poll.
- `--wait` combined with `--background`, block until completion.
- `--continue` resume the most recent review conversation.
- `--conversation <id>` resume a specific conversation by id.
- `--json` emit structured JSON instead of the rendered markdown review.

Auth note:
- If the output says "Antigravity is not authenticated", run `/antigravity:setup` to complete the OAuth flow and then re-try.

Output rules:
- Present the review output to the user exactly as returned.
- Do not paraphrase, summarize, or add your own commentary.
- Do not make any code changes based on the review findings. If the user wants a fix, ask them which finding to address first.
- If the output is empty or indicates no changes, say so explicitly.
