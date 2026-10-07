# Changelog

## 2.0.1

- Desktop turns run with full access and no approvals via the `:danger-full-access` permission profile, unless `CODEX_SANDBOX_MODE` narrows it.
- Not applied on the first turn of `--new-thread-via app`; on "you need to use auto review", set `CODEX_SANDBOX_MODE=workspace-write`.
- Job verbs (`wait`, `status`, `result`, `cancel`, `logs`) now name an unknown option and point at `--timeout-ms <ms>`.
- `SKILL.md` carries the launch and `wait` loop inline and says Codex already has full access; `prompting.md` no longer has Codex wait for confirmation.

## 2.0.0

- **Removed** the `codex:codex-rescue` subagent; delegate with a companion `task` from the main thread via the `codex` skill.
- **Removed** the hooks and the stop-time review gate; `setup` no longer takes `--enable-review-gate` / `--disable-review-gate`.
- Jobs stay session-scoped via `CLAUDE_CODE_SESSION_ID`, and job state is found from the install path when `CLAUDE_PLUGIN_DATA` is unset.
- Ending a session no longer kills its foreground jobs or the shared broker; idle shutdown, watchdog and the hard cap clean up.

## 1.8.0

- Background jobs may run up to 3 hours (was 1); `CODEX_JOB_TIMEOUT_MS` still overrides, and `logs --follow` follows to the job's own cap.
- The job log reports thinking, context compaction, sleeps, slow hooks and MCP progress, so a busy job no longer looks stuck.
- Desktop-app tasks now run at the requested effort instead of always `low`, keeping the thread's collaboration mode.
- The skill says to leave `--effort` unset unless the user names one, and to check `status` after 30 quiet minutes.

## 1.7.1

- Piping output into `head` no longer crashes a run with EPIPE.
- A timed-out `wait` now says the job is still running, not failed.
- New `background-jobs.md` reference documents launching, waiting, exit codes and `result` for background jobs.

## 1.7.0

- `task` can run inside the Codex desktop app with `--backend auto|cli|desktop`, `--thread <id>` and `--new-thread-via cli|app`.
- `setup` reports whether the desktop app is reachable; `cancel`, timeouts and the watchdog stop desktop turns through the app.
- A mid-turn async message no longer ends the job early; tracks codex-cli 0.160.0.
- `<verb> --help` prints usage instead of being taken as prompt or focus text.

## 1.6.4

- **Removed** slash commands; the host loads the `codex` skill and runs `scripts/codex-companion.mjs` directly.
- **Removed** the `gpt-6-sol` fallback retry and the `gpt-6-luna` ticket lane; a gated default model now fails instead of downgrading.
- Image generation is enabled; generated images are listed in an `Images:` section and in `--json` as `imageGenerations`.
- `review` and `adversarial-review` default to `xhigh` effort and support `--background`.

## 1.6.3

- Default model is now `gpt-6.1-sol`; a model-unavailable turn retries once on `gpt-6-sol`.
- Ticket lane moves to `gpt-6-luna --effort max`; `ultra` effort stays rejected.

## 1.6.2

- **Breaking:** the three skills merged into one `codex` skill; `codex-cli-runtime` and `gpt-5-6-prompting` are gone (prompting moved to `references/prompting.md`).
- A failed turn with no agent message now prints its real failure reason instead of "Codex did not return a final message."
- Model prices and benchmark figures removed from the prompting reference; routing is by role.
- `execute-plan` waits on background jobs with a monitor that no longer dies before the job finishes.

## 1.6.1

- Every command that relays Codex output now names the result-handling skill, so Claude stops auto-fixing review findings.
- `codex-rescue` returns a line naming that contract above Codex's output.

## 1.6.0

- A failed turn no longer reads as a finished answer: task, result and both review outputs show the failure reason above any partial output.
- `/codex:result` shows `Status:` for non-completed jobs; docs stop implying runs without `--write` are sandboxed.
- `task` ignores a stray `--wait` instead of sending it to Codex as prompt text.
- Cancelling a job with no live broker no longer starts a throwaway app-server; reading a pruned job no longer leaks directories.

## 1.5.0

- `gpt-5.6-luna` becomes a supported lane for single bounded tickets, pinned to `--effort max`.
- `codex-rescue` gained a ticket lane that forwards with `--model gpt-5.6-luna --effort max`.
- New `references/delivery-paths.md` explains direct `task`, `--resume-last`, the subagent and conversation forks.

## 1.4.1

- Failure reasons now include Codex's structured error code and details, e.g. `[usageLimitExceeded]`, in `errorMessage`.
- Model fallback triggers only on model-gate errors, never on auth, usage-limit or context-window failures.
- `cancel` or `result` on a finished job now says it is already done instead of "No job found".

## 1.4.0

- `task`, `review` and `adversarial-review` retry once on `gpt-5.6-terra` when `gpt-5.6-sol` is unavailable.
- The fallback is visible: a progress line and a `modelFallback` field in `--json`; it never reruns a turn that already did work.

## 1.3.3

- A turn that fails via an app-server error now reports its reason in `errorMessage` across `status`, `wait`, records and `--json`.

## 1.3.2

- Amazon Bedrock auth label works with newer Codex CLIs; approval-decline replies match the current protocol.

## 1.3.1

- Internal: prompting-guide doc updates only (tool-routing rule and prompt block).

## 1.3.0

- The broker shuts down when its app-server dies, so a hung turn fails in seconds instead of at the 1-hour cap.
- Long-running commands show a periodic heartbeat in `logs` and `status`.
- Jobs past their deadline are finalized even if their PID was recycled; foreground jobs get a wall-clock backstop.
- Amazon Bedrock accounts are reported correctly in auth status.

## 1.2.0

- `setup` checks that the default model is available to the account and warns with alternatives if not.

## 1.1.1

- Internal: prompting-skill doc cleanup only.

## 1.1.0

- Default model is now `gpt-5.6-sol`; `max` added to the accepted `--effort` values.
- Prompting skill renamed `gpt-5-5-prompting` to `gpt-5-6-prompting` and rewritten for 5.6.

## 1.0.35

- Background jobs no longer fail instantly with `No stored job found` when the worker starts before the job record is written.
- `wait` usage documents `--timeout-ms` and `--poll-interval-ms`.

## 1.0.34

- A concurrent prune can no longer resurrect a deleted job directory during reconcile.
- `/codex:cancel` reports the job's real status when it loses the race to finish.

## 1.0.33

- `/codex:attach`, `/codex:logs --follow` and cross-workspace `/codex:wait` no longer over-wait on a job that already finished.
- Crashed prunes no longer leave orphan lock-only job directories behind.

## 1.0.32

- Job state moves to a directory-per-job store, eliminating races where progress writes could clobber a finished job.

## 1.0.31

- Internal: vendors the shared runtime in preparation for the state-store migration; no behaviour change.

## 1.0.30

- Docs clarify that `review` / `adversarial-review` / `handoff` backgrounding is session-scoped, unlike `/codex:task --background`.
- `execute-plan` no longer tells Codex to commit to `main`.

## 1.0.29

- Ctrl-C or SIGTERM on a foreground run now finalizes the job instead of leaving it stuck "running".
- Safety and cost notifications (model reroute, token usage, rate limits, plan/diff updates) now appear in the job log.
- Queued jobs get a deadline so a worker that never starts no longer stays "queued" forever.

## 1.0.28

- A background job whose finalizer crashed no longer leaves its waiter hanging; the missing done signal is restored.

## 1.0.27

- A job whose terminal claim was left by a crashed process no longer deadlocks; stale claims expire after 60 seconds.

## 1.0.26

- Server-initiated requests (approvals, user input, MCP elicitation) get proper declines; an auth-token refresh asks you to re-login to Codex.

## 1.0.25

- `/codex:cancel` signals the worker only after winning the cancel, using the authoritative PID, so it never kills an unrelated process.

## 1.0.24

- `status`, `wait`, `result`, `cancel`, `attach` and `logs` now enforce the `--expected-worktree` / `--expected-branch` / `--expected-base` check.

## 1.0.23

- A turn whose start acknowledgement fails or times out is now interrupted instead of orphaned on the broker.

## 1.0.22

- A malformed `turn/completed` no longer hangs the turn; a failed turn reports its error text as the result.

## 1.0.21

- A malformed buffered notification or missing turn ID now fails fast instead of orphaning or hanging the turn.

## 1.0.20

- Fixed cross-process races that could delete another job's files, undo a finished job, or run a job cancelled while queued.

## 1.0.19

- A notification with an unexpected shape no longer silently kills the worker; crashes mark the job failed with the real error in the log.

## 1.0.18

- Background-job hard timeout raised from 15 minutes to 1 hour.

## 1.0.17

- Internal: doc and test-name clarifications only.

## 1.0.16

- SessionEnd no longer tears down a busy shared broker, and an active job is never pruned from the job list.
- Session cleanup no longer signals a reused PID; oversized adversarial-review focus text is capped.

## 1.0.15

- A malformed non-terminal `error` notification no longer leaves a phantom "unknown error"; otherwise test and doc fixes.

## 1.0.14

- SessionEnd no longer shuts down the shared broker under an active background job.
- The opt-in idle watchdog (`CODEX_TURN_IDLE_TIMEOUT_MS`) now interrupts the wedged turn; a malformed `error` notification no longer crashes the process.
- `CODEX_SANDBOX_MODE` is validated and falls back with a warning on a typo.

## 1.0.13

- Sandbox defaults to `danger-full-access` for every turn; `CODEX_SANDBOX_MODE` still overrides it.

## 1.0.12

- Background jobs survive the end of their session and keep the shared broker alive.
- New `/codex:attach` live log tail; job ids now resolve across workspaces.
- Background launches print a `[[codex-task status=dispatched id=<id>]]` line for scripts.

## 1.0.11

- Adversarial-review prompts are capped under Codex's input limit, so huge diffs truncate instead of failing.
- Companion failures also print a JSON error on stdout; permanent errors such as auth failures end the turn immediately.

## 1.0.10

- Closing the app-server now reaps its MCP and tool child processes, and timed-out workers are actually terminated.
- A crashed broker is no longer reused just because its socket still answers.

## 1.0.9

- Non-JSON lines from the app-server (banners, ANSI noise) are skipped instead of killing the turn.
- Hooks tolerate pipe read jitter; new opt-in `CODEX_TURN_IDLE_TIMEOUT_MS` idle watchdog.

## 1.0.8

- Ending one session no longer aborts another session's in-flight turn on the shared broker.
- The watchdog reaps the broker only for a genuinely hung turn; stale-broker cleanup never kills a recycled PID.

## 1.0.7

- New `CODEX_SANDBOX_MODE` override, e.g. `danger-full-access` on hosts where Codex's `bwrap` sandbox cannot start.

## 1.0.6

- `/codex:handoff` now runs the composed prompt on Codex by default; `--print` (or `--prompt-only`) only prints it.

## 1.0.5

- New `/codex:handoff` command; delegation defaults to `gpt-5.5` at `xhigh` effort.
- **Removed** the `spark` model alias; `--model` is forwarded verbatim. Plus broad reliability fixes for jobs and the broker.

## 1.0.0

- Initial version of the Codex plugin for Claude Code.
