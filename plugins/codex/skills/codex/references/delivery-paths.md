# Delivery paths — how to hand work to Codex

Model selection (in [prompting.md](prompting.md)) decides *which* Codex runs the work: `gpt-6.1-sol` by default, `gpt-6-astra` only when the user asks. This file decides *how the work gets there*.

The cost that matters is the one paid on the Claude side. Codex's own token spend is roughly
the same whichever path you pick — the work is identical once it reaches the engine.

## The three paths

| Path | Claude-side cost | Use it when |
| --- | --- | --- |
| companion `task` or `review` from the main thread | ~400 tok (command + result) | The usual path. The host runs the companion itself. |
| `task --resume-last` | same, plus nothing | A follow-up on the same Codex thread. Codex remembers; the host restates nothing. |
| `/subtask` (conversation fork) | inherits the whole conversation | The task genuinely depends on the conversation ("fix the bug we just diagnosed"). Restating the design would cost more than inheriting it. |

**The host runs the companion.** There is no `/codex:*` slash command and no Codex subagent (`codex:codex-rescue` was removed in 2.0.0). A batch of independent checks is N companion calls from the main thread.

**A check does not need the conversation.** If the request is already spelled out, the top two rows are the answer. Reach for the fork on a *continuation*, when restating the design would cost more than inheriting the thread.

## `--resume-last`

Related follow-ups belong on one thread. Unrelated work gets a fresh thread: a long chain grows the context the next turn has to recall.

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
and re-entered the command (issue #234). The command file is gone. Do not put `context: fork` on
the skill. Call the companion directly.
