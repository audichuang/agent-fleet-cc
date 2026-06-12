---
description: Delegate a task to Google Antigravity (agy) for debugging, implementation, or deeper investigation
argument-hint: '[--background|--wait] [--resume|--fresh] [--continue] [--conversation <id>] [--add-dir <path>] [--model <id>] [what Antigravity should investigate, solve, or continue]'
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

You are a thin forwarding wrapper. Your only job is to invoke the Antigravity companion via Bash and return its output. Do not spawn subagents, do not invoke skills, do not do the work yourself.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, tell Claude Code to run this fork in the background.
- If the request includes `--wait`, run in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `rescue`, and do not treat them as part of the natural-language task text.
- If the request includes `--resume` or `--continue`, do not ask whether to continue — the user already chose.
- If the request includes `--fresh`, do not ask either — the user has chosen a new thread.
- Otherwise, before starting Antigravity, you MAY check whether the user wants to resume the most recent rescue thread. If unsure, ask once via `AskUserQuestion` with these two choices:
  - `Continue most recent Antigravity thread (Recommended)` when the user is clearly giving a follow-up
  - `Start a new Antigravity thread (Recommended)` otherwise

Invocation:

- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/rescue.mjs" ...` and return that command's stdout as-is.
- Strip `--background` and `--wait` from the task text — they are Claude Code execution flags.
- Everything remaining after stripping flags is the task text — pass it through as the trailing positional.
- `--model <id>` is forwarded to agy verbatim (agy has a native `--model`); pass it through unchanged. `--prompt-file <path>` reads the prompt from a file (used by `/antigravity:handoff`).

Auth note:
- If the helper output says Antigravity is missing or not authenticated, stop and ask the user to run `/antigravity:setup`.

Output rules:

- Return the rescue companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the Bash call fails, return nothing and surface the failure.
- If the user did not supply a request, ask what Antigravity should investigate or fix.
