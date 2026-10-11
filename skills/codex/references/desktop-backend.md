# Running a task in the Codex desktop app

`task` normally drives a `codex app-server` the companion spawns. With the desktop backend
the turn runs inside the user's Codex desktop app instead (ChatGPT.app on macOS, the
`chatgpt` package on Linux). The companion talks to the app over its local IPC socket
(`$CODEX_HOME/ipc/ipc.sock`) and follows the thread live, so the job record, `status`,
`wait`, `logs`, `result` and `cancel` behave as they do for a CLI run.

## When it is the right backend

| The user wants… | Run |
| --- | --- |
| Work that needs hands on a live screen (the test in `SKILL.md`), or a run they can watch in the app | `task --backend desktop "<prompt>"` |
| A follow-up in a conversation they have in the app (a `codex://threads/<id>` link) | `task --backend desktop --thread <id> "<prompt>"` — without `--backend desktop`, auto sends it to the app only while the app has the thread loaded |
| A follow-up on the last companion task, which is now open in the app | `task --resume-last "<prompt>"` (auto routes it) |
| A review, or anything else | the CLI default; review verbs have no desktop backend |

`--backend auto` is the default and only differs from `cli` when the thread is already open in
the app. A new task without `--backend desktop` always stays on the CLI. `CODEX_COMPANION_BACKEND`
sets the default for a session.

The thread id is in the app's deep link (`codex://threads/<id>`), in `status --json`, or in the
companion's `Thread ready` (CLI) or `Attaching to thread` (desktop) progress line.

## What happens on the user's machine

- **A new desktop task needs a thread first**, and the app's IPC cannot create one. There are two
  ways, chosen with `--new-thread-via`:
  - `cli` (default): a one-line bootstrap turn on a throwaway app-server, then the real prompt goes
    to the app. No UI involved, so it is safe while the user is typing. It costs one tiny turn.
  - `app`: the app makes the thread itself. A new chat opens in the project with the prompt filled
    in, and the companion presses Enter once in the app's window, about 4 s later (a busy app can take
    seconds to open the chat). The thread is native to the app, with no extra turn, and
    runs on the model selected in the app, not the companion's default. It takes window focus for a moment, and needs Accessibility permission for the
    terminal (macOS) or an X11 session (Linux). Use it when the user is watching and wants an
    app-native chat. `CODEX_COMPANION_NEW_THREAD_VIA=app` makes it the default.
- **The thread opens in the app.** If the app has not loaded the thread, the companion opens it
  with the `codex://threads/<id>` deep link (`open` on macOS, `xdg-open` on Linux). The user sees
  it. Over SSH on Linux the companion borrows the graphical session's `DISPLAY` from the
  user's own processes.
- **One writer per thread.** While the app has a thread open, the CLI cannot resume it
  (`already has an active writer`). That is why auto sends such follow-ups to the app.
- **The turn stops with the job.** When the job hits its time cap (3 hours unless
  `CODEX_JOB_TIMEOUT_MS` was set at launch) the companion interrupts the turn in the app; if the
  worker has died, the watchdog does. `cancel` stops it the same way. None of them touches the
  broker for a desktop job.
- **The thread works in the launch checkout as it is.** The companion does not fetch or make a
  worktree. Fetch any commit the prompt names before launching, or Codex's `git show` fails.

## Computer-use confirmations

Full access covers files and commands, not UI actions. On the models that carry one (the
`confirmation_policies` in the model catalog; read it there, it changes and not every model has
it), the computer-use policy sorts UI actions into ones it does freely, ones it does only when
the prompt **explicitly** named them (changing app settings or the theme, deleting test data,
logging in, accepting OS permission prompts), ones it always confirms at the moment (a CAPTCHA,
a permanent delete), and ones the user must do themselves (a certificate warning, credential
changes, transfers and other consequential financial actions; an ordinary purchase can be
pre-approved by naming the payee, the item and a spending limit). A prompt that says "follow this file" is not explicit approval for what
the file asks: list each such action in the prompt itself.

A stop for confirmation does not fail the job. The turn ends early and its answer is a question,
so a run meant to take hours "finishes" in minutes. Relay the question to the user. If it asks
them to do the step themselves, they do it in the app first. Then continue the same thread with
`task --backend desktop --thread <id>`, not a fresh run.

## Failures and what to tell the user

| Message contains | Meaning | Next step |
| --- | --- | --- |
| `is waiting for … on thread` | The turn stopped on an approval in the app. It is still running there, and the job no longer tracks it: `cancel` will not stop it. | The user approves or denies it (or stops it) in the app, then a follow-up with `--thread <id>` if more is needed. |
| `no longer has thread … open` | The user closed the thread in the app mid-turn. The outcome is unknown. | Ask the user to check the thread in the app. |
| `you need to use auto review` | The workspace requires auto-review on this model, and refuses the full access the companion asks for. | Rerun with `CODEX_SANDBOX_MODE=workspace-write` in the environment: the turn then keeps the thread's own permissions. |
| `not reachable` / `not running` | The app is closed, or this OS has no app socket. | Ask the user to open the Codex desktop app, or run on the CLI with `--backend cli`. |
| `version mismatch` | The installed app speaks a different IPC version than this skill. | Use `--backend cli` and report it; the skill needs an update for that app build. |
| `did not load thread` | The app never took the thread, usually because a CLI process still holds it. | Wait for that run to end, then retry. |
| `no new thread appeared` / `Could not press Enter` | With `--new-thread-via app`, the prompt was filled in but the companion could not confirm it was sent (focus moved, no Accessibility permission, no X11, or the thread was slow to appear). | The user checks the app: sends the prompt if it is still in the composer, or follows the run if it started. Do not rerun before that; a sent prompt would run twice. |
| `already running a turn` | The thread is busy in the app. | Wait, or let the user stop it in the app. |

Report the failure as printed. Do not rerun the prompt on the CLI on your own: the user chose
the app for what only the app can do.

## Limits

- The IPC protocol is private to the desktop app. It can change with an app update; a change
  surfaces as the version-mismatch failure above, not as a wrong answer.
- `--write` changes nothing on either backend. Both run with full access and no approvals: a
  CLI thread is made that way, and the companion asks for it on every desktop turn it starts.
  `CODEX_SANDBOX_MODE` narrows the CLI and leaves a desktop turn on the thread's own permissions.
- `--new-thread-via app` is the exception: the app starts that first turn itself, with the
  permissions selected in the app. Set full access there before the run if the task writes
  outside the project or uses the network (ssh, installs).
- Anything running as the user can talk to that socket.
