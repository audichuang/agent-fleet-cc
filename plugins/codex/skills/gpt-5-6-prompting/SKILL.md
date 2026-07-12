---
name: gpt-5-6-prompting
description: Internal guidance for composing GPT-5.6 / Codex prompts for coding, review, diagnosis, research, and handoff tasks inside the Codex Claude Code plugin
user-invocable: false
---

# GPT-5.6 Prompting

Use this skill when composing a prompt for Codex / GPT-5.6 — both when `codex:codex-rescue` delegates a `task`, and when `/codex:handoff` produces a prompt for the user to paste into Codex.

GPT-5.6 works best with **outcome-first** prompts: define the target outcome, success criteria, constraints, and available context, then leave the model room to choose the path. Do not carry over process-heavy instruction stacks from older models — they add noise, narrow the search space, and produce mechanical answers.

## Model selection (which gpt-5.6 variant)

This plugin picks between two variants. Their roles are distinct — **do not treat them as interchangeable "big vs small" of the same thing**:

- **`gpt-5.6-sol`** — the **thinker**. Hard multi-step reasoning, long autonomous work, and **making the detailed plan**. High-stakes review and tricky diagnosis. This is the default (`--model` unset → `gpt-5.6-sol`).
- **`gpt-5.6-terra`** — the **executor**. Best price/performance (cheaper than `sol`) for **carrying out an already-clear plan**: routine edits, bounded implementation, mechanical changes where the thinking is already done.

**Decision rule (to avoid confusion):** *Sol plans and cracks the hard reasoning; Terra executes a plan that's already clear.* If the task still needs figuring-out → `sol`. If the what-to-do is settled and it's mostly execution/cost matters → `terra`.

| Model | Role | Input / Output ($/1M) | Reach for it when |
| --- | --- | --- | --- |
| **gpt-5.6-sol** | Thinker / planner (default) | $5.00 / $30.00 | Complex reasoning, planning, long autonomous work, high-stakes review, hard diagnosis. |
| **gpt-5.6-terra** | Executor (cost-efficient) | $2.50 / $15.00 | Executing a clear plan, routine edits, bounded implementation — cheaper than `sol`. |

Both share a 1.05M-token context window and 128K max output. Always pass an explicit slug. Default to `sol`; switch to `terra` when the work is plan-execution or the user asks to control cost, and say which you chose and why when it isn't the default. (A third variant, `gpt-5.6-luna`, is a fast/cheap lightweight tier for high-volume work — rarely the right fit here.)

> Not every Codex version/account is gated into 5.6 yet. `/codex:setup` probes the account's `model/list` and warns (without blocking) when the configured default isn't available, pointing the user to `codex update` or a `CODEX_DEFAULT_MODEL` override.

## The reviewer role (this plugin's primary use)

Most delegations here cast Codex as an **independent, multi-angle reviewer** — a cross-model second opinion on work Claude just did (code review, plan/spec gate, root-cause check). This is the `sol` "thinker" role above. Its value is catching what the author missed, so position it to disagree, not to agree.

- **Role framing.** "You are a senior/staff engineer doing an independent review. You did not write this; your job is to find what's wrong, not to confirm it's fine." Make the independence explicit — it must not rubber-stamp Claude's work.
- **Sweep multiple angles, not the first bug.** Name the lenses and require each be weighed: correctness / logic, contract & API violations, edge cases & failure modes, concurrency / races, security, performance, error handling & data loss, test coverage, maintainability. One finding per lens beats one obvious bug.
- **Adversarial stance.** Ask it to try to break the change / refute the diagnosis — construct the input or sequence where it fails. Default to skepticism when evidence is thin, and separate **confirmed** issues from **needs-verification** suspicions.
- **Ground every finding.** `file:line` + a concrete failure scenario (specific inputs → wrong output / crash) + a severity. No hand-waving; say "Need to verify" when it cannot confirm.
- **Output contract.** Severity-ranked findings, each with location, why it's wrong, and a fix direction. An explicit "no issues found in X" when a checked area is clean. Don't pad — a short correct list beats a long speculative one.
- **Effort & model.** Review is high-stakes → `sol` at `xhigh` (default); escalate to `max` for the hardest or most safety-critical reviews. Keep it read-only unless the user asked for fixes.
- **Use the built-ins first.** For reviewing local git changes, prefer the `review` / `adversarial-review` commands — they already carry this contract. Reach for `task` with a hand-built review prompt only when the target isn't the working tree (a design doc, an inherited diagnosis, a specific file set). When you want several independent takes cross-checked rather than one, that is the adversarial-generation pattern.

## Core rules (from the official GPT-5.6 prompting guide)

- **Outcome-first, not process-first.** State the goal and what "done" looks like; don't script every step. Avoid "first inspect A, then B, then compare every field, then…".
- **Shorter prompts win.** GPT-5.6 has absorbed most older harness boilerplate as default behavior. Start with the smallest prompt and tool set that reliably completes the task; add instructions or examples only to close a proven gap. Long, explicit system prompts tend to trigger extra exploration and repeated validation.
- **Don't ask for generic brevity.** GPT-5.6 is already biased toward compression and is sensitive to "be concise / keep it short" — those can make it drop required content. Instead prioritize: "Lead with the conclusion. Keep required facts, decisions, caveats, and next steps; trim intros, repetition, and generic reassurance."
- **Use `ALWAYS` / `NEVER` / `must` only for true invariants** — safety, required output fields, actions that must never happen. For judgment calls (when to search, ask, use a tool, keep iterating) write **decision rules** instead.
- **Define autonomy and permissions once.** GPT-5.6 is proactive; state what a request authorizes in one compact policy (safe local actions without asking; confirm for external writes, destructive actions, or scope expansion). Do not repeat "ask first" / "do not mutate" throughout — repetition causes needless permission checks.
- **Always include stop rules.** GPT-5.6 will loop; tell it when to stop. Example: "After each result, ask: can I answer the user's core request now with cited evidence? If yes, answer."
- **Reasoning effort: default `xhigh`, floor `high`.** The companion defaults `--effort` to `xhigh` when unset. For the substantial coding / review / diagnosis work this plugin delegates, keep effort in the **`high` → `xhigh` → `max`** band — don't drop to `low` / `minimal` / `none`, they buy nothing for these tasks. **`max`** is GPT-5.6's top reasoning tier (above `xhigh`); reserve it for the hardest quality-first tasks and compare it against `xhigh` before making it the default rather than reaching for it by reflex.
- **Give it a way to check its work** when validation is possible — targeted unit tests for changed behavior, type/lint checks, build checks, or a minimal smoke test. If validation can't run, say why and give the next best check.
- **Ground factual claims.** Define what needs support, what counts as enough evidence, and what to do when evidence is missing (absence of evidence is not a factual "no"). Add a retrieval budget for search-capable tasks.
- **Files: give absolute paths.** If the target can read files (Codex, Claude Code), list absolute paths and have it read them itself — never ask anyone to paste code.

## When to add what

- **Coding / debugging:** success criteria + a verification loop (tests/lint/build) + "ask only for the smallest missing high-risk detail."
- **Review / adversarial review:** grounding rules (cite `file:line`) + a structured, severity-ranked output contract + a "dig deeper / don't pad" nudge.
- **Research / recommendation:** a retrieval budget + citation rules.
- **Write-capable tasks:** a side-effect/safety constraint so Codex stays narrow and avoids unrelated refactors.
- **Conversational / agentic:** a short Personality + collaboration style, and a preamble for tool-heavy work.

## How to choose prompt shape

- Use the built-in `review` / `adversarial-review` commands when the job is reviewing local git changes — those prompts already carry the review contract.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt directly.
- Use `task --resume-last` for a follow-up on the same Codex thread — send only the delta instruction unless the direction changed materially.

## Suggested structure

Keep each section short; add detail only where it changes behavior. Omit sections a task doesn't need.

```text
Role: [1-2 sentences: the model's function, context, and job]

# Personality        (conversational / agentic surfaces only)
# Goal               [the user-visible outcome]
# Success criteria   [what must be true before the final answer]
# Constraints        [policy, safety, evidence, and side-effect limits]
# Output             [sections, length, tone]
# Stop rules         [when to retry, fall back, abstain, ask, or stop]
```

## Output-language convention (for `/codex:handoff` and any user-facing prompt)

- Prose, narrative, and business context in the **user's language** (e.g. 繁體中文).
- Structural headers (`Role` / `Goal` / `Success criteria` / …), field names, and technical directives in **English** — GPT is most stable on English headers and it matches the official examples.
- Keep technical identifiers in their original form.
- Output the finished prompt inside a fenced ` ```text ` block so the user can copy-paste it directly into Codex / ChatGPT.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md).
Common failure modes to avoid live in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).
