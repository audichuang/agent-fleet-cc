# grok — changelog

## 0.7.0
Sync pass against **released `grok 1.0.5`** (upstream `9fabade`; the plugin had been audited
against `1.0.0` / `8a14c91`). Nothing we send is rejected and nothing we read was renamed —
`headless/cli.rs` and the whole `headless/reducer/` NDJSON emitter are byte-identical across the
diff, so Part 2 of the contract has no drift at all. What the pass *did* find were four
pre-existing defects the durable checklist had been carrying as verified, plus a new verb.

- **`/grok:image` — Grok Imagine, wired.** `image_gen` is registered on the headless path by
  default (`.default(true)`, `requires_expr = Expr::True`, no `AgentMode::Headless` gate anywhere
  in the chain), and the absolute path it saves reaches us twice: in grok's final text if we ask
  for it, and on the `tool_call_update` line's typed `rawOutput`. So the verb is **prose over the
  existing `task` verb — zero new JS**: a canned `image_gen` prompt, `--no-subagents`, and a
  600s foreground timeout (the tool alone is allowed 300s in-engine and the proxy can go a minute
  without a byte). The success criterion is **the file on disk**, never grok's prose: a free /
  X Basic tier is server-side zero-limited and `image_gen` returns the SuperGrok upsell as a
  **successful** tool result, so failure looks exactly like success. JPEG magic bytes are a
  warning only — upstream names every file `.jpg` and saves whatever the API returned.
- **`--no-memory` was a no-op in the only mode this plugin uses.** `headless.rs` hardcodes
  `memory_enabled_override: None`; `PagerArgs::memory_enabled_override()` is consumed solely by
  the interactive `ConnectFlags` path, and `HeadlessOptions` has no memory field at all. So a user
  with `[memory] enabled = true` who asked for an isolated one-off got memory anyway — exactly
  the population the promise was aimed at. The flag stays in argv (it costs nothing if upstream
  ever wires it) and the run now also carries `GROK_MEMORY=0`, the tier headless actually
  resolves, injected last so it beats a `GROK_MEMORY=1` in the user's shell. Pre-existing since
  before the previous audit baseline; 1.0.5 only aggravated it by hiding the flag from `--help`
  and relabelling it "Legacy compatibility flag".
- **`classifyError`'s `endpoint` bucket was dead against the engine we ship against.** It matched
  Node/undici codes (`ENOTFOUND`, `ECONNREFUSED`, `fetch failed`, …) which appear in grok's Rust
  tree only in comments and tests. grok is a Rust CLI: its capacity and 5xx failures arrive as
  prose ("Grok is temporarily overloaded … (HTTP 529)", "Model is temporarily overloaded. Try
  again in a moment.", "http client init failed: …"), so every transient failure was labelled
  `unknown`. Now matched on the real copy — using the full phrase `grok is temporarily
  unavailable`, because the binary also carries "Authentication temporarily unavailable" and the
  auth bucket does not catch it. The `config` bucket also gained a failed `-r` resume, which
  reported `unknown` until now.
- **The auth preflight checked 2 of grok's sources and hard-refused the rest.** It accepted only
  `XAI_API_KEY` and a literal `$HOME/.grok/auth.json`, so a user authenticated via `GROK_HOME`,
  `GROK_AUTH_PATH`, `GROK_AUTH` or the legacy `GROK_CODE_XAI_API_KEY` was told "not
  authenticated" and the launch never happened. Broadened to those, with the auth file resolved
  the way grok resolves it. `GROK_DEPLOYMENT_KEY` is deliberately **not** accepted —
  `resolve_credentials` never consults it, so honouring it would wave a deployment-key-only user
  into the device-code hang the preflight exists to prevent.
- **`GROK_BIN` silently disabled that preflight.** It is a real deployment override (a
  bubblewrap-wrapped grok, a non-PATH install), not just a test seam, so pointing it at a real
  binary lost the guard entirely and re-opened the failure it was written to prevent. The skip now
  keys on the in-process fake seam only; `GROK_SKIP_AUTH_PREFLIGHT=1` remains the documented
  escape hatch.
- **A crashed job is resumable, and now says so.** The resume tip and the `--json` `sessionId`
  both read only the post-hoc id that a *normal* finalize writes — so the crash-safe pre-minted
  `request.sessionId`, which exists precisely for a worker that died mid-run, was hidden in the
  one shape where it matters most. Both readers use the two-field predicate now.
- **`--resume-job` no longer accepts a still-running job.** `--resume-last` already refused one;
  the explicit form validated only that the job existed and had a session id, so `-r` could point
  at a session another live worker was still appending to. Same guard, both paths.
- **Fail fast on empty input.** An empty (or whitespace-only) `--schema` or `--prompt-file` died
  at engine spawn with grok's own message; both now fail locally with the reason.
- **Stopped re-enumerating a runtime catalog.** `commands/task.md` named `grok-4.5` as the only
  model and `low|medium|high` as the only efforts — and used `xhigh` as its example of a
  job-killing level. The live catalog now holds `grok-4.6`, which offers `xhigh` and is the CLI's
  own default. That claim rotted in 14 days, so the enumeration is gone rather than refreshed:
  `grok models` is the authority, effort levels are per-model. (The plugin's default is still
  `grok-4.5` — moving it is a product decision, not a doc fix.)
- **Live-verified against real `grok 1.0.5`.** One generation (35s, exit 0, a 431KB JPEG)
  turned three source-read claims into observed ones: `image_gen` really is registered on the
  headless path (it shows up in `available_commands`), tool events really do reach the raw job
  log, and the `tool_call_update` line really carries no `toolName` — with `rawOutput` coming
  back as `{type:"ImageGen", path, filename, session_folder}` where `session_folder` is the bare
  directory name and `uploaded_url` is simply absent for local output. Only the tier-restricted
  branch is still source-read (the account under test has SuperGrok, so it never fired). The run
  also found a doc gap the source could not: **the companion takes no `--cwd`** — the run's cwd
  is the invoking shell's, which `commands/image.md` now says explicitly.
- **`Authentication temporarily unavailable` no longer lands in `unknown`.** The `endpoint`
  bucket deliberately requires the full phrase "grok is temporarily unavailable" so it cannot
  steal that string — but the `auth` bucket matched `authenticate`, which is not a substring of
  "Authentication", so nobody caught it. Now `authenticat`, which covers both.
- **Anchors re-pinned to the binary we actually run.** Part 1's `cli.rs` pins had drifted +8..+16
  lines and Part 3's sandbox pins ~50-70 after upstream's 481-line `config/mod.rs` rewrite;
  behaviour is unchanged across it. `docs/grok-cli-contract-audit.md` carries the new pins, the
  Imagine surface, and the re-run recipes.

## 0.6.0
Sync pass against **released `grok 1.0.0`** and grok-build `8a14c91` (the plugin had
been audited against `0.2.111` / `c68e39f`). No flag we send is rejected and no field
we read was renamed — the whole `headless/reducer/` refactor is invisible to us. What
changed is what we *claimed*:

- **`--read-only` now needs bubblewrap on Linux, starting is still not proof it is
  enforcing, and on Windows it does nothing at all.** Three distinct modes, and the
  plugin described none of them correctly:
  *startup* became fail-**closed** (read-only is a hook-write-deny-enforcing profile,
  so grok re-execs under bwrap and prints `Refusing to start …` + **exit 1** when bwrap
  is missing or a hook plan cannot be prepared), while *enforcement* is still
  fail-**open** (bwrap binds `/` read-write and only protects grok's own hook paths;
  the layer that actually blocks writes is Landlock, which warns "continuing without
  sandbox" and runs writable on a kernel that lacks it — and the refusal that would
  catch that is skipped once inside bwrap); and on **Windows** the sandbox `apply` is a
  no-op stub and the refusal path is not even compiled, so a fresh run starts and
  enforces nothing (the resume-conflict exit still fires on every OS).
  `adapter.mjs`, `AGENTS.md`, `commands/task.md`, `commands/live.md` all
  previously promised plain "warns and runs writable" and are corrected.
  `--read-only` stays **opt-in**: it can refuse to start, it can silently not enforce,
  and a managed `requirements.toml` still outranks it.
  Mechanism + anchors: `docs/grok-cli-contract-audit.md` Part 3 caveat 2a/2b/2c.
- **`classifyError` buckets grok's sandbox refusals as `config`.** They exit 1 with
  "No such file or directory" (never the token `ENOENT`), so they used to fall through
  to `unknown` — hiding a one-command fix (`apt install -y bubblewrap`) behind a
  mystery failure. Two tiers, because the refusal text embeds user-controlled paths
  verbatim: the unambiguous `Refusing to start` phrase is matched **first**, above
  every other bucket (a configured hooks-path of `/tmp/quota` would otherwise be read
  as a quota error), while the broad `bwrap|bubblewrap|write-deny|…` net stays **last**
  as a wording-change fallback — those words also appear in ordinary paths
  (`GROK_BIN=/opt/bwrap/grok` → `spawn … ENOENT` is `not-installed`, not `config`).
- **The shared runtime can now take a failure reason from the adapter.**
  `extractResult` gained an optional `error`, which the worker prefers over the stderr
  tail (`shared/lib/runtime/worker.mjs`). Purely additive — no other engine sets it, so
  `cc`/`codex`/`antigravity` behavior is unchanged. Needed because grok exits **0** on a
  schema failure, so the old fallback persisted "engine exited nonzero" on an exit-0 job.
- **`--effort` no longer advertises levels the model rejects.** The catalog decides:
  `grok-4.5` offers only `low|medium|high`, and a canonical-but-unoffered level
  (`none`, `minimal`, `xhigh`, `max`) kills the job *after* the session opens. The
  usage line and both command docs now say `low|medium|high` and defer to
  `grok models`. No client-side allowlist — the catalog is fetched at runtime and any
  hard-coded list rots.
- **`commands/task.md` no longer advertises `grok-composer-2.5-fast`** — no such model
  id exists.
- **A `--json-schema` job that produced no structured output now fails.** grok exits 0
  and signals it only via `structuredOutputError`; we were recording the job as
  `completed` with the un-schema'd prose as `resultText`, so a caller parsing it as
  JSON failed far from the cause. The failure keeps `sessionId` and `usage` so the job
  stays resumable and its cost recorded.
- **Oversized prompts no longer die as `spawn E2BIG`.** The real ceiling is
  MAX_ARG_STRLEN — 131071 bytes for a *single* argv element — not ARG_MAX (~2MB), as
  the old comment claimed; `/grok:task --prompt-file` reaches it with a ~128 KB file.
  Past `PROMPT_ARGV_LIMIT` the adapter now passes `--prompt-file` pointing at the
  `prompt.txt` the worker already wrote (no new file, nothing to clean up).
- **The fake engine stopped lying.** `tests/grok/fake-grok.mjs` emitted CamelCase
  `stopReason: "EndTurn"` where 1.0.0 emits snake_case `end_turn` — harmless today
  only because `extractResult` deliberately never compares it, but it is the repo's
  only written record of grok's stdout. It now also emits real `tool_call` /
  `tool_call_update` lines so `parseEvent`'s tolerance of them is a test, not a claim.

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
- **Three more opt-in flags for `/grok:task` and `/grok:live`.**
  `--research` swaps the toolset to `x_search,web_search,web_fetch` via
  `--tools` — an **authoritative** allowlist (every other built-in tool
  simply doesn't exist for the run, stronger than `--read-only`'s best-effort
  sandbox); MCP tools are a separate, weaker layer, so `--research` also sends
  a **cooperative** `--deny MCPTool` backstop since headless always loads the
  user's MCP servers regardless. `--max-turns <n>` caps agent turns as a
  runaway-cost fuse (handy for unattended `--background` jobs); the companion
  validates it's a positive integer before creating a job. `--no-memory` skips
  Grok's cross-session memory for a one-off, reproducible run. All three are
  per-invocation behavior flags — orthogonal to `--read-only`/`--no-subagents`/
  resume, no auto-imply, no mutual exclusion. Anchors in
  `docs/grok-cli-contract-audit.md` Part 1 and the wave-2 2026-07-24 audit-log
  entry.

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
