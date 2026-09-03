---
name: codex
description: Internal contract for the Codex plugin. Consult it BEFORE presenting any Codex review, rescue, task or result payload — it carries the stop-rule that findings must never be auto-fixed (ask the user first, even when the fix is obvious), the rule that a failed or never-invoked Codex run must be reported rather than replaced with a Claude-side answer, and how to preserve verdicts, severity order, file:line precision and inference-vs-fact boundaries. Its references carry the GPT-5.6 prompt-composition guidance for /codex:handoff and the codex-rescue subagent.
user-invocable: false
---

# Codex

One skill for the whole plugin. The body is the **result-handling contract** —
what has to be true every time Codex's own output reaches the user, which is the
path nine commands take. Prompt-composition material is disclosed through the
references table below, so the hot path stays short enough that the stop-rule
does not get buried in it.

## Result handling

When the helper returns Codex output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Codex marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Codex made edits, say so explicitly and list the touched files when the helper provides them.
- For `codex:codex-rescue`, do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure and stop.
- For `codex:codex-rescue`, if Codex was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Codex run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/codex:setup` and do not improvise alternate auth flows.

## References

Read one when the job calls for it — each is one hop from here, none needs the
others first.

| Reference | Read it when |
| --- | --- |
| [references/prompting.md](references/prompting.md) | Composing any prompt for Codex — the outcome-first shape, model selection, and the reviewer role this plugin mostly casts Codex in. The entry point for `/codex:handoff` and for `codex:codex-rescue` tightening a forwarded request. |
| [references/prompt-blocks.md](references/prompt-blocks.md) | You want a reusable section (Role, Success criteria, Constraints, Stop rules) rather than writing one from scratch. |
| [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md) | You want a complete template for a task type — diagnosis, narrow fix, review, research. |
| [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md) | Checking a drafted prompt against known failure modes before sending it. |
| [references/delivery-paths.md](references/delivery-paths.md) | Choosing between a direct `task`, `task --resume-last`, the `codex:codex-rescue` subagent, or a conversation fork — with the measured costs and the `context: fork` trap. |
