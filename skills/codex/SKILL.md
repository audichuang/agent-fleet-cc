---
name: codex
description: Runs Codex for a review, a check, a diagnosis, an implementation, or an image, and is consulted before any Codex payload is shown. Use it whenever the user asks Codex to do something, in any language ("ask codex", "請 codex", "讓 Codex 跑"), instead of opening Codex in a terminal, tmux or a worktree manager (unless the user names that tool), even when earlier rounds ran that way. The host runs the companion script. Findings are never auto-fixed unless the user asked for a fix loop, a failed or never-invoked run is reported rather than replaced, and generated image files are shown. Default model is gpt-6.2-sol.
---

## Calling Codex

When the user wants Codex to review, check, or do the work, run the companion. (A Codex that was handed a task by the companion is the worker, not a caller: this skill is not for it.) A `/codex` call or a `/codex:*` name is the verb below, not a command to invoke. A raw `codex` or `codex exec` call does not record the job or return the image files this skill prints. Delegating to Codex in another tool (a terminal in a worktree manager, say) loses the job record.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/codex-companion.mjs" <verb> ...
```

- `review` — built-in review of local git changes. Review-only. It does not take extra focus text; use `adversarial-review` when the user wants a focus or a stricter pass.
- `adversarial-review` — same targets as `review`, plus optional focus text. Options come first and the focus text last: `adversarial-review --background --base main "focus on the retry path"`. Focus longer than a line goes in a file, passed with `--focus-file` (same reason as `task` below; a shell runs backticks and `$(…)` inside double quotes). Both review verbs pick the target themselves: uncommitted changes when the tree is dirty, otherwise the branch against the default branch. `--base <ref>` reviews the branch against that ref instead.
- `task` — diagnosis, implementation, image generation, or any prompt that is not the built-in reviewer. Put any prompt longer than a line in a file and pass `--prompt-file`: some hosts and shells mangle a multi-line argument or collapse it to empty, and a file reads the same everywhere. A follow-up on the same Codex thread is `task --resume-last`. It finds the last `task` thread only: a review leaves none, so acting on review findings is a fresh `task` whose prompt restates them.
- `status`, `result`, `cancel`, `wait`, `logs`, `setup` — follow a job, or check auth.
- Every verb works on the git checkout of the shell's working directory: a review reviews that checkout's changes and `--resume-last` finds that checkout's last thread, whatever the prompt says. For another checkout (a worktree, above all) pass `--cwd <path>`, and read the launch JSON's `workspaceRoot` before you wait: a review launched from the wrong checkout reviews the wrong branch. That holds for a new run. A thread continued with `--thread` or `--resume-last` can keep the folder it was started in, whatever `--cwd` says so its launch JSON has no `workspaceRoot`: continue a thread from the checkout that started it. To have the launch refuse a mismatch instead, pass all three of `--expected-worktree <path> --expected-branch <name> --expected-base <ref>` (the branch's own name, not `HEAD`; one or two of the three alone are refused); they check the checkout `--cwd` names, not a continued thread's folder.

`${CLAUDE_SKILL_DIR}` is this skill's directory, the one holding this `SKILL.md`; where your harness does not fill it in, use that absolute path. `<verb> --help` prints usage and launches nothing; if it prints nothing and exits 0, the script never ran: rerun it once through the real path (`node "$(realpath <skill-dir>)/scripts/codex-companion.mjs" …`), and if that is silent too, report a skill bug. Codex runs with full access and no approvals, so there is no permission flag to add (`--write` is a no-op). A run that reports a sandbox or approval block is a bug: report it.

## No computer use

This skill cannot have Codex operate a live screen (click, type or scroll in a GUI app or a web page, log in on a site, screenshot an app, a real-UI or manual QA round). The Codex desktop app it used to drive no longer accepts outside connections. When the user asks for that, say this skill cannot do it; do not run it on the CLI instead. A CLI run may list computer-use tools, because the app's plugins are shared through `~/.codex/config.toml`, but there they fail to launch apps or screenshot the wrong window: never accept UI results from a CLI run. Code, commands or text *about* a UI (fix a component, write a Playwright or E2E test, fetch a URL, run headless tests) is ordinary `task` work. Leave `--backend` unset. A mistyped option stops the launch with `has no option` and a guess; fix the spelling and relaunch, never drop the flag.

Leave `--model` unset. The companion uses `gpt-6.2-sol` at `xhigh`, the stronger model this delegation is for. Pass `--model` only when the user names a model. Do not pass `gpt-6-sol` or `gpt-6-luna`. Do not pass a service tier. `gpt-6.2-astra` only when the user asks for the frontier model. Leave `--effort` unset as well: the companion runs at `xhigh`. Pass `--effort` only when the user names a level, which is per-model (`prompting.md` says where the catalog lists them).

## Launching and following a job

A run that will not finish inside ten minutes (Claude Code's Bash ceiling; your host's may differ) uses the companion's own `--background` (and `--json` for the job id). That is the tracked job. A foreground call killed at that ceiling (a SIGTERM) takes its run with it: the job is recorded as failed and its answer is lost. Run `status` to confirm and say so. A review relaunches with `--background`; a task that edits files may have done part of it already, so first check what changed (`git status`) and tell the user before a relaunch repeats it.

Run the launch line on its own and read its JSON whole (it is short; a `| tail` on it once cut off the `jobId`): it names the `jobId` (no shared file, so sessions sharing `/tmp` cannot pick up each other's job), and its `next` field is a one-line form of this section. Then, in the same turn, run the other two lines together as **one background Bash command** (a single `wait` ends at its own timeout and leaves nothing waiting): a launch with nothing waiting on it finishes unnoticed, once for hours until the user asked. Then stop: your host tells you when that command exits, so add no `wait`, `sleep` or file polling of your own; job files are not a wait mechanism. A job is stopped and recorded as failed after 3 hours; for a run that may go longer, put a larger `CODEX_JOB_TIMEOUT_MS=<ms>` in front of the launch line, since it cannot be raised afterwards (`background-jobs.md`, Time cap).

If nothing will tell you the command exited (you are a subagent or workflow step, whose background commands die when your turn ends; your host has no exit notice; or, in Claude Code, `CLAUDE_CODE_ENTRYPOINT` starts with `sdk`, an Agent SDK client that ends background commands with the session), run the loop's `wait` line in the foreground instead, one call at a time with `--timeout-ms` just under that call's own timeout (`--timeout-ms 540000` under a 600000 ms Bash timeout, not the loop's `100000`), until it exits with something other than `10`, and run `result` only once it has exited with something other than `10` (never chained after `wait` with `;`); do not end your turn while the job runs. That is the loop done by hand, not extra polling. The lines are bash (under another shell, `bash -c '…'`). A `CODEX_COMPANION_DATA` set for the launch must be set for every later verb on that job. `--timeout-ms` is in milliseconds; there is no `--timeout`.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/codex-companion.mjs" task --background --json --prompt-file <file>
J=<the jobId the launch printed>
start=$SECONDS; while :; do code=0; node "${CLAUDE_SKILL_DIR}/scripts/codex-companion.mjs" wait "$J" --timeout-ms 100000 > "${TMPDIR:-/tmp}/codex-wait-$J.out" || code=$?; [ "$code" -ne 10 ] && break; [ $((SECONDS - start)) -ge 1800 ] && break; done; echo "wait exit: $code"
```
`wait exit: 0` means done: run `result <jobId>`. `10` is the 30-minute check-in, not a failure: `codex-wait-<jobId>.out` already holds the `status` report (`Last activity`, `Progress`); read it, give the user one line, and rerun the loop. The job is still running then, so `result` has nothing yet: wait for an exit other than `10`. Keep the `1800`: that check-in is the user's only news during a long run. Any other code, a job the companion no longer finds, or a stall: `background-jobs.md`. The same two lines follow any job: set `J=` to its id.

Read the companion stdout in full: redirect it to a file and read the whole file, never pipe it (or that file) into `head`, `tail` or `sed -n`, which cut the findings you are about to relay. That holds for every verb, the launch and `wait` included. Parsing `--json` with `jq` is fine. If Codex generated images, show the user the saved files: non-JSON stdout has an `Images:` section, and `--json` carries `imageGenerations[].savedPath`.

## Result handling

The stdout is the answer. Relay it in the user's language, completely and faithfully: the verdict and every finding with its file:line, severity and uncertainty marks, in the order Codex used, none dropped, merged or softened. Keep code, commands, identifiers and error text as printed. When other reviewers' results are shown alongside, give Codex's findings in full first and put any comparison table after them, never in place of them.

- Do not turn a failed or incomplete Codex run into a Claude-side implementation attempt, and do not let another reviewer (you, a subagent, another model) stand in for a failed Codex review the user asked for as a gate. Report the failure, including the most actionable stderr lines, and stop. Some causes a relaunch can fix (a content-policy flag, a model at capacity, a dropped connection): `background-jobs.md` says which and how.
- If Codex was never successfully invoked, do not generate a substitute answer at all.
- After presenting review findings, stop and ask which issues, if any, the user wants fixed. Auto-applying fixes from a review is strictly forbidden, unless the user already decided it ("fix until Codex approves", "Codex 兜底"). Then still show the user each round's verdict and every finding before you touch the code for it, Which findings to fix and when the loop stops belong to the `review-gate` skill: its ledger counts rounds across workflows and renames, and round 3 ends in a diagnosis, not another review. Without it, after three rounds on the same change that still report findings, stop and ask before another: each round is a full Codex review, and a loop that finds one new issue per round does not end on its own (`codex-prompt-recipes.md`, re-review).
- If Codex edited files, name the files it names, then stop.
- If setup or authentication is required, run the companion `setup` verb. Do not improvise a login flow.

## References

Open one of these when the row matches. Each file is one hop from here.

| Reference | Read it when |
| --- | --- |
| [references/prompting.md](references/prompting.md) | Composing the prompt — outcome-first shape, which model, and the reviewer stance. |
| [references/prompt-blocks.md](references/prompt-blocks.md) | You need a reusable section (stop rules, verification, retrieval budget) rather than writing one. |
| [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md) | You need a complete template for a task type — diagnosis, narrow fix, review, research. |
| [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md) | Checking a drafted prompt for lines that make GPT-6.x worse. |
| [references/delivery-paths.md](references/delivery-paths.md) | Choosing a direct `task`, `task --resume-last`, or a conversation fork. |
| [references/background-jobs.md](references/background-jobs.md) | You are about to launch with `--background`, or are waiting on a job — `wait`'s timeout and exit codes, the 30-minute check-in on a long job, a job `wait` no longer finds, the time cap, and how to tell a finished job. |
