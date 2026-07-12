# grok — changelog

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
