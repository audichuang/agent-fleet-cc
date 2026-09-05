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
- Read-only **by instruction**, not by enforcement. The prompt asks for a review and
  nothing else; there is no per-run write guard in headless `--print`. `--sandbox` is on
  by default (`--no-sandbox` disables it, not recommended) but it is an nsjail *terminal*
  container: it blocks shell commands, not `write_file`, and the model can opt out of it
  per call. So treat a review as very unlikely to touch the tree, never as unable to.
  The full evidence chain is in `docs/antigravity-cli-contract-audit.md` Part 3.
- If agy does not return parseable JSON, the raw output is shown instead.

Flags:
- `--base <ref>` review a branch diff against `<ref>`.
- `--scope auto|working-tree|branch`.
- `--model <id>` choose the model (forwarded to agy verbatim).
- `--json` emit the structured payload.

Output rules:
- Present the rendered review verbatim. If output mentions OAuth, run `/antigravity:setup`.
- Do not make any code changes based on the review findings. If the user wants a fix, ask them which finding to address first.
- If the output is empty or indicates no changes, say so explicitly.
