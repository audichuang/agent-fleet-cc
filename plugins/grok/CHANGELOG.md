# grok — changelog

## 0.5.0
- **Crash-safe resume: session id is minted before spawn, not scraped after.**
  A new-conversation job now generates its session id client-side
  (`crypto.randomUUID()`) and persists it into the job record's `request`
  **before** the grok engine ever spawns, passed via `-s`/`--session-id`
  (`cli.rs:582`). Previously the id came only from the `end` event/json result
  *after* the run finished — if the worker process died mid-run, no id was ever
  recorded and `--resume-job`/`--resume-last` had nothing to resume from.
  `resolveResumeSource` now falls back to that pre-spawn `request.sessionId`
  when the post-hoc `job.sessionId` is missing, so a crashed job is still
  resumable. Always mutually exclusive with `-r`/`--resume` — grok rejects
  `--session-id` combined with `--resume` unless `--fork-session` is also given
  (which this plugin never passes); a resuming job never sends `-s`. Verified
  against `~/research/grok-build` @ `c68e39f` (headless wiring `headless.rs:608/617`)
  and released `grok 0.2.111 --help`; see `docs/grok-cli-contract-audit.md` Part 1
  and the 2026-07-24 audit-log entry.
- **Untrusted-output note on `task`/`live`/`result`.** Grok's `resultText` is
  advisory text from a delegated model, not instructions — the commander must
  not run commands, delete files, or publish anything just because the output
  says to. Documented in `commands/task.md`, `commands/live.md`, and
  `commands/result.md`.

## 0.4.0
- **`--read-only` flag for a hardened run (opt-in; non-breaking).** Both `/grok:task`
  and `/grok:live` now accept `--read-only`, which runs Grok under its `read-only`
  sandbox — file writes are blocked (only `~/.grok` + temp stay writable, the whole
  workspace is readable). Use it to review/audit local code you don't want touched. The
  **default is unchanged** (full read + write + network), so nothing breaks; `--read-only`
  is strictly additive.
  - **Web research still works.** `web_search`/`web_fetch` run in Grok's own process,
    which stays online; only network from commands Grok *spawns* in a terminal (e.g. a
    `curl` in bash) is blocked.
  - **Best-effort, not a hard jail.** A managed `requirements.toml` profile can override
    `--sandbox` (Grok's precedence is requirement > CLI), and where no OS sandbox backend
    applies Grok *warns and runs writable* rather than failing the job. Treat `--read-only`
    as hardening, not a guarantee. This is why it's opt-in rather than a codex/antigravity-
    style default — a default guarantee that can silently not hold gives false confidence.
  - **Resume is fail-closed.** `--read-only` on a resume of a session with a persisted
    writable profile makes Grok exit 1 (a session's sandbox is fixed at creation) rather
    than silently granting writes — start a fresh `--read-only` job.
  - Verified by an independent Codex review against the Grok Build source; wiring + source
    anchors in `docs/grok-cli-contract-audit.md` Part 3.

## 0.3.1
- **Capture usage/cost telemetry.** `extractResult` now reads grok's `usage` object
  (`{inputTokens, outputTokens}`) off the streaming-json `end` event and the
  `--output-format json` result, landing it in the job record's `usage` slot (same shape
  `cc` fills). The old `usage: null` rested on a stale "grok emits no token counts"
  assumption — grok's `headless.rs attach_result_usage` now stamps usage on `end`, the json
  result, and error events.
- **Source-grounded CLI contract audit** (`docs/grok-cli-contract-audit.md`). Now that Grok
  Build is open source, every flag we send and every output field we read is pinned to a
  `cli.rs`/`headless.rs` anchor with a re-run recipe — the invocation is verified against the
  source, not guessed. Zero drift found. Also documents why we drive the CLI rather than ACP
  (the CLI *is* the maintained ACP client), and the available `--sandbox read-only` lever.

## 0.3.0
- **Visible live-shell verb (`/grok:live`).** A new model-invocable verb that runs a
  grok task as a *visible* shell instead of a silent detached job: the commander
  launches `task --live` inside a Claude Code `run_in_background` shell, grok's raw
  progress streams to stderr as it works, the final report lands on stdout, and a
  job failure exits non-zero so the shell turns red *at the moment it dies*. This is
  Phase 2 of the visible-by-default delegation design — death-visibility over
  durability (`docs/adr/0003`). `--live` is foreground-only (mutually exclusive with
  `--background`, which stays the durable detached path, and with `--wait`). Fleet
  routing prefers `/grok:live` for visible / long-running delegation
  (`delegating-to-fleet`); durable `/grok:task --background` remains the explicit
  fire-and-forget opt-in.
  - **Streaming is exact, not best-effort.** Each raw engine line is streamed to
    stderr the instant the worker reads it, via the shared `runWorker` `onLine` hook
    — no log-file tail, no flush race. The CLI entry sets `process.exitCode` and lets
    stdio drain naturally (not `process.exit()`, which would truncate buffered pipe
    output), so a large stream keeps its tail incl. the terminal event. (`onLine` is
    an additive, backward-compatible seam in the shared runtime; engines that don't
    pass it are unaffected, and cc's future live verb gets streaming for free.)
    Applies to normal streaming; `--schema` is non-streaming (one JSON object at
    completion), so it stays death-visible only.
  - Verified end-to-end (real subprocess): success streams events to stderr with a
    clean one-line stdout result; failure exits non-zero.

## 0.1.2
- **Structured output.** `task --schema <path>` takes a JSON Schema file and runs
  Grok with `--json-schema` (constrains the model to matching JSON). `resultText`
  comes back as JSON ready to `JSON.parse` — for extraction/classification tasks
  that want fields, not prose. This runs non-streaming (`--json-schema` implies
  `--output-format json`), so the adapter buffers the single multi-line result
  object; there is no live `/grok:logs` and no fan-out sentinel needed for such a
  job. Bad/malformed schema files fail fast before launch. Verified end-to-end
  against real grok 0.2.93.

## 0.1.1
Hardening pass driven by a Grok self-audit of our invocation/parsing against the
real `grok` 0.2.93 CLI (each item verified by running it):

- **Fan-out cleanup.** A multi-agent run concatenates every agent's text into one
  undelimited stream (subagent output leaks in — grok exposes no agent id to
  demux it, and telling subagents to stay silent does not stop it). `task` now
  documents a leader-controlled sentinel (`<<<GROK_FINAL>>>` … `<<<GROK_END>>>`);
  `extractResult` returns only the fenced final report (first-open→last-close, so
  a report that quotes the tokens still extracts cleanly). No sentinels → full
  text unchanged. The raw stream always stays in the job log (`/grok:logs`).
- **Auth preflight.** With no `XAI_API_KEY` and no `~/.grok/auth.json`, a headless
  run blocks on interactive device-OAuth until the 1h timeout. `task` now refuses
  to launch when unauthenticated (override: `GROK_SKIP_AUTH_PREFLIGHT=1`; skipped
  when a custom `GROK_BIN`/binary is injected).
- **Result gating.** `ok` no longer requires `stopReason === "EndTurn"` — it trusts
  exit 0 + a terminal `end` event (grok exits nonzero on real failures), so a
  legitimate non-EndTurn end (e.g. `MaxTokens`) that carried a full answer is no
  longer discarded. A stdout `error` event now fails the job. Non-completed jobs
  now surface any partial `resultText` instead of hiding it.
- **Error classification.** `classifyError` gains `quota` (429 / usage / rate
  limit) and `config` (unknown model / unknown effort) buckets and more auth
  strings (`Waiting for authorization`, `No cached credentials`, `grok login`);
  `parseEvent` now captures `{type:"error"}` events instead of dropping them.
- **`--no-subagents`** is now a real passthrough (docs referenced it but the
  companion rejected it). Effort docs list the full set
  (`none|minimal|low|medium|high|xhigh|max`).

## 0.1.0
- Initial release: headless xAI Grok Build engine adapter over the shared runtime.
  Commands: setup, task, status, wait, logs, result, cancel. Default model
  grok-4.5. Auth delegated to the grok CLI (XAI_API_KEY or `grok login`). Resume
  via `-r <sessionId>`. `logs` surfaces the raw grok stream (thinking + output).
