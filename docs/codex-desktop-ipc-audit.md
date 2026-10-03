# Codex Plugin ↔ Codex Desktop App — IPC Contract Audit

Living record of what the **codex plugin's desktop backend** (`plugins/codex/scripts/lib/desktop-ipc.mjs`,
`runDesktopTurn` / `interruptDesktopTurn` in `lib/codex.mjs`) depends on in the **Codex desktop
app's private IPC router**: what was verified, on which builds, by which evidence, and how to
re-check after an app update. The *why* is in `docs/adr/0004-codex-desktop-backend-over-private-ipc.md`;
the user-facing contract is `plugins/codex/skills/codex/references/desktop-backend.md`.

> Scope: the router protocol, the conversation-state shape the plugin reads, and the app
> behaviours the design rests on. Not covered: app-server JSON-RPC (that is
> `docs/codex-protocol-sync-audit.md`), or the app's internals beyond what the plugin touches.

---

## How to keep this current

The protocol is private and ships inside the app bundle, so there is no schema to diff. Re-check
after an app update with these steps:

1. **Re-read the method version map from the installed bundle.** It is the one object literal that
   starts with `{"thread-stream-state-changed":`. Compare it with `METHOD_VERSIONS` in
   `desktop-ipc.mjs`; only the methods listed there matter.
   ```bash
   # macOS: /Applications/ChatGPT.app/Contents/Resources/app.asar
   # Linux: /usr/lib/chatgpt/resources/app.asar
   python3 - "$ASAR" <<'EOF'
   import mmap, sys
   m = mmap.mmap(open(sys.argv[1], "rb").fileno(), 0, access=mmap.ACCESS_READ)
   i = m.find(b'{"thread-stream-state-changed":'); print(m[i:i+900].decode("utf8", "replace"))
   EOF
   ```
2. **Check that the owner-side handlers still read the same params.** Search the bundle for
   `` case`thread-follower-start-turn` ``, `` case`thread-follower-load-complete-history` `` and
   `` case`thread-follower-interrupt-turn` ``, and read about 1 KB around each (`startTurn(t.params.conversationId,
   t.params.turnStart)`, `interruptConversation(…, t.params.mode, t.params.expectedTurnId)`, and
   so on). `broadcastConversationSnapshot` is what decides who gets a snapshot.
3. **Check the framing anchor**: `../codex` `codex-rs/tui/src/ide_context/ipc.rs`
   (`write_frame` / `read_frame`, `primary_ipc_socket_path`).
4. **Run the hermetic suite**: `node --test tests/codex/desktop-backend.test.mjs` (fake router over a
   real Unix socket; it records every message on the wire).
5. **Run the live smoke on each OS you ship to** (desktop app running, a throwaway cwd):
   ```bash
   C=plugins/codex/scripts/codex-companion.mjs
   node $C setup | grep 'desktop app'                                     # reachable?
   node $C task --backend desktop --cwd "$TMP" --json "Do not read files. Run echo SMOKE once and reply with its output."
   node $C task --cwd "$TMP" --resume-last --json "Do not run commands. Repeat your last reply and add RESUME."   # auto → desktop
   J=$(node $C task --cwd "$TMP" --resume-last --background --json "Do not run commands. Print lines 1 to 3000." | jq -r .jobId)
   sleep 12; node $C cancel "$J" --cwd "$TMP"        # the log must say "Requested Codex turn interrupt"; the app shows the turn interrupted
   ```
   On Linux over SSH, run it from the SSH shell. Opening the thread must work without `DISPLAY`
   being set: the plugin borrows it.
6. **Update** the Baseline block, the tables below if anything moved, and add a row to the Audit log.

---

## Baseline

| | macOS | Linux |
| --- | --- | --- |
| Date verified | 2026-10-03 | 2026-10-03 |
| OS | macOS 27.0.1 (Darwin 27.0.0) | Ubuntu 24.04.5 LTS, GNOME on Xorg (`DISPLAY=:1`) |
| Desktop app | ChatGPT.app 26.930.21537 | `chatgpt` package 26.930.31428 |
| CLI used by the plugin (`codex` on PATH) | codex-cli 0.160.0 (Homebrew) | codex-cli 0.160.0 (linuxbrew) |
| CLI bundled in the app | codex-cli 0.159.0-alpha.12.1 | n/a |
| Node | v24.21.0 | v24.20.0 |
| `../codex` checkout read for framing | `92bc601ad6` (2026-09-30) | same |

The two app builds have the **identical method version map**. It was compared entry by entry on
2026-10-03.

---

## The wire contract the plugin depends on

**Transport.** A Unix socket at `$CODEX_HOME/ipc/ipc.sock`; `CODEX_DESKTOP_IPC_SOCKET` overrides it,
which the tests use. The app process listens on it. Each frame is a `u32` little-endian length
followed by that many bytes of UTF-8 JSON.

**Message types** (field `type`): `request`, `response`, `broadcast`, `client-discovery-request`,
`client-discovery-response`.

| Step | What the plugin sends | What it relies on getting back |
| --- | --- | --- |
| Register | `request initialize {clientType}` | `response success result.clientId` |
| Stay polite | answers every `client-discovery-request` with `canHandle:false`, and every foreign `request` with `no-handler-for-request` | the router does not wait on us when routing other clients' requests |
| Who owns the thread | `request thread-owner-discovery {hostId:"local", conversationId}` | `success` when a window has it loaded. Otherwise `no-client-found`, which comes **immediately on Linux but only after the router's ~10 s discovery timeout on macOS** |
| Follow | `broadcast thread-stream-following-changed {conversationId, hostId:"local", following:true}` (and `false` on close) | the owner adds us to its followers |
| Snapshot | `request thread-follower-load-complete-history {conversationId}` | `result.revision`, plus a `thread-stream-state-changed` broadcast `{change:{type:"snapshot", revision, conversationState}}`. **Before following, the call fails** with `no-client-found: thread stream owner became unavailable` |
| Stream | (nothing) | `thread-stream-state-changed` `{change:{type:"patches", baseRevision, revision, patches:[{op, path:[…segments], value}]}}`, RFC 6902 add/replace/remove with **array** paths |
| Start a turn | `request thread-follower-start-turn {conversationId, turnStart:{request:{threadId, turnTrigger:"composer", clientUserMessageId, input:[{type:"text", text, text_elements:[]}], model?, effort?}, context:{inheritThreadSettings:true}}}` | `result.result.turn.id` (status `inProgress`) |
| Stop a turn | `request thread-follower-interrupt-turn {conversationId, mode:"user-stop", expectedTurnId?}` | `result.interruptedTurnId` |
| Open a thread | `open` / `xdg-open codex://threads/<id>` | the app loads the thread and starts owning it (≈1 s Linux; within the 2 s poll on macOS) |
| New chat (`--new-thread-via app`) | `open` / `xdg-open codex://threads/new?prompt=<p>&path=<cwd>`, then Enter: `osascript … key code 36` (macOS) or `xdotool windowactivate --sync <id> key Return` (Linux) | a new chat in that project, with the prompt in the focused composer. Recognised params: `browserUrl`, `mode`, `originUrl`, `path`, `prompt`; **none auto-submits**. The thread id comes from the newest rollout file whose first user message is the prompt |

Every request also carries `requestId`, `sourceClientId`, `version` (per method, from the map) and
`timeoutMs`. A version the app does not accept comes back `request-version-mismatch`.

**Conversation state read by the plugin** (from the snapshot plus patches):

- `threadRuntimeStatus.type`: `idle` or `active`.
- `requests[]`: pending approvals and user-input requests. Any entry that stays longer than the
  grace period counts as "blocked".
- `turnHistory.history.entitiesByKey[*]`: one entity per turn, with `turnId`, `status`
  (`inProgress` / `completed` / `interrupted` / `failed`), `error` and `items[]`.
- Item types are the app-server `ThreadItem` shapes: `userMessage` (`content[].text`),
  `agentMessage` (`text`), `reasoning` (`summary`), `commandExecution`, `fileChange`,
  `mcpToolCall` (computer use shows up as `server:"cua_repl"`), `imageGeneration` and others. That is
  why the existing result helpers (`collectTouchedFiles`, `imageGenerationRecord`,
  `describeCompletedItem`) apply unchanged.
- `turns` at the top level is **empty**. The history lives in `turnHistory`, not `turns`.

---

## App behaviours the design rests on (verified live)

| # | Behaviour | macOS | Linux | Evidence |
| --- | --- | --- | --- | --- |
| B1 | A follower gets the full, exact text of a long answer. The text assembled from patches is byte-identical to the thread's rollout `.jsonl` | ✅ 1279 chars | ✅ 1577 chars | `ipc_e2e.py` 10/10 on both OSes |
| B2 | A turn can be started, streamed to completion and interrupted (`status: interrupted`) over IPC | ✅ | ✅ | same, plus companion `cancel` |
| B3 | Multi-turn context carries across IPC turns | ✅ | ✅ | the "what was your last line?" check |
| B4 | Nothing needs the window: the app hidden (macOS) or minimised (Linux) | ✅ | ✅ | ran hidden/minimised |
| B5 | A thread the app has not loaded has **no owner**; the deep link makes it one | ✅ ~4.8 s | ✅ ~1 s (≈4.6 s via the plugin's poll) | `autoopen.py` and the timing probe |
| B6 | **Single writer**: CLI `thread/resume` of an app-loaded thread is refused with `already has an active writer` | ✅ | (same code path) | `codex exec resume` on `[handoff-test]` |
| B7 | **CLI → app hand-over keeps context**: a thread made by `codex exec` continues in the app (`CLI-FIRST DESKTOP-SECOND`) | ✅ | ✅ (`Linux` → `Linux LINUX-RESUME-OK`) | handoff test; companion e2e |
| B8 | A thread made by `thread/start` alone (no turn) **cannot be loaded** by the app | ✅ | not re-run | `[start-only-test]` |
| B9 | Threads created outside the app (companion tasks, ACP extension) can be opened and driven by it | ✅ | ✅ | the auto-open test on two such threads |
| B10 | The negative `thread-owner-discovery` answer is slow on macOS (~10 s) and immediate on Linux | ✅ | ✅ | timing probe |
| B11 | The new-chat deep link plus one Enter creates an **app-native** thread (`originator: Codex Desktop`, `cwd` = the `path` param) that the companion then follows to completion | ✅ `VIA-APP-MAC` | ✅ `VIA-APP-LINUX` (over SSH) | companion `task --backend desktop --new-thread-via app` |

`ipc_e2e.py`, `autoopen.py` and the timing probe were throwaway Python scripts from the discovery
session. They are not in the repo. Their checks are what the hermetic suite and the companion
live smoke under "How to keep this current" now cover.

---

## What the plugin does with it

| Concern | Where | Behaviour |
| --- | --- | --- |
| Backend choice | `resolveTaskBackend` (companion) | `cli`: as before. `desktop`: probe the socket, or fail with "start the app, or use `--backend cli`". `auto`: desktop only if the follow-up's thread is owned right now; new tasks stay on the CLI. Env default: `CODEX_COMPANION_BACKEND`. Never probes on non-macOS/Linux |
| New desktop task | `runDesktopTurn` | a one-line bootstrap turn on a **non-broker** app-server (B8 and B6), then attach and start the real turn |
| Ownership probe | `DesktopThread.ownership()` | 2 s timeout: `owned` / `not-owned` / `unknown` |
| Thread lost mid-turn | heartbeat every 30 s | fails after 2 explicit `not-owned`, or 6 silent checks in a row (a busy app can miss one window) |
| Drift | `handleBroadcast` | a revision gap, or a patch that cannot apply, triggers a fresh snapshot; if the resync is refused, the run fails at once (`RESYNC_FAILED`) |
| Approvals | `runDesktopTurn` | a request pending past 3 s fails the run; the turn is left in the app; the message says `cancel` no longer reaches it |
| Interrupt | `interruptDesktopTurn` | ownership check plus `thread-follower-interrupt-turn`, without a follow or snapshot first |
| Job routing | job record `backend:"desktop"` | cancel, hard timeout, crash net and watchdog interrupt via the app; the watchdog never reaps the broker and ignores broker reachability for such jobs |
| Linux over SSH | `resolveDesktopOpenEnv` | borrows `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR` and `XDG_CURRENT_DESKTOP`, preferring the chatgpt process's own environment; `xdg-open` is capped at 10 s |
| Version drift | `describeRouterError` | `request-version-mismatch` becomes an error saying to use `--backend cli` |

---

## Test evidence

**Hermetic** (`tests/codex/desktop-backend.test.mjs` with 21 tests, plus additions to
`codex-watchdog.test.mjs` and `job-crash-net.test.mjs`). The fake router is a real Unix-socket
server that simulates ownership, snapshots, patches and turn scripts (`complete`, `approval`,
`transient-approval`, `gap`, `bad-patch`, `gap-reload-fails`, `hang`) and records every message. It
cannot reach the real `open`/`xdg-open`.

Every guard was **mutation-checked**: break the guarded line and the suite goes red, restore it and
it goes green. The guards are: `inheritThreadSettings` on the wire; bootstrap off the broker;
approval fail-fast and its grace period; revision-gap resync; bad-patch resync; resync-failure
fail-fast; the ownership heartbeat (both directions); interrupt routing in cancel, timeout, crash
net and watchdog; no broker reaping for desktop jobs; the watchdog hint; discovery answers; the
`initialize` socket leak; `following:false` on close; the win32 gate; DISPLAY borrowing and its
app-first preference; and auto routing.

Totals: `npm run test:codex` passed 518/518. `npm run build:codex` (tsc), `check-version`,
`sync-shared` drift and every other test script are green. `npm run verify` as a whole is red on
this Mac only because of two `tests/antigravity/commands.test.mjs` background tests that fail
identically on clean `main` (a 10 s spawn timeout). That is not a regression from this change.

**Live** (both OSes, 2026-10-03): a new desktop task (`Linux` / `DESKTOP-NEW-OK` / `MAC-R2` /
`LINUX-R2`), an auto `--resume-last` routed to the app (`backend: desktop`), and a background job
plus `cancel` that interrupted the app's turn (`Requested Codex turn interrupt for …`). Re-run after
the review fixes, with the same results.

**Independent review** of `d928c2c`: no data-corrupting or CLI-regressing finding. It raised nine
items. Eight were fixed in `119cbd7`: crash-net routing, patch and resync failure handling, the
owner-loss heartbeat, the `initialize` socket leak, the approval grace period, a lightweight
interrupt, follow-off, the win32 gate, the watchdog hint and the Linux open environment. One was
documented instead: `--write` is metadata on both backends in this fork.

---

## Skill evaluation (skillgenie, sonnet, dry runs)

The workspace is outside the repo at `~/Project/codex-skill-workspace` (`evals/evals.json`,
`iteration-{1,2}/`, `iteration-2/review.html`, `trigger-*.json`). The baseline is the 1.6.4 skill
(`skill-snapshot/`).

| Run | 1.7.0 skill | 1.6.4 skill | Notes |
| --- | --- | --- | --- |
| Iteration 1 (5 cases) | 19/19 | 14/19 | old: no `--backend desktop`; cannot target a thread, so it asks instead of launching |
| Iteration 2 (6 cases, +stricter thread check, +plain-task-stays-CLI) | **24/24** | 17/24 | old: 0/5 on "continue my app conversation" |
| Iteration 3 (after `--new-thread-via`; 2 cases) | 2/2 | — | "a chat the app creates itself, in snip-sync" → `--backend desktop --new-thread-via app` with the project as cwd; the computer-use case still picks `--backend desktop` without the new option |
| Iteration 4 (live-screen test in the body; 8 cases, `iteration-4/`) | routing 8/8 | — | 3 cases where the work needs a live screen but the user never says "computer use" or "desktop" (log into Grafana and read a panel, toggle a theme in snip-sync and screenshot it, click through Gitea Actions) → `--backend desktop`; 3 UI-flavoured decoys (fix a theme component, write a Playwright test, fetch a doc URL) and iterations 1–2's cases 0 and 5 route as before. Each answer cites the live-screen / files-and-terminal test. The pre-change 1.7.0 skill (`iteration-4/head-skill/`) also routed all 3 implicit cases to desktop, and kept the Playwright and fetch-a-URL decoys on the CLI, so no case discriminates in either direction: the change makes the rule explicit rather than fixing an observed misroute |
| Trigger A/B (20 queries × 3, with agy, orca-cli and ego-browser installed) | 19/20 with a desktop-app description | **20/20** with the 1.6.4 description | the longer description fired on "write a script that lists the app's threads", so the 1.6.4 description was kept (`61e94be`) |

The non-discriminating cases are the approval-wait, app-not-running and review cases: both skills
pass them, and they are kept as regression guards. No expectation yet grades the *quality* of the
prompt sent to Codex.

---

## Known limits and open items

- **Creating a thread.** The app's IPC has no "new thread" call. Either the CLI bootstrap
  (`--new-thread-via cli`) or the app's own new-chat deep link plus one Enter keypress
  (`--new-thread-via app`). The keypress is the one place the plugin touches the UI. It is not
  verified against the composer's content first, so focus moving between the deep link and the
  Enter can send nothing; the run then fails, saying "no new thread appeared".
- **An approval ends the job, not the turn.** Answering approvals over IPC
  (`thread-follower-command-approval-decision` and friends) exists but is not wired. The decision
  was fail-fast.
- **The pending-request shape** is read only as "non-empty `requests[]`". The `method` / `type`
  label in the message is best effort.
- **Process:** none of this is recorded in this repo's Hindsight bank (the work was done from
  another repo's session). Record the initiative from an agent-fleet-cc session.

## Audit log

| Date | By | Scope | Result |
| --- | --- | --- | --- |
| 2026-10-03 | Claude Code session (with the user) | Initial contract discovery, implementation, live verification on macOS and Ubuntu, review fixes, skill eval | Shipped as codex 1.7.0 on `feature/codex-desktop-backend` (`d928c2c`, `119cbd7`, `61e94be`). Not yet merged. |
