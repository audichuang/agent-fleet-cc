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
  chunk of code/tests to offload → `/grok:task` (add `--schema <path>` only when
  you need structured JSON output). Only `task` is model-invocable. For a long
  job, launch `--background` and watch it with the poll loop `/grok:task`
  documents — each `wait` interval returns one compact liveness line (alive /
  elapsed / last activity / working-tree changes) instead of a silent block.
- **cc** — you want another full Claude Code instance (to run in parallel, or via
  a cheaper profile/model) on an independent task → `/cc:task`.
