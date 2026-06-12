---
description: Strict, structured (JSON) adversarial code review of your current diff via Antigravity (agy), rendered as markdown
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--no-sandbox] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/adversarial-review.mjs" $ARGUMENTS`

What it does:
- Collects your working-tree (or branch) diff and asks agy, as a skeptical
  senior reviewer, to return a strict JSON review (verdict + findings with
  severity/file/line/confidence/recommendation + next steps), then renders it.
- Read-only: agy runs under `--sandbox` so the review cannot mutate the tree
  (`--no-sandbox` to disable, not recommended).
- If agy does not return parseable JSON, the raw output is shown instead.

Flags:
- `--base <ref>` review a branch diff against `<ref>`.
- `--scope auto|working-tree|branch`.
- `--model <id>` choose the model (forwarded to agy verbatim).
- `--json` emit the structured payload.

Output rules:
- Present the rendered review verbatim. If output mentions OAuth, run `/antigravity:setup`.
