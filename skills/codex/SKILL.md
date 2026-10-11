---
name: codex
description: Runs Codex for a review, a check, a diagnosis, an implementation, or an image, or has the Codex desktop app operate a real GUI or web page with computer use (click through, test or screenshot a live UI), and is consulted before any Codex payload is shown. Use it whenever the user asks Codex to do something, in any language ("ask codex", "請 codex", "讓 Codex 跑"), instead of opening Codex in a terminal, tmux or a worktree manager (unless the user names that tool), even when earlier rounds ran that way. The host runs the companion script. Findings are never auto-fixed, a failed or never-invoked run is reported rather than replaced, and generated image files are shown. Default model is gpt-6.1-sol.
metadata:
  version: "3.0.0"
---

## Calling Codex

When the user wants Codex to review, check, or do the work, run the companion. A `/codex` call or a `/codex:*` name is the verb below, not a command to invoke. A raw `codex` or `codex exec` call does not record the job or return the image files this skill prints. Delegating to Codex in another tool (a terminal in a worktree manager, say) loses the job record and, on the CLI, computer use.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/codex-companion.mjs" <verb> ...
```

- `review` — built-in review of local git changes. Review-only. It does not take extra focus text; use `adversarial-review` when the user wants a focus or a stricter pass.
- `adversarial-review` — same targets as `review`, plus optional focus text. Options come first and the focus text last: `adversarial-review --background --base main "focus on the retry path"`. Both review verbs pick the target themselves: uncommitted changes when the tree is dirty, otherwise the branch against the default branch. `--base <ref>` reviews the branch against that ref instead.
- `task` — diagnosis, implementation, image generation, or any prompt that is not the built-in reviewer. Multi-line prompts go through `--prompt-file`; an inline multi-line string gets mangled or collapses to empty. A follow-up on the same Codex thread is `task --resume-last`.
- `status`, `result`, `cancel`, `wait`, `logs`, `setup` — follow a job, or check auth.

`${CLAUDE_SKILL_DIR}` is this skill's directory, the one holding this `SKILL.md`; where your harness does not fill it in, use that absolute path. `<verb> --help` prints usage and launches nothing; if it prints nothing and exits 0, the script never ran: rerun it once through the real path (`node "$(realpath <skill-dir>)/scripts/codex-companion.mjs" …`), and if that is silent too, report a skill bug. Codex runs with full access and no approvals on both backends, so there is no permission flag to add (`--write` is a no-op). A run that reports a sandbox or approval block is the one exception in `desktop-backend.md`, or a bug: report it. A computer-use confirmation question is neither (`desktop-backend.md`).

## CLI or the Codex desktop app

Before every `task`, you decide the backend. The user rarely says "computer use", so judge the work itself: **does Codex need hands on a live screen?** Only the Codex desktop app (macOS or Linux) runs computer use and the browser reliably. A CLI run may list computer-use tools, because the app's plugins are shared through `~/.codex/config.toml`, but there they fail to launch apps or screenshot the wrong window: never accept UI results from a CLI run.

- **Live screen → `--backend desktop`.** Codex must click, type or scroll in a GUI app or a web page, log in and act on a site, fill a form, click through a UI to reproduce or check a bug, read what a page shows once rendered, screenshot an app, or run a real-UI or manual QA round from a protocol doc (even when it is called a test).
- **Files and a terminal → leave `--backend` unset.** The work is code, commands or text, including work *about* a UI or a page: fix a component, write a Playwright or E2E test, fetch a URL or an API, run headless tests. A fix, diagnosis or implementation stays on the CLI even while the app is running.
- **The user asks for the app → `--backend desktop`.** They want to watch the run there, or they name their conversation in the app.

Torn between the first two? If a terminal alone could finish the job, it is the CLI.

Passing `--backend desktop` is the whole decision. Spell it exactly: `task` reads an unknown option as prompt text, so a typo runs on the CLI without computer use. After launching, `status <jobId> --json` shows `backend: "desktop"`; if it does not, cancel and relaunch. The companion creates the thread, opens it in the app where the user sees it, and tracks the turn to its end; checking the app first is its job, not yours. In the prompt itself, not only in a file it points to, name what Codex should operate, what to report back, and each UI action the round needs authorized (changing app settings or theme, deleting test data, logging in, accepting OS permission prompts): computer use stops to ask before any of those it was not explicitly told to do. Two flags have their own triggers:

- `--new-thread-via app` when the user wants the chat created by the app itself (it presses Enter in the app's window).
- `--thread <id>` continues one named thread. Without `--backend` it goes to the app only if the app has that thread loaded right now; otherwise the CLI continues it. So when the user means their conversation *in the app* (a `codex://threads/<id>` link, "my Codex desktop chat"), pass `--backend desktop` too.

A desktop run that stops on an approval fails with that reason; the turn is still waiting in the app. Tell the user to approve it there.

`status`, `wait`, `logs`, `result` and `cancel` work the same for either backend. Routing, failures and limits: the `desktop-backend.md` row below.

Leave `--model` unset. The companion uses `gpt-6.1-sol` at `xhigh`, the stronger model this delegation is for. Pass `--model` only when the user names a model. Do not pass `gpt-6-sol` or `gpt-6-luna`. Do not pass a service tier. `gpt-6-astra` only when the user asks for the frontier model. Leave `--effort` unset as well: the companion runs at `xhigh`. Pass `--effort` only when the user names a level, which is per-model (`prompting.md` says where the catalog lists them).

A run that will not finish inside ten minutes uses the companion's own `--background` (and `--json` when you need the job id). That is the tracked job. A foreground call killed at that ceiling is a SIGTERM; the record is already on disk. Say so and run `status`. Do not treat the empty stdout as a failed review. Never pipe companion output into `head` or `tail`: redirect it to a file and read the file. Run the launch line, then the other two lines together as **one background Bash command** (a single `wait` ends at its own timeout and leaves nothing waiting). `--timeout-ms` is in milliseconds; there is no `--timeout`. A job is stopped and recorded as failed after 3 hours, and a desktop turn is interrupted in the app with it. The cap is fixed when the job starts, so for a run that may go longer (a full UI test round, say) put `CODEX_JOB_TIMEOUT_MS=<ms>` in front of the launch command; it cannot be raised afterwards.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/codex-companion.mjs" task --background --json --prompt-file <file> > "${TMPDIR:-/tmp}/codex-launch.json"
J=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).jobId' "${TMPDIR:-/tmp}/codex-launch.json"); echo "job: $J"
start=$SECONDS; while :; do code=0; node "${CLAUDE_SKILL_DIR}/scripts/codex-companion.mjs" wait "$J" --timeout-ms 100000 > "${TMPDIR:-/tmp}/codex-wait.out" || code=$?; [ "$code" -ne 10 ] && break; [ $((SECONDS - start)) -ge 1800 ] && break; done; echo "wait exit: $code"
```
`wait exit: 0` means done: run `result <jobId>`. Following a job you did not just launch, set `J=<jobId>` instead of the `J=$(…)` line. Other exit codes and the 30-minute check-in: `background-jobs.md`.

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
| [references/prompting.md](references/prompting.md) | Composing the prompt — outcome-first shape, which model, and the reviewer stance. |
| [references/prompt-blocks.md](references/prompt-blocks.md) | You need a reusable section (stop rules, verification, retrieval budget) rather than writing one. |
| [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md) | You need a complete template for a task type — diagnosis, narrow fix, review, research. |
| [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md) | Checking a drafted prompt for lines that make GPT-6.1 worse. |
| [references/delivery-paths.md](references/delivery-paths.md) | Choosing a direct `task`, `task --resume-last`, or a conversation fork. |
| [references/background-jobs.md](references/background-jobs.md) | You are about to launch with `--background`, or are waiting on a job — `wait`'s timeout and exit codes, the 30-minute check-in on a long job, the job's time cap, and how to tell a finished job. |
| [references/desktop-backend.md](references/desktop-backend.md) | A task should run in the Codex desktop app, continue a thread open there, or a desktop run failed. |
