---
name: delegating-to-fleet
description: Use when a task could be handed to another AI CLI — deciding whether to delegate and which fleet engine (codex / antigravity / grok / cc) to reach for, then how to invoke it. Fires for substantial or self-contained subtasks, work needing a capability the host lacks (image generation, schema-enforced structured output), or independent chunks worth offloading. Skip for trivial or tightly-coupled work.
---

# Delegating to fleet engines

You (Claude Code) are the commander. This is a routing index — it decides
*whether* to hand a task off and *which* engine fits. The how-to detail lives in
each engine's own skills and verb commands; reach for those once you've picked.

## First: should you delegate at all?

- **Do it yourself** when the task is trivial, tightly coupled to code you're
  already editing, or needs tight interactive back-and-forth.
- **Delegate** when the task is self-contained *and* either needs a capability
  you lack, or is an independent chunk worth offloading — offloading spreads
  usage across the engine's own quota and keeps the subtask out of your context,
  and independent chunks can run in parallel.

Delegation is one hop: the engine does the task and returns a result. Engines
never re-delegate to each other — you are the only orchestrator.

## Pick an engine (by task shape)

Each arrow points to the engine's **model-invocable** entry point — the verb you
can call yourself. Some verbs (codex/agy `task`, `review`, `image`) are user-run
(`disable-model-invocation`) and will not fire on their own; where a niche lives
behind one, ask the user to run it.

- **codex** — implement an existing plan with write access → `/codex:execute-plan`;
  an independent code review / second opinion → `/codex:handoff`; investigate or fix
  → `/codex:rescue`.
- **antigravity (agy)** — offload a self-contained task, or get a large-context
  second opinion across many files → `/antigravity:rescue` · `/antigravity:handoff`.
  Image generation (Imagen) and markup live behind user-run verbs — ask the user to
  run `/antigravity:image`.
- **grok** — a self-contained subtask delivered in one shot, especially when you
  want structured (JSON) output; or an independent chunk of code/tests to
  offload. → `/grok:task --schema <path>`
- **cc** — you want another full Claude Code instance (to run in parallel, or via
  a cheaper profile/model) on an independent task. → `/cc:task`

## Time-sensitive notes (re-check on model updates)

- agy's markup/SVG strength is tied to its default Gemini 3.5 Flash tier in
  `--print` mode. If agy's default model changes, re-verify before relying on it.
