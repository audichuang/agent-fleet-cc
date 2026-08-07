# Delivery paths — how to hand work to Codex

Model selection (in `SKILL.md`) decides *which* Codex runs the work. This file decides *how the
work gets there*. The two are independent: a **ticket** on `luna` can arrive by any path below.

The cost that matters is the one paid on the Claude side. Codex's own token spend is roughly
the same whichever path you pick — the work is identical once it reaches the engine.

## The four paths

| Path | Claude-side cost | Use it when |
| --- | --- | --- |
| `task` direct from the main thread | ~400 tok (command + result) | Independent tickets. The default for a batch. |
| `task --resume-last` | same, plus nothing | A few **related** tickets — same file, same refactor. Codex's thread remembers; Claude restates nothing. |
| `codex:codex-rescue` subagent | **~20K measured** per spawn | You want Claude to *notice* a ticket on its own, or you want the `tools: Bash` + one-call-verbatim guardrail. |
| `/subtask` (conversation fork) | inherits the whole conversation | The task genuinely depends on the conversation ("fix the bug we just diagnosed"). Restating the design would cost more than inheriting it. |

**The top two rows are user-typed.** `/codex:task` is `disable-model-invocation`, so Claude cannot
take those paths on its own — they are what it *recommends*, and what the user runs. The paths
Claude can actually execute are the subagent (via the `Agent` tool) and `/subtask`. Read the cost
column with that in mind: the ~400-token row is the cheapest way for the *user* to deliver a batch,
not an option Claude can silently pick instead of the 20K one.

**A ticket does not need the conversation.** That is what the word means — bounded, spelled out,
nothing left to decide. So for the ticket lane the top two rows are the answer, and a
conversation fork is the most expensive way to deliver something that already carries its own
spec. Reach for the fork on a *continuation*, not a ticket.

## Why the subagent costs ~20K

A subagent's `skills:` frontmatter **preloads the full skill text** at spawn — not just the
description. `codex-rescue` preloads `codex-cli-runtime` (~930 tok) plus `gpt-5-6-prompting`
(~2,900 tok) plus its own body (~1,000 tok), on top of the agent system prompt, every time.
One measured trivial forward: `subagent_tokens: 20732`, 1 tool use.

What it buys is **not** context isolation. That was already there: the file reads, the reasoning,
and the tool loop all happen inside Codex's own 1.05M context (65K input on that same run), and
the main thread only ever sees the final projection either way — the agent is contractually
forbidden to summarize. What the ~20K buys is proactive discovery and the tool guardrail. Pay it
for those, not for isolation.

## `--resume-last` has a Luna-shaped limit

Chaining tickets on one thread grows that thread, and long-context recall is exactly Luna's weak
spot (~41% on MRCR v2 at 512K–1M). A few related tickets on one thread is the sweet spot; a long
chain walks into the weakness that `SKILL.md`'s **one ticket per run** rule exists to avoid.
Unrelated tickets get fresh threads.

## Four different things are called "fork"

Version-dependent and easy to mix up. Checked against Claude Code 2.1.223:

| Name | Inherits the conversation? | Result returns to this conversation? |
| --- | --- | --- |
| `/subtask` | yes | yes |
| `/fork` | yes | **no** — it becomes a separate background session |
| `context: fork` (skill frontmatter) | **no** — "It won't have access to your conversation history" | yes |
| `Agent(subagent_type: "fork")` | **yes** — "inherits your context" | yes |

Before 2.1.212, `/fork` was the in-session fork that `/subtask` is now. The last two rows are the
pair that actually gets confused: near-identical spelling, opposite answer in column one.

**`context: fork` is a trap in this repo.** `commands/rescue.md` once set it: a forked
general-purpose subagent has no `Agent` tool, so the routing fell back to `Skill(codex:rescue)`
and re-entered the command (issue #234). `tests/codex/commands.test.mjs` and
`tests/antigravity/agent-contract.test.mjs` both pin `doesNotMatch(/^context:\s*fork\b/m)`.
Route to a subagent with the `Agent` tool and keep the command inline.

**The trap now has an escape hatch we still don't take.** `context: fork` has a sibling `agent:`
key ("Agent type to spawn when `context: fork`"), so a fork can be pinned to `codex:codex-rescue`
instead of landing on general-purpose — which removes #234's failure chain at the root. `rescue.md`
stays inline anyway: the neighbouring `background:` key defaults forks to background ("report back
as a task notification instead of blocking the turn"), and the command's `AskUserQuestion` step has
to block. So don't "fix" the trap by reaching for `agent:` — the reason we stay inline is the
blocking prompt, not the missing tool.
