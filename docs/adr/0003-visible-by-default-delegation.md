# Visible-by-default delegation: a live shell over a silent detached job

**Status:** accepted (design agreed in a grilling session 2026-07-14; the `${CLAUDE_PLUGIN_ROOT}`
linchpin was verified — see Consequences — so the mechanism stands, per-engine live verbs pending
implementation).

**Context.** When the commander delegates a background task, the default path today is a *detached*
job (`task --background`): the companion enqueues a worker, prints a job id, and returns
immediately. From the commander's — and the user's — point of view this is a **blind box**: no
sign it is running, and when it dies it dies *silently*, discovered only after waiting too long.
ADR 0002 softened this by adding a passive **liveness projection** to grok's and antigravity's
`status`/`wait`, but that is opt-in polling; nothing makes a delegation *visibly* run by default.
The user's stated priority is explicit and orders the trade-off: **"I don't fear the session
closing; I fear it dying silently."** Death-visibility outranks durability.

**Decision.** Make delegation **visible by default**. The default is a session-scoped **live
shell** — the commander runs the engine *foreground* (streaming) inside a Claude Code Bash tool
call with `run_in_background: true`, so the user sees a monitorable shell like `just release`: it is
visibly running, its output streams, and if it fails the shell exits non-zero and turns red *at
that moment*. Durable detached (`--background`) is preserved as the **explicit opt-in** for
fire-and-forget work ("close the laptop, come back later").

Scope is **all four engines, unified by principle, not by identical mechanism** — the principle is
"you always see it run and see it die":
- **codex / grok / cc** (streaming engines): a live shell. codex already has one
  (`/codex:handoff --background`, `run_in_background`). grok and cc gain their **own live verb**
  (chosen over changing `task`'s default, to keep blast radius minimal — the verb merely *exists*;
  default visibility is achieved by fleet routing to it).
- **antigravity** (cannot stream — foreground returns the whole response only on completion,
  agy AGENTS.md D-18): no live shell is possible. Its visibility is ADR 0002's liveness poll. Note
  agy's `status`/`wait` are `disable-model-invocation`, so the commander cannot fire them itself —
  the watch is either the user running `/antigravity:status` or the commander relaying agy's
  terminal result when it lands.

The **convention lives once in the fleet plugin** (`delegating-to-fleet/SKILL.md`), as routing
guidance: *never silent-dispatch; keep the delegation visible by whatever means the chosen engine
has (see the per-engine phasing below); use detached-and-unwatched only on an explicit
fire-and-forget request.* No sibling engine plugin is edited for the routing itself. Adding grok's
and cc's live verbs are **separate, isolated per-engine work-streams** (each its own CI + review),
so IRONCLAD is never violated by a single multi-plugin change.

**Phasing (why the SKILL's current guidance is not yet a uniform live shell).** The live-shell
default is reached incrementally, and the fleet routing documents the *interim* honestly:
- **codex — now.** `/codex:handoff --background` is already a `run_in_background` live shell.
- **grok — interim, then Phase 2.** Today: `--background` + the watch loop `/grok:task` documents
  (driven by shelling grok's companion, since its lifecycle verbs are user-run; it relays a liveness
  line via ADR 0002's projection). Phase 2 adds a true live-shell verb.
- **cc — interim, then Phase 3.** Today: `--background` + poll `/cc:status` / `/cc:wait` (both
  *are* model-invocable). cc does **not** call `projectLiveness` (ADR 0002 §Consequences), so it has
  no alive/elapsed liveness line — only a status projection (running/done/failed), which still
  surfaces death. Phase 3 adds a true live-shell verb.
- **agy — terminal.** Liveness poll only; no live shell ever (cannot stream).
The invariant that holds in *every* phase is the principle "never silent; the user sees it run and
sees it die" — only the richness of the mechanism improves across phases.

**Why.**
- Orders the trade-off the way the user did: a session-scoped live shell surfaces death *instantly*;
  a durable detached job hides it. Losing durability-by-default is acceptable because durability is
  still one explicit flag away, whereas silent death was unavoidable.
- The cross-engine convention is a *commander* behavior, so it belongs in fleet — the one
  cross-engine coordination surface (ADR 0001) — not duplicated into four engine plugins. This is
  the same root-cause-over-per-plugin reasoning as ADR 0002.
- "Unify by principle" is honest about physics: agy structurally cannot stream, so forcing an
  identical mechanism would be a lie. Death-visibility (the actual requirement) *is* uniform across
  all four; only live-progress richness varies.

**Considered options.**
- **A — detached durable + auto-opened tail shell (`logs --follow`).** Rejected: keeps durability
  but the tail shell can hang up to 24h following a job that never reconciles
  (`shared/lib/core/wait.mjs`), and it does not match the user's ordering (they do not want
  durability at the cost of a more complex, potentially-orphaned watcher).
- **(i) principle-only, zero engine edits (fleet routes to each engine's *current* best).**
  Rejected as the *ceiling* (kept as fallback): only codex would be truly live; grok/agy would stay
  periodic-liveness and cc a plain status poll. Chose to invest in real live verbs for the streaming
  engines (grok, cc).
- **Changing `task`'s default to visible (option b).** Rejected: enlarges blast radius to every
  explicit `/grok:task` / `/cc:task` caller. A separate live verb keeps existing behavior intact.
- **Baking "prefer visible" as a hard plugin default vs. the user's global CLAUDE.md.** The user
  chose the plugin as owner of the product default; recorded here rather than left as one machine's
  private preference.

**Consequences.**
- **Linchpin — verified (mechanism = inline substitution, NOT env inheritance).** The live-shell
  launch does not depend on `CLAUDE_PLUGIN_ROOT` being a shell env var — it is not (Claude Code only
  exports it to hook / MCP subprocesses; it is absent in ordinary Bash tool calls and not guaranteed
  to be inherited by `run_in_background` shells; `docs/specs/2026-06-20-phase2-...` reached the same
  finding). Instead, per the Claude Code plugins reference, `${CLAUDE_PLUGIN_ROOT}` is **substituted
  inline in skill / command / agent / hook content before the model reads it**. So an engine
  command body containing `node "${CLAUDE_PLUGIN_ROOT}/scripts/<engine>-companion.mjs"` is presented
  to the model as a concrete absolute path, which the model copies verbatim into a
  `run_in_background: true` Bash call. codex's `handoff.md` already ships exactly this pattern.
  (`tests/codex/commands.test.mjs` pins `run_in_background: true` for codex's `review` command, not
  `handoff` — the mechanism is proven in-tree, just not pinned on the handoff verb specifically.)
- **Architectural consequence of the linchpin:** the launch command must be authored **inside each
  engine's own plugin** — only there does `${CLAUDE_PLUGIN_ROOT}` substitute to that engine's path.
  fleet's `delegating-to-fleet` cannot emit a correct engine companion path (its
  `${CLAUDE_PLUGIN_ROOT}` is fleet's own root). This is why fleet only **routes** and each engine
  **launches** — and confirms the per-engine-live-verb decision (Q4-ii / Q5-a).
- **Guard (this session's originating bug):** the live-verb docs must make the model copy the
  already-substituted concrete path, and must forbid re-typing a literal `${CLAUDE_PLUGIN_ROOT}`
  into a raw Bash call or improvising a version-pinned cache path (`.../cache/.../<version>/...`) —
  the exact failure that started this work. Reuse the guard already added to codex's
  `codex-cli-runtime` skill.
- Default delegation is **session-scoped**: closing the session ends the live-shell job. This is the
  deliberate trade the user chose; durability remains available via explicit `--background`.
- agy is deliberately **not** brought to parity — it gets liveness polling, not a live shell — and
  the fleet routing documents this asymmetry rather than hiding it.
- Builds directly on ADR 0002's `projectLiveness`; the poll-and-relay path reuses it unchanged.
