---
name: delegating-to-fleet
description: Use when a task could be handed to another AI CLI — deciding whether to delegate and which fleet engine (codex / antigravity / grok / cc) to reach for, then how to invoke it. Fires for substantial or self-contained subtasks, work needing a capability the host lacks (raster image generation, schema-enforced structured output), or independent chunks worth offloading. Skip for trivial or tightly-coupled work.
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
can call yourself. Some verbs (codex/agy `task`, `review`, `image`) are user-run
(`disable-model-invocation`) and will not fire on their own; where a niche lives
behind one, ask the user to run it. These assume the engine is installed — if a
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
  you need structured JSON output).
- **cc** — you want another full Claude Code instance (to run in parallel, or via
  a cheaper profile/model) on an independent task → `/cc:task`.
