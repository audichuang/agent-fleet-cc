# Codex tasks can run inside the Codex desktop app, over its private IPC router

**Status:** accepted 2026-10-03, shipped in codex 1.7.0 (branch `feature/codex-desktop-backend`,
commits `d928c2c`, `119cbd7`, `61e94be`). Evidence and the re-check recipe live in
`docs/codex-desktop-ipc-audit.md`; this file records why the shape was chosen.

## Context

The codex plugin drove only `codex app-server`, a process the companion spawns (or reaches
through its shared broker). The user also runs the **Codex desktop app** (ChatGPT.app on macOS,
the `chatgpt` package on Linux), and that app has things a spawned app-server does not give the
plugin in practice: a fully wired computer-use stack, its own browser, and a window where the
user can watch a run and step in. The user wanted Claude Code to hand work to the app and get the
answer back the same way it does for a CLI run.

What was found before deciding, all checked against the live app on 2026-10-03:

- The app runs a local **IPC router** at `$CODEX_HOME/ipc/ipc.sock`. Its clients include the app's
  own windows, the Codex IDE extensions and the Codex TUI (`/ide`). The window that has a thread
  loaded is that thread's **owner**. Its `thread-follower-*` methods start, steer, interrupt and
  reload a turn on the owner's behalf. A **follower** gets a full snapshot of the conversation and
  then JSON patches as the turn streams. This is how the IDE extension mirrors app threads.
- Driving the app through its UI also works: the macOS accessibility tree, the per-message copy
  button and the "copy deep link" menu. It needs the window in front and borrows the clipboard,
  and a long thread has to be scrolled. The IPC path needs none of that, and answers in tens of
  milliseconds.
- **One writer per thread.** While the app has a thread loaded, `thread/resume` from any CLI
  process fails with `already has an active writer`. The lock is clean: nothing gets corrupted,
  the second writer is simply refused.
- **The app only takes over a thread that already has a turn.** A thread created by
  `thread/start` alone is in the state DB, but the app will not load it.
- A thread created by the CLI and continued by the app keeps its context, in both directions,
  across the hand-over.

## Decision

1. **A second backend for `task`, not a third transport.** The IPC router speaks a different
   protocol from app-server JSON-RPC, so it does not sit under `AppServerClientBase`. It is a new
   module (`lib/desktop-ipc.mjs`) and a new runner (`runDesktopTurn` in `lib/codex.mjs`). The
   runner returns **the same result shape** as `runAppServerTurn`, so `status`, `wait`, `logs`,
   `result`, rendering and the job store need no backend branch.
2. **Routing: `--backend auto|cli|desktop`, default `auto`, and `--thread <id>`.** `auto` behaves
   exactly as before unless the follow-up's thread is already loaded in the app. In that case the
   single-writer lock means the CLI cannot resume it anyway, so `auto` sends it to the app. A new
   task goes to the app only when asked for with `--backend desktop`. When the user means a
   conversation they have in the app, the skill pairs `--thread` with `--backend desktop`,
   because `auto` only sees threads the app has loaded right now.
3. **A new desktop task bootstraps its thread with one tiny CLI turn.** It runs on a throwaway
   (non-broker) app-server, whose exit releases the writer lock; then the real prompt goes to the
   app. A broker would keep the thread loaded and the app could not open it.
4. **The job knows its backend.** The record carries `backend: "desktop"`. Cancel, the hard
   timeout, the crash net and the watchdog stop a desktop turn through the app
   (`thread-follower-interrupt-turn`). They **never reap the broker** for it, since the broker
   plays no part in that turn.
5. **Fail loudly, never substitute.** An approval that stays pending fails the run with that
   reason, and the turn is left waiting in the app for the user. The same goes for an app that is
   closed, a protocol version the app rejects, a thread the app stops owning mid-turn, and a
   snapshot we cannot resync. The skill tells the host to report these rather than rerun the
   prompt on the CLI: the user chose the app for what only the app can do.
6. **macOS and Linux only.** The Windows app uses a named pipe; it is reported as unsupported, not
   attempted.

## Consequences

- **A private, unversioned-for-us protocol.** The method versions are a contract with one app
  build, pinned as `METHOD_VERSIONS` in code with a source anchor. An app update that changes them
  surfaces as a `request-version-mismatch` error telling the user to use `--backend cli`, not as a
  wrong answer. The audit doc has the recipe to re-read the version map from the installed
  `app.asar`.
- **Visible side effect.** Handing a thread to the app opens it in the user's window, via
  `open` / `xdg-open codex://threads/<id>`. That is intended: the user asked to be able to watch.
  It is also why a new task never goes to the app unless asked.
- **The turn can outlive the job.** If the worker dies, or a run fails on an approval, the turn
  keeps going in the app and `cancel` no longer reaches it. The failure messages say so, and the
  turn stays visible in the app.
- **Permissions are the app thread's own.** `--write` was already metadata only in this fork (CLI
  threads always run `danger-full-access`), so the desktop path does not widen anything. It is
  still documented as such.
- **Security surface.** Anything running as the user can talk to that socket and drive a thread
  with its permissions. That was already true of the app itself; the plugin does not add a
  listener, it only connects as a client.
- **Cost.** A new desktop task spends one bootstrap turn (`effort: low`, one line). Follow-ups cost
  nothing extra.

## Alternatives considered

- **UI automation** (macOS AX tree / Linux AT-SPI, clipboard, keystrokes). It works and was
  prototyped, but it depends on the window, the clipboard and the scroll position, and the text
  comes back lossy (code blocks split into highlight tokens, tables duplicated). It is kept only
  as the way to *create* a thread when no CLI is available, and the plugin does not use it.
- **A separate `codex app-server` for desktop-like runs.** It cannot use the app's loaded thread,
  which the single-writer lock forbids, and it does not show in the user's window.
- **Changing `task`'s default to the desktop app.** Rejected: it would open windows on the user's
  machine for every delegation and change behaviour for every existing caller.
- **Naming the desktop app in the skill's `description`.** It was tried and measured. The 1.6.4
  description already triggers on every desktop-app request (20/20), and the longer one added a
  false trigger (19/20). The routing therefore lives in the skill body.
