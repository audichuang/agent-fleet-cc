---
description: Delegate a task to Google Antigravity (agy) for debugging, investigation, or (with --apply) editing files in the repo
argument-hint: '[--background|--wait] [--resume|--fresh] [--continue] [--conversation <id>] [--add-dir <path>] [--model <id>] [--apply] [--dangerously-skip-permissions] [what Antigravity should investigate, solve, or continue]'
allowed-tools: AskUserQuestion, Agent
---

Invoke the `antigravity:agy-rescue` subagent via the `Agent` tool (`subagent_type: "antigravity:agy-rescue"`), forwarding the raw user request as the prompt.
`antigravity:agy-rescue` is a subagent, not a skill — do not call `Skill(antigravity:agy-rescue)` (no such skill) or `Skill(antigravity:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be the Antigravity companion output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `antigravity:agy-rescue` subagent in the background.
- If the request includes `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground. Remember agy cannot stream — a foreground run stays silent until it completes.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `rescue`, and do not treat them as part of the natural-language task text.
- If the request includes `--resume` or `--continue`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask either. The user already chose.
- Otherwise, if it is genuinely unclear whether the user wants to continue the most recent Antigravity thread or start a new one, ask once via `AskUserQuestion` with these two choices:
  - `Continue most recent Antigravity thread` — put `(Recommended)` on it when the user is clearly giving a follow-up such as "continue", "keep going", or "dig deeper"
  - `Start a new Antigravity thread` — put `(Recommended)` on it otherwise
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/rescue.mjs" ...` and return that command's output as-is.
- Return the Antigravity companion output verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/antigravity:status`, fetch `/antigravity:result`, call `/antigravity:cancel`, summarize output, or do follow-up work of its own.
- `--model <id>`, `--conversation <id>`, `--add-dir <path>`, and `--prompt-file <path>` are runtime flags. Leave them in the forwarded request; do not treat them as task text.
- `--apply` and `--dangerously-skip-permissions` are write-mode flags. Leave them in the forwarded request; do not treat them as task text. By default (no `--apply`) Antigravity does not edit your repo — it returns text/a proposed patch for you to apply (not a hard read-only guard: agy may still write to its own `~/.gemini` scratch). `--dangerously-skip-permissions` only takes effect together with `--apply`.
- Leave `--resume`, `--continue`, and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `rescue.mjs` command.
- If the subagent's output says Antigravity is missing or not authenticated, stop and tell the user to run `/antigravity:setup`.
- If the user did not supply a request, ask what Antigravity should investigate or fix.
