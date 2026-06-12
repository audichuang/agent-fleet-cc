# agent-fleet — one marketplace for AI-agent delegation plugins

Three Claude Code plugins, one marketplace:

| Plugin | Commands | What it delegates to |
|---|---|---|
| `codex` | `/codex:*` (review, adversarial-review, rescue, execute-plan, handoff, status, result, attach, cancel, setup) | OpenAI Codex (app-server) |
| `antigravity` | `/antigravity:*` (review, adversarial-review, rescue, task, image, handoff, status, result, cancel, setup) | Google Antigravity CLI (`agy`) |
| `delegate` | `/delegate:*` (task, execute-plan, status, result, cancel, setup) | Cheap-model headless Claude Code via settings profiles |

## Install

```bash
/plugin marketplace add audichuang/agent-fleet-cc
/plugin install codex@agent-fleet
/plugin install antigravity@agent-fleet
/plugin install delegate@agent-fleet
/reload-plugins
```

Install only the ones you use. Per-plugin requirements (codex CLI login, agy OAuth,
Anthropic-compatible endpoint profiles) are documented in each plugin's directory
under `plugins/<name>/`.

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
npm test                 # structure + all three hermetic suites (Node >= 22.3)
npm run test:codex       # one suite at a time
npm run build:codex      # typecheck codex app-server glue (needs codex CLI)
```

Layout: `plugins/<name>/` is the exact install payload; `tests/<name>/` mirrors each
source repo's hermetic suite (fake binaries, redirected `CLAUDE_PLUGIN_DATA`, no
real network). Roadmap (shared job-runtime base, fleet status) lives in
`docs/specs/2026-06-12-agent-fleet-merge-design.md`.
