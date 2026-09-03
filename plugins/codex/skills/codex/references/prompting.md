# GPT-5.6 Prompting

Use this reference when composing a prompt for Codex / GPT-5.6 — both when `codex:codex-rescue` delegates a `task`, and when `/codex:handoff` produces a prompt for the user to paste into Codex.

GPT-5.6 works best with **outcome-first** prompts: define the target outcome, success criteria, constraints, and available context, then leave the model room to choose the path. Do not carry over process-heavy instruction stacks from older models — they add noise, narrow the search space, and produce mechanical answers.

## Model selection (which gpt-5.6 variant)

Route by **how much thinking is left** — these are three different jobs, not three sizes of one job.

| Model | Job | In / Out ($/1M) | Route here when |
| --- | --- | --- | --- |
| **gpt-5.6-sol** | **thinker** (default) | $5.00 / $30.00 | The work still needs figuring out: planning, hard diagnosis, long autonomous runs, high-stakes review — or the blast radius is large even when the change is small. |
| **gpt-5.6-terra** | **executor** | $2.00 / $12.00 | The plan is settled, but carrying it out is still substantial. |
| **gpt-5.6-luna** | **ticket-runner** | $0.20 / $1.20 | The work fits on a **ticket**: one bounded change, spelled out, nothing left to decide. |

**Luna always runs at `--effort max`.** Its capability is an effort curve, not a fixed number — ≈27 on the Artificial Analysis index with reasoning off, ≈51 at `max`, which is near-`sol` on bounded agentic work. The cheap tokens are the saving; the thinking still has to be bought.

**One ticket per run.** A queue of tickets is N Luna runs, not one prompt carrying all N — separate runs stay inside what Luna is good at, and each can go `--background` in parallel. Bundling them lands on the weak spots below instead.

**Needle-hunting in a huge context and GUI/computer-use go to `sol`:** Luna measures ~41% on MRCR v2 at 512K–1M (`sol` ~74%) and ~46% on OSWorld 2.0.

All three share a 1.05M-token context window, 128K max output, and text+image input. Prices are the 2026-07-30 cut (Luna −80%, Terra −20%, Sol unchanged); Codex's own catalog maps `gpt-5.4-mini` → `gpt-5.6-luna`. Always pass an explicit slug, and say which you chose and why when it isn't the default.

> Not every Codex version/account is gated into 5.6 yet. `/codex:setup` probes the account's `model/list` and warns (without blocking) when the configured default isn't available, pointing the user to `codex update` or a `CODEX_DEFAULT_MODEL` override.

## The reviewer role (this plugin's primary use)

Most delegations here cast Codex as an **independent, multi-angle reviewer** — a cross-model second opinion on work Claude just did (code review, plan/spec gate, root-cause check). This is the `sol` "thinker" role above. Its value is catching what the author missed, so position it to disagree, not to agree.

- **Role framing.** "You are a senior/staff engineer doing an independent review. You did not write this; your job is to find what's wrong, not to confirm it's fine." Make the independence explicit — it must not rubber-stamp Claude's work.
- **Sweep multiple angles, not the first bug.** Name the lenses and require each be weighed: correctness / logic, contract & API violations, edge cases & failure modes, concurrency / races, security, performance, error handling & data loss, test coverage, maintainability. One finding per lens beats one obvious bug.
- **Adversarial stance.** Ask it to try to break the change / refute the diagnosis — construct the input or sequence where it fails. Default to skepticism when evidence is thin, and separate **confirmed** issues from **needs-verification** suspicions.
- **Ground every finding.** `file:line` + a concrete failure scenario (specific inputs → wrong output / crash) + a severity. No hand-waving; say "Need to verify" when it cannot confirm.
- **Output contract.** Severity-ranked findings, each with location, why it's wrong, and a fix direction. An explicit "no issues found in X" when a checked area is clean. Don't pad — a short correct list beats a long speculative one.
- **Effort & model.** Review is the **thinker**'s job — `sol` at `xhigh` (default), `max` for the hardest or most safety-critical. Its value is what it notices that nobody specified, which is exactly what a **ticket** cannot contain, so review keeps the expensive tier however small the diff. Keep it a non-editing run (omit `--write`) unless the user asked for fixes.
- **Use the built-ins first.** For reviewing local git changes, prefer the `review` / `adversarial-review` commands — they already carry this contract. Reach for `task` with a hand-built review prompt only when the target isn't the working tree (a design doc, an inherited diagnosis, a specific file set). When you want several independent takes cross-checked rather than one, that is the adversarial-generation pattern.

## Core rules (from the official GPT-5.6 prompting guide)

- **Outcome-first, not process-first.** State the goal and what "done" looks like; don't script every step. Avoid "first inspect A, then B, then compare every field, then…".
- **Shorter prompts win.** GPT-5.6 has absorbed most older harness boilerplate as default behavior. Start with the smallest prompt and tool set that reliably completes the task; add instructions or examples only to close a proven gap. Long, explicit system prompts tend to trigger extra exploration and repeated validation.
- **Don't ask for generic brevity.** GPT-5.6 is already biased toward compression and is sensitive to "be concise / keep it short" — those can make it drop required content. Instead prioritize: "Lead with the conclusion. Keep required facts, decisions, caveats, and next steps; trim intros, repetition, and generic reassurance."
- **Use `ALWAYS` / `NEVER` / `must` only for true invariants** — safety, required output fields, actions that must never happen. For judgment calls (when to search, ask, use a tool, keep iterating) write **decision rules** instead.
- **Define autonomy and permissions once.** GPT-5.6 is proactive; state what a request authorizes in one compact policy (safe local actions without asking; confirm for external writes, destructive actions, or scope expansion). Do not repeat "ask first" / "do not mutate" throughout — repetition causes needless permission checks.
- **Always include stop rules.** GPT-5.6 will loop; tell it when to stop. Example: "After each result, ask: can I answer the user's core request now with cited evidence? If yes, answer."
- **Reasoning effort: default `xhigh`, floor `high`.** The companion defaults `--effort` to `xhigh` when unset. For the substantial coding / review / diagnosis work this plugin delegates, keep effort in the **`high` → `xhigh` → `max`** band — don't drop to `low` / `minimal` / `none`, they buy nothing for these tasks. **`max`** is the top tier the companion accepts (above `xhigh`); on `sol` / `terra` reserve it for the hardest quality-first tasks and compare it against `xhigh` rather than reaching for it by reflex — `luna` is the standing exception (see Model selection). (Codex's catalog also advertises an `ultra` tier on `sol` / `terra` — the companion deliberately does not accept it, because it triggers proactive multi-agent delegation that this single-agent runner can't observe. Don't pass it. `luna` doesn't offer it at all.)
- **Give it a way to check its work** when validation is possible — targeted unit tests for changed behavior, type/lint checks, build checks, or a minimal smoke test. If validation can't run, say why and give the next best check.
- **Tool routing: parallelise independent reads, keep dependent ones sequential, and don't stop at the first empty result.** Expose only task-relevant tools, and say what each is for when the route depends on context. If a search / read returns empty, partial, or suspiciously narrow results, try one or two meaningful fallbacks before concluding nothing exists.
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

Choosing the **delivery path** (direct `task` · `--resume-last` · the `codex:codex-rescue` subagent · a conversation fork) is a separate decision from choosing the model, with its own measured costs and one naming trap: [references/delivery-paths.md](delivery-paths.md).

## Suggested structure

Keep each section short; add detail only where it changes behavior. Omit sections a task doesn't need.

```text
Role: [1-2 sentences: the model's function, context, and job]

# Personality        (conversational / agentic surfaces only)
# Goal               [the user-visible outcome]
# Success criteria   [what must be true before the final answer]
# Constraints        [policy, safety, evidence, and side-effect limits]
# Tools              [which tools to use, when, and what not to use — when routing depends on context]
# Output             [sections, length, tone]
# Stop rules         [when to retry, fall back, abstain, ask, or stop]
```

## Output-language convention (for `/codex:handoff` and any user-facing prompt)

- Prose, narrative, and business context in the **user's language** (e.g. 繁體中文).
- Structural headers (`Role` / `Goal` / `Success criteria` / …), field names, and technical directives in **English** — GPT is most stable on English headers and it matches the official examples.
- Keep technical identifiers in their original form.
- Output the finished prompt inside a fenced ` ```text ` block so the user can copy-paste it directly into Codex / ChatGPT.

> The user's-language rule here is a **deliberate product choice** — the handoff prompt is read by the human user. It is not the blanket "always respond in the user's language" the official guide warns against; that concerns the model's *answer* language, decided per task.

Reusable blocks live in [references/prompt-blocks.md](prompt-blocks.md).
Concrete end-to-end templates live in [references/codex-prompt-recipes.md](codex-prompt-recipes.md).
Common failure modes to avoid live in [references/codex-prompt-antipatterns.md](codex-prompt-antipatterns.md).
