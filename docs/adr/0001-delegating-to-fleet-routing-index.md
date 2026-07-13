# Route to fleet engines through one `delegating-to-fleet` index skill

**Context.** The four engines advertise "when to use me" (their *discovery
surface*) in four different shapes: agy via a plugin-root `SKILL.md`, cc via a
`cc-handoff` skill, codex via a subagent plus operating-contract skills, and
grok via nothing at all. The commander (host Claude Code) therefore reaches for
some engines automatically and cannot reach for grok without being told.

**Decision.** Add one model-invocable `delegating-to-fleet` skill in the
`fleet` plugin as the commander's single **routing index**: which engine to
reach for, when, and which verb to open. Per-engine *operating-contract* detail
stays in each engine's own skills and verb command files, loaded lazily only
when that engine is actually used. The index points to those; it does not copy
them.

**Why.** One source of truth for routing beats four drifting ones. It is
IRONCLAD-clean — it touches only `fleet` in a single pass, whereas unifying the
four engines' own discovery surfaces would edit four sibling plugins. Skills
load progressively, so startup cost is one description line either way; the
index's body (~30 lines spanning all engines) loads only when a delegation
decision is actually in play.

## Considered options

- **Per-engine plugin-root discovery skills (bring all four to agy's shape).**
  Rejected: editing four sibling plugins violates IRONCLAD (forces a four-stage
  refactor), adds files, and reintroduces drift across four "when to use me"
  descriptions.
- **A central arbitration/scoring map that ranks engines per task.** Rejected:
  we want a directory, not a comparison — the commander decides, the index only
  informs.

## Consequences

- Minor redundancy: agy and cc keep their own discovery skills (needed for the
  Codex-CLI / agy-native / standalone hosts, and untouchable under IRONCLAD).
  `delegating-to-fleet` is the *commander's* index; those are the engines'
  *self-introductions to all hosts*. Different audiences, accepted overlap.
- Effectiveness hinges on the skill's `description` triggering on delegatable
  tasks without firing on trivial ones — the next open design question.
