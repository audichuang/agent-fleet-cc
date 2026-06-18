# agent-fleet — one marketplace for AI-agent delegation plugins

Three Claude Code plugins, one marketplace:

| Plugin | Commands | What it delegates to |
|---|---|---|
| `codex` | `/codex:*` (review, adversarial-review, rescue, execute-plan, handoff, status, result, attach, cancel, setup) | OpenAI Codex (app-server) |
| `antigravity` | `/antigravity:*` (review, adversarial-review, rescue, task, image, handoff, status, result, cancel, setup) | Google Antigravity CLI (`agy`) |
| `delegate` | `/delegate:*` (task, status, result, cancel, setup) | Cheap-model headless Claude Code via settings profiles |
| `fleet` | `/fleet:setup` | Guided onboarding — pick the engines you want, check readiness, then guide each deep fix to that engine's `/<engine>:setup` (the recommended starting point) |

> **`delegate` v0.2.0** runs on the shared job runtime (`shared/lib/`). Its companion
> CLI also exposes machine-layer re-entry verbs `wait` and `logs` (with `--json`
> projections) for editors/orchestrators — these have no slash command. `execute-plan`
> was removed in v0.2.0; hand a plan to `task` directly (or via `--prompt-file <path>`).

## Install

```bash
/plugin marketplace add audichuang/agent-fleet-cc

# Recommended starting point — install fleet and run the guided onboarding:
/plugin install fleet@agent-fleet
/fleet:setup

# fleet only *guides* the deep fixes; install the engine plugins you chose so
# their /<engine>:setup commands exist:
/plugin install codex@agent-fleet
/plugin install antigravity@agent-fleet
/plugin install delegate@agent-fleet
/reload-plugins
```

Install only the ones you use. Per-plugin requirements (codex CLI login, agy OAuth,
Anthropic-compatible endpoint profiles) are documented in each plugin's directory
under `plugins/<name>/`.

### Quick start: `delegate`

```text
/delegate:setup        # checks the `claude` CLI is runnable + lists your profiles
```

Create a profile (a standard Claude Code settings JSON) at
`~/.claude/plugins/data/delegate/profiles/<name>.json` with an `env` block pointing
at your cheap endpoint:

```json
{ "env": { "ANTHROPIC_BASE_URL": "https://...", "ANTHROPIC_AUTH_TOKEN": "sk-...", "ANTHROPIC_MODEL": "..." } }
```

Then delegate work:

```text
/delegate:task "a complete, self-contained instruction" --profile <name>
/delegate:status              # list jobs in this workspace
/delegate:result <job-id>     # fetch a job's result
/delegate:cancel <job-id>     # cancel a running job
```

Long tasks: add `--background`, then poll `/delegate:status` (or, from an
orchestrator, use the companion `wait <id>` / `logs <id>` verbs). Flags:
`--prompt-file <path>`, `--json`, `--model <id>`, `--read-only`,
`--resume-job <id>|--resume-last`, `--timeout-ms <n>`. Secrets in a profile's `env`
are read at spawn time and never written to job state.

## Migrating from the standalone repos

This repo supersedes `audichuang/codex-plugin-cc` and `audichuang/antigravity-plugin`
(both archived) plus the local-only delegate plugin. Command prefixes are unchanged.

1. Uninstall the old plugins and remove the old marketplaces
   (`openai-codex`, `antigravity`, `claude-delegate`) — prefixes would collide.
2. Add this marketplace and install (commands above).
3. Done. Job state and profiles live under `~/.claude/plugins/data/<plugin>/`,
   keyed by plugin name — they survive unchanged (your `profiles/*.json` included).

## Development

```bash
npm test               # structure + shared + delegate + antigravity + codex suites (Node >= 22.3)
npm run test:delegate  # one suite at a time
npm run test:e2e       # black-box CLI end-to-end regression for delegate (real subprocess, fake engine, no API key)
npm run sync-shared    # re-vendor shared/lib into each plugin's scripts/lib/shared/ (CI drift-checks this)
npm run build:codex    # typecheck the codex app-server glue (needs the codex CLI)
```

Layout: `plugins/<name>/` is the exact install payload; `tests/<name>/` mirrors each
source repo's hermetic suite (fake binaries, redirected `CLAUDE_PLUGIN_DATA`, no real network).

**Shared foundation (Phase 2):** `shared/lib/` is a zero-dependency job runtime — a
directory-per-job state store with O_EXCL CAS terminal transitions, a generic
adapter-driven worker (process-group spawn/kill so engine grandchildren are reaped),
mandatory env sanitization with a recursion guard, and a parameterized 10-scenario
conformance suite. `delegate` (v0.2.0) is fully migrated onto it: engine knowledge
lives in a `ClaudeAdapter`, the job runtime in the shared lib. Each plugin carries a
vendored copy under `scripts/lib/shared/` kept in sync by `npm run sync-shared` and
drift-checked in CI. Migrating `antigravity` and `codex` onto the same base is the
remaining roadmap. Designs live in `docs/specs/`.
