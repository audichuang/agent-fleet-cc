---
name: delegating-to-fleet
description: Use the MOMENT you are deciding whether to hand a task to another AI CLI — fire on the delegation DECISION itself, before reaching for any engine's verb. Routes to the right fleet engine (codex / antigravity / grok / cc) and its entry verb. Trigger cues include "delegate / hand off / offload this", "run it in parallel", "get a second opinion / independent review", "have codex / grok / agy / cc do X", plus any substantial or self-contained subtask, work needing a capability the host lacks (raster image generation, schema-enforced structured output), or an independent chunk worth offloading. Skip only for trivial or tightly-coupled work you should just do yourself.
---

# Delegating to fleet engines

You (Claude Code) are the commander. This is a routing index — it decides
*whether* to hand a task off and *which* engine fits. The how-to detail lives in
each engine's own skills and verb commands; reach for those once you've picked.

## First: should you delegate at all?

- **Do it yourself** when the task is trivial, tightly coupled to code you're
  already editing, or needs tight interactive back-and-forth.
- **Delegate** when the task is self-contained *and* either needs a capability
  you lack, or is an independent chunk worth offloading. Offloading *can* spread
  usage across another engine's quota (not cc on the native profile — that runs on
  your own account) and keeps the intermediate work out of your context;
  independent chunks can also run in parallel.

Keep delegation one hop — don't hand off a task to an engine that will itself
re-delegate. This is a design guideline, not an enforced guarantee: `/cc:task`
spawns a full Claude Code that could re-trigger this router, so keep chains flat
by choosing self-contained subtasks.

## Pick an engine (by task shape)

Each arrow points to the engine's **model-invocable** entry point — the verb you
can call yourself. Some verbs (codex/agy `task`, `review`, `image`; grok's
lifecycle/query verbs `status` / `wait` / `logs` / `result` / `cancel`) are user-run
(`disable-model-invocation`) and will not fire on their own; where a niche lives
behind one, ask the user to run it — or, for grok's watch loop, drive it by
shelling the companion directly (the gate blocks only model auto-invocation). These assume the engine is installed — if a
fitting engine's verbs aren't available, tell the user to install it (`/fleet:setup`).

- **codex** — implement an existing plan with write access → `/codex:execute-plan`;
  an independent code review / second opinion → `/codex:handoff`; investigate or fix
  → `/codex:rescue`.
- **antigravity (agy)** — offload a self-contained task (including generating
  markup / SVG / HTML as text output), or get a large-context second opinion across
  many files → `/antigravity:rescue` · `/antigravity:handoff`. Raster image
  generation (Imagen) is a separate user-run verb — ask the user to run
  `/antigravity:image`.
- **grok** — a self-contained subtask delivered in one shot, or an independent
  chunk of code/tests to offload → `/grok:task` for a quick foreground answer, or
  `/grok:live` when you want to **watch it run** (a background streaming shell —
  the visible default for anything long-running; see below). Add `--schema <path>`
  only when you need structured JSON output. `task` and `live` are the
  model-invocable entries.
- **cc** — you want another full Claude Code instance (to run in parallel, or via
  a cheaper profile/model) on an independent task → `/cc:task`.

## Keep every delegation visible — never dispatch-and-forget

When you hand off a background or long-running task, do **not** fire a detached
job and walk away: the user is then blind to whether it is running, and a silent
death only surfaces after a long, wasted wait. Default to keeping it visible — the
user should see it run *and* see it die. What "visible" means differs per engine
today (a uniform live shell is the target, not yet reality — see the ADR):

- **codex** — prefer `/codex:handoff --background`: it runs the companion in a
  Claude Code background shell (`run_in_background`), so the user watches it stream
  and sees a failure the moment it happens. Prefer this over a bare
  `/codex:task --background`, which detaches into a silent job.
- **grok** — prefer `/grok:live`: it runs the task in a Claude Code background
  shell, streaming grok's output as it works and turning red the moment it fails —
  the same live-shell experience as codex's handoff. Prefer it over a bare
  `/grok:task --background`, which detaches into a silent job. (If you instead want
  a durable detached job that outlives the session, `/grok:task --background` plus
  the watch loop `/grok:task` documents still works — each `wait` interval relays
  one liveness line; drive it by shelling grok's own companion via the command
  `/grok:task` hands you, never a reconstructed path.)
- **cc** — `/cc:status` and `/cc:wait` are model-invocable, so after a
  `--background` launch poll them directly; they report running / done / failed, so
  a death surfaces. (cc does *not* emit the alive/elapsed liveness line — that is a
  grok/agy-only projection.)
- **antigravity (agy)** — launch `--background`; agy cannot stream (it returns only
  on completion) and its `status`/`wait` are user-run (you cannot fire them
  yourself), so ask the user to watch with `/antigravity:status`, or relay agy's
  terminal result when it lands. Its visibility is the coarsest — set that
  expectation rather than promising a live stream.

Skip the watch — a truly detached, unwatched job — only when the user explicitly
asks for fire-and-forget ("just launch it, I'll check later").

grok and codex now have a true live streaming shell (`/grok:live` and
`/codex:handoff --background`); cc's is still planned — until it lands, cc uses the
`--background` + `/cc:status` / `/cc:wait` poll above. Full rationale + trade-off:
https://github.com/audichuang/agent-fleet-cc/blob/main/docs/adr/0003-visible-by-default-delegation.md
