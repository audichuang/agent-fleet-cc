# grok — changelog

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
