---
name: codex
description: Runs Codex for a review, a check, a diagnosis, an implementation, or an image, and is consulted before any Codex payload is shown. The host runs the companion script; there is no slash command. Findings are never auto-fixed, a failed or never-invoked run is reported rather than replaced, and generated image files are shown. Default model is gpt-6.1-sol.
user-invocable: false
---

# Codex

## Calling Codex

When the user wants Codex to review, check, or do the work, run the companion. A `/codex:*` name is the verb below, not a command to invoke. A raw `codex` or `codex exec` call does not record the job or return the image files this plugin prints.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <verb> ...
```

- `review` — built-in review of local git changes. Review-only. It does not take extra focus text; use `adversarial-review` when the user wants a focus or a stricter pass.
- `adversarial-review` — same targets as `review`, plus optional focus text.
- `task` — diagnosis, implementation, image generation, or any prompt that is not the built-in reviewer. Multi-line prompts go through `--prompt-file`; an inline multi-line string gets mangled or collapses to empty. A follow-up on the same Codex thread is `task --resume-last`.
- `status`, `result`, `cancel`, `wait`, `logs`, `setup` — follow a job, or check auth.

## CLI or the Codex desktop app

`task` runs on the Codex CLI unless the work belongs in the user's Codex desktop app (macOS or Linux):

- `--backend desktop` when the user wants it done in the app: computer use, its browser, or a run they want to watch there. The thread opens in the app, which the user sees. Add `--new-thread-via app` when they want the chat created by the app itself (it presses Enter in the app's window).
- `--thread <id>` continues one named thread. Without `--backend` it goes to the app only if the app has that thread loaded right now; otherwise the CLI continues it. So when the user means their conversation *in the app* (a `codex://threads/<id>` link, "my Codex desktop chat"), pass `--backend desktop` too.
- A plain task (fix, diagnose, implement) stays on the CLI. Do not add `--backend desktop` because the app happens to be running.
- A desktop run that stops on an approval fails with that reason; the turn is still waiting in the app. Tell the user to approve it there.

`status`, `wait`, `logs`, `result` and `cancel` work the same for either backend. Routing, failures and limits: the `desktop-backend.md` row below.

Leave `--model` unset. The companion uses `gpt-6.1-sol` at `xhigh`, the stronger model this delegation is for. Pass `--model` only when the user names a model. Do not pass `gpt-6-sol` or `gpt-6-luna`. Do not pass a service tier. `gpt-6-astra` only when the user asks for the frontier model.

A run that will not finish inside ten minutes uses the companion's own `--background` (and `--json` when you need the job id). That is the tracked job. A foreground call killed at that ceiling is a SIGTERM; the record is already on disk. Say so and run `status`. Do not treat the empty stdout as a failed review.

Return the companion stdout verbatim. If Codex generated images, show the user the saved files: non-JSON stdout has an `Images:` section, and `--json` carries `imageGenerations[].savedPath`.

## Result handling

The stdout is the answer. Relay its verdict, findings, file:line locations, and uncertainty marks as printed, in the order and severity Codex used.

- Do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure, including the most actionable stderr lines, and stop.
- If Codex was never successfully invoked, do not generate a substitute answer at all.
- After presenting review findings, stop and ask which issues, if any, the user wants fixed. Auto-applying fixes from a review is strictly forbidden.
- If Codex edited files, name the files it names, then stop.
- If setup or authentication is required, run the companion `setup` verb. Do not improvise a login flow.

## References

Open one of these when the row matches. Each file is one hop from here.

| Reference | Read it when |
| --- | --- |
| [references/prompting.md](references/prompting.md) | Composing the prompt — outcome-first shape, which model, and the reviewer stance. `codex:codex-rescue` starts here when it tightens a forwarded request. |
| [references/prompt-blocks.md](references/prompt-blocks.md) | You need a reusable section (stop rules, verification, retrieval budget) rather than writing one. |
| [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md) | You need a complete template for a task type — diagnosis, narrow fix, review, research. |
| [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md) | Checking a drafted prompt for lines that make GPT-6.1 worse. |
| [references/delivery-paths.md](references/delivery-paths.md) | Choosing a direct `task`, `task --resume-last`, the `codex:codex-rescue` subagent, or a conversation fork. |
| [references/desktop-backend.md](references/desktop-backend.md) | A task should run in the Codex desktop app, continue a thread open there, or a desktop run failed. |
