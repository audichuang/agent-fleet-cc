# agent-fleet-cc

A Claude Code plugin marketplace that turns Claude Code into a commander which
delegates work to other AI CLIs. This glossary pins the vocabulary for *how an
engine advertises itself to the commander* — the distinction that decides
whether Claude Code reaches for an engine on its own.

## Language

**Engine**:
One of the delegatable AI CLIs the marketplace wraps: `codex`, `antigravity`
(agy), `grok`, `cc`. Each is a plugin under `plugins/<name>/`.
_Avoid_: provider, model, tool.

**Commander**:
The host Claude Code session that decides whether, and to which engine, to
delegate. It is the only orchestrator; engines never command each other.
_Avoid_: orchestrator (ambiguous), root, master.

**Delegate**:
The commander's single action of handing a self-contained task to one engine,
which does it and returns a result. Kept to one hop by design — the commander
does not hand off work that will itself re-delegate (a guideline, not an enforced
guarantee). "Offload" is the same act named from the resource side (it *can*
spread usage across another engine's quota, and keeps the intermediate work out
of the commander's context); it is not a distinct mode.
_Avoid_: dispatch, subcontract, route (route is choosing *which* engine, not the
act of handing off).

**Discovery surface**:
The model-invocable description that makes the commander *autonomously reach
for* an engine ("reach for X when the task looks like Y"). Its carrier may be a
plugin skill or a subagent — what matters is that it triggers without the user
naming the engine.
_Avoid_: trigger, hint, routing rule.

**Operating-contract skill**:
A skill that teaches the commander *how to drive* an engine once chosen — how to
compose its prompt, call its runtime, and present its result. Distinct from a
discovery surface, which decides *whether* to use the engine at all.
_Avoid_: how-to, helper skill, usage doc.

**Verb**:
An explicit `/<engine>:<verb>` command exposing the job lifecycle
(`task`/`wait`/`result`/`logs`/`cancel`/`status`/`setup`, plus per-engine extras
like `handoff`, `rescue`, `execute-plan`). A verb is invoked deliberately; it is
not a discovery surface and does not trigger on its own.
_Avoid_: command (use only for the file type), action.

**Fleet**:
The umbrella plugin (`plugins/fleet/`): a read-only status board (`status`) and
health checks (`doctor`) across all engines (codex, antigravity, cc, grok), plus
guided onboarding (`setup`, which currently covers codex/antigravity/cc). It reads
each engine; it is not itself an engine.
_Avoid_: hub, manager.
