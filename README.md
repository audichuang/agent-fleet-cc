# agent-fleet — one marketplace for AI-agent delegation plugins

Four Claude Code plugins, one marketplace:

| Plugin | Commands | What it delegates to |
|---|---|---|
| `codex` | `/codex:*` (review, adversarial-review, task, execute-plan, rescue, handoff, status, wait, logs, result, attach, cancel, setup) | OpenAI Codex (app-server) |
| `antigravity` | `/antigravity:*` (review, adversarial-review, rescue, task, image, handoff, status, wait, logs, result, cancel, setup) | Google Antigravity CLI (`agy`) |
| `delegate` | `/delegate:*` (task, status, wait, logs, result, cancel, setup) | Cheap-model headless Claude Code via settings profiles |
| `fleet` | `/fleet:*` (setup, doctor, status) | Guided onboarding plus read-only fleet diagnostics/status |

> **`delegate` v0.2.0** runs on the shared job runtime (`shared/lib/`). Its companion
> CLI also exposes machine-layer re-entry verbs `wait` and `logs` (with `--json`
> projections) for editors/orchestrators, and the same verbs are now exposed as
> `/delegate:wait` and `/delegate:logs`. `execute-plan` was removed in v0.2.0;
> hand a plan to `task` directly (or via `--prompt-file <path>`).

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

### Quick start: `fleet` (recommended first run)

```text
/fleet:setup        # pick the engines you want; checks readiness for each
/fleet:doctor       # direct local readiness check; no auth or network verification
/fleet:status       # read-only CLI board across installed engines; not a full TUI
```

`/fleet:setup` asks which engines you want (multi-select), runs one fast,
network-free readiness check, then — one decision at a time — explains any gap and
points you at that engine's own `/<engine>:setup` to fix it (install, `codex login`,
agy OAuth, or a `delegate` profile). It is **guide-only**: it never runs another
command or logs you in for you. A `ready` engine means its binary/profile is
present, **not** that auth is done — run `/<engine>:setup` once on first use to
complete login, then re-run `/fleet:setup` to confirm.

`/fleet:doctor` is the non-interactive version of the local prerequisite check.
`/fleet:status` shells out to each installed engine's own read-only status command,
normalizes the rows, and prints a compact table with follow-up actions. The slash
wrappers intentionally run the all-engine view without raw slash arguments so user
text is never injected into a shell command; the underlying `fleet-doctor.mjs` and
`fleet-status.mjs` CLIs still support `--only` and `--json` for automation. This is
not a full terminal UI and does not translate any engine transcript.

### Lifecycle commands

The P0/P1 lifecycle surface is intentionally command-line oriented:

```text
/codex:task "..." --background
/codex:wait <job-id>
/codex:logs <job-id>

/antigravity:task "..." --background
/antigravity:wait <job-id>
/antigravity:logs <job-id> [--follow]

/delegate:task "..." --background --profile <name>
/delegate:wait <job-id>
/delegate:logs <job-id> [--follow]

/fleet:doctor
/fleet:status
```

Codex log streaming delegates to its native attach/live-log path. Antigravity logs
come from persisted job logs; `agy --print` does not expose a tool-event stream, so
the plugin does not invent one. Delegate logs expose the shared-runtime event log.

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
/delegate:wait <job-id>       # block until a job reaches a terminal state
/delegate:logs <job-id>       # print job events; add --follow to stream
/delegate:result <job-id>     # fetch a job's result
/delegate:cancel <job-id>     # cancel a running job
```

Long tasks: add `--background`, then poll `/delegate:status`, block with
`/delegate:wait <id>`, or inspect events with `/delegate:logs <id> --follow`. Flags:
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
npm test               # structure + shared + delegate + antigravity + codex + fleet suites (Node >= 22.3)
npm run test:delegate  # one suite at a time (also test:fleet, test:codex, …)
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
