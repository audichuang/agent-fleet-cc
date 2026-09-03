---
description: Build a GPT-5.6 prompt for Codex (by default a review of the work just done in this session) and send it to Codex, returning Codex's response. Use --print to only emit the prompt for you to paste yourself.
argument-hint: '[task description — omit to review the work done in this session] [--print] [--background] [--write]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(mktemp:*), Bash(cat:*), Skill
---

Build a complete GPT-5.6 prompt and, by **default, send it to Codex and return Codex's response**. This automates the loop: reflect → compose a GPT-5.6 prompt → run it through Codex → bring the answer back. With `--print` (or `--prompt-only`), do NOT run Codex — just emit the prompt in a fenced block for you to paste yourself.

Raw slash-command arguments:
`$ARGUMENTS`

First, load the prompt methodology:
- Load the `codex:codex` skill (via the `Skill` tool) and read its `references/prompting.md` when composing the prompt; follow it: outcome-first, success criteria, decision rules instead of blanket `ALWAYS`/`NEVER`, explicit stop rules, absolute file paths, and the suggested structure (`Role` / `Goal` / `Success criteria` / `Constraints` / `Output` / `Stop rules`).

Then, before Codex's answer reaches the user:
- Load the `codex:codex` skill (via the `Skill` tool) and follow it when presenting the response. Load it at the moment the output comes back, not at the end — by then the tempting next move (quietly fixing what Codex flagged) has usually already happened. It carries the stop-rule that review findings are never auto-fixed, and the rule that a failed run is reported rather than replaced with an answer of your own.

## Step 1 — build the prompt

Strip the execution flags (`--print`, `--prompt-only`, `--background`, `--write`) from `$ARGUMENTS` first; the remainder (if any) is the task.

### Mode A — no arguments: review handoff for the work just done

When there is no task text, build a prompt that asks Codex to **review the work completed in this session**:

1. Reconstruct what changed. Use the working tree and history, e.g.:
   - `git --no-pager status --short`
   - `git --no-pager diff --stat` and `git --no-pager diff` for unstaged work
   - `git --no-pager diff --stat --cached` for staged work
   - `git --no-pager log --oneline -10` and `git --no-pager diff <base>...HEAD` if the work is committed on a branch
   Combine that with what you did in this conversation (the intent, the decisions, the trade-offs).
2. Compose a **code-review** prompt using the `references/prompting.md` methodology and the code-review recipe: a senior-engineer Role, a Goal of finding bugs / contract violations / maintainability / security issues, Success criteria (file:line + severity, fix snippets, "no issues found in X" when clean), Constraints (don't pad, mark "Need to verify"), and Stop rules.
3. List the changed files as **absolute paths** under a "Files to read" section, and tell Codex to read them itself (do NOT ask anyone to paste code). Add a one-paragraph "Context" describing what this change set was trying to achieve and any decisions worth challenging.

### Mode B — with a task: build a prompt for that task

Treat the remaining text as the task. Identify the task type (code review, document/design analysis, research/grounded answer, rewrite, or agentic/tool-heavy) and build the matching prompt from `references/codex-prompt-recipes.md`, tailoring the sections to that type. Pull in relevant absolute file paths from the conversation or repo.

## Step 2 — send it (default) or print it

### If `--print` or `--prompt-only` is present: print only (do not run Codex)
- Output the finished prompt inside a single fenced ` ```text ` block so the user can copy it directly.
- Prose/context in the user's language; structural headers and technical directives in English (per the skill's output-language convention).
- End with one short line: "若 Codex 回應方向不對，告訴我哪裡偏掉，我再調 prompt。"

### Otherwise (default): send the prompt to Codex and return its response

1. Write the composed prompt to a temp file:
```bash
TMPFILE=$(mktemp /tmp/codex-handoff-prompt.XXXXXX.md)
cat <<'PROMPT_EOF' > "$TMPFILE"
[the composed GPT-5.6 prompt]
PROMPT_EOF
```
2. Run it through Codex with the companion task runner (defaults to gpt-5.6 / xhigh):
   - Mode A (review handoff) is a **non-editing run** (review / diagnosis / research) — do NOT add `--write`.
   - Mode B: add `--write` only if the task clearly needs to edit code, or the user passed `--write`.
   - Omitting `--write` marks the job as non-editing (metadata) — it does **not** sandbox Codex. Every thread starts with `sandbox: danger-full-access` and `approvalPolicy: never`, because this fork's target hosts cannot start Codex's bwrap sandbox at all (see `resolveSandboxMode` in `scripts/lib/codex.mjs`). Codex can therefore still edit files and run commands during a non-editing run; on a host where bwrap does start, `CODEX_SANDBOX_MODE=read-only` is what asks for real enforcement.

Foreground (default):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --prompt-file "$TMPFILE" [--write]
```
- Return Codex's output verbatim. Do not paraphrase, summarize, or add commentary. Clean up the temp file after completion.

Background (when `--background` is present):
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --prompt-file "$TMPFILE" [--write]`,
  description: "Codex handoff",
  run_in_background: true
})
```
- Note: `run_in_background: true` backgrounds this within THIS session only — it is best-effort, NOT the durable, watchdog-backed tracked job that `/codex:task --background` provides (a detached worker surviving the session). If the session ends, the handoff ends. For a handoff that must outlive the session, run `/codex:task --background` instead.
- Tell the user: "Sent to Codex in the background (this session). Use `/codex:status` to check progress and `/codex:result` to see the response."

## Operating rules

- Default is to **run Codex and return the response** — the one-key "reflect → ask Codex → bring it back" loop. Only `--print`/`--prompt-only` skips the run.
- Do not fix or act on Codex's response yourself; just return it. The user decides what to do next. This is the `codex:codex` skill's stop-rule; load it when the response arrives rather than relying on this line.
- Clean up the temp prompt file after Codex finishes (foreground) or note its path (background).
