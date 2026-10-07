# GPT-6.1 Prompting

Use this when composing a prompt for Codex, before the host calls the companion.

GPT-6.1 works best outcome-first: name the outcome, the success criteria, the constraints, and the files, then leave the path open. A process script from an older model adds noise. The 6.1 harness already covers autonomy, skills, plugins, and apps, so restating those is noise.

## Model selection

**Route by which job it is, not by price.** This file quotes no prices. A written price table rots the first time OpenAI reprints it, and nothing here would go red. Slugs and effort levels come from the catalog: the companion `setup` verb probes `model/list`, and the offline read is `~/.codex/models_cache.json`.

Pass an explicit slug. The plugin does not rewrite names. The old family alias `gpt-5.6` was rejected with HTTP 400, so do not invent a `gpt-6.1` alias either.

| Model | Job | Route here when |
| --- | --- | --- |
| **gpt-6.1-sol** | **workhorse** (default) | Everyday coding, planning, diagnosis, review, and long runs. The companion sends this when `--model` is omitted. |
| **gpt-6-astra** | **frontier** | The most demanding work, and only when the user asks for it (`--model gpt-6-astra`). |

Delegation is for a stronger model to review and explain. Do not pass `--model gpt-6-sol` or `--model gpt-6-luna`. If `gpt-6.1-sol` is gated, the turn fails with the gate message; the companion does not retry on a weaker slug. Do not pass a service tier. The companion has no Fast path.

`gpt-6.1-sol` can generate images. The companion enables `image_generation` and returns each saved path. Say which slug you chose when it is not the default. `setup` warns, without blocking, when the configured default is missing from `model/list`.

The companion defaults effort to `xhigh` for a task and for a review, once, at the start of the run. It does not change effort mid-turn. The catalog's own default for `gpt-6.1-sol` is `low`; the override is intentional. Keep delegated work in the `high` → `xhigh` → `max` band, and reserve `max` for the hardest pass. The catalog also advertises `ultra`. The companion rejects it, because that level hands the turn to agents this runner cannot observe.

## The reviewer role

Most delegations here are an independent second opinion on work the host just did. Stay on the workhorse. The value is catching what the author missed, so tell Codex it did not write the change.

For local git changes, use the companion `review` / `adversarial-review` verbs. Those prompts already carry the review contract. Reach for a hand-built `task` prompt only when the target is not the working tree.

When you do write one, name the lenses and require each to be weighed: correctness, contract, edge cases, concurrency, security, performance, error handling, tests, maintainability. Separate confirmed issues from suspicions. Every finding needs `file:line` and a concrete failure. Omit `--write` unless the user asked for fixes.

## Core rules

- State the goal and what done looks like. A numbered procedure narrows the search.
- Add a line only to close a gap you have already seen. "Be concise" makes GPT-6.1 drop required content. Say "lead with the conclusion and keep the required facts" instead.
- Save `ALWAYS` / `NEVER` for invariants: required output fields, and actions that must not happen. Judgment calls get a decision rule.
- Say the permission once, as what Codex may do and what is out of scope. A running job has nobody to answer a question, so "ask first" ends the run with the question as its answer. Codex already has full access and no approvals: name the boundary ("do not push; report the command instead") rather than asking it to wait for confirmation.
- GPT-6.1 will loop, so include a stop rule. Copy the wording from [prompt-blocks.md](prompt-blocks.md) rather than inventing a longer one.
- Give absolute file paths and have Codex read them. When validation exists, name the check (tests, types, build, or a smoke run). Lines that reliably hurt are in [codex-prompt-antipatterns.md](codex-prompt-antipatterns.md).

## How to choose prompt shape

- Use the companion `review` / `adversarial-review` verbs when the job is reviewing local git changes.
- Use `task` when the task is diagnosis, planning, research, implementation, or image generation and you need to control the prompt.
- Use `task --resume-last` for a follow-up on the same Codex thread. Send only the delta.

Which process hands the work over is a separate choice: [delivery-paths.md](delivery-paths.md).

## Suggested structure

Omit any section the task does not need. Complete templates are in [codex-prompt-recipes.md](codex-prompt-recipes.md).

```text
Role: [1-2 sentences]
# Goal
# Success criteria
# Constraints
# Output
# Stop rules
```

## Output language

Prose in the user's language. Structural headers (`Role`, `Goal`, `Success criteria`) and technical directives in English. Keep identifiers as written. Put the finished prompt in a fenced `text` block so it can be passed through `--prompt-file`.

That language rule is for the prompt a person reads. The language of Codex's answer is decided per task.
