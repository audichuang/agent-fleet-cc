# agent-fleet — Codex delegation and image generation, as agent skills

Two skills, each a self-contained directory (`SKILL.md` plus the scripts it runs):

| Skill | How an agent reaches it | What it does |
|---|---|---|
| `codex` | ask for a Codex review, check, diagnosis, implementation or image, or for Codex to operate a real UI in the Codex desktop app; `/codex` in Claude Code | Delegates to OpenAI Codex (app-server, or the Codex desktop app over IPC with computer use) and tracks the job |
| `imagine` | ask for an image; `/imagine` in Claude Code | Generates one image on xAI Grok Imagine (`POST /v1/images/generations`, reusing the grok CLI's OAuth login read-only, or `XAI_API_KEY`) or, with `--engine agy`, Antigravity's built-in `generate_image` (the user's Google login, no API key). The file on disk is the receipt |

## Install

From this repo, with the `skills` CLI or aghub:

```bash
npx skills add audichuang/agent-fleet-cc
aghub-cli -g -a all source sync https://github.com/audichuang/agent-fleet-cc --skill codex,imagine --install-missing --yes
```

Install only the ones you use. Requirements: Node ≥ 22; for codex, the `codex` CLI logged in (and
the Codex desktop app for `--backend desktop`); for imagine, a grok login, `XAI_API_KEY`, or the
`agy` CLI.

## Migrating from the Claude Code plugins

`codex@agent-fleet` (≤ 2.0.1) and `imagine@agent-fleet` (≤ 0.3.0) were Claude Code plugins. They
keep working but receive no updates. Remove them so the plugin and the skill don't both answer the
same request:

```bash
/plugin uninstall codex@agent-fleet
/plugin uninstall imagine@agent-fleet
/plugin marketplace remove agent-fleet
```

Jobs the codex plugin recorded stay readable by id (`status`, `wait`, `result <job-id>`); new jobs
live in `~/.local/state/codex-companion`.

## Development

```bash
npm run verify         # the whole CI chain: check-versions, npm test, build:codex
npm test               # structure + codex + imagine + e2e
npm run test:codex     # one suite at a time (also test:imagine, test:e2e)
npm run build:codex    # typecheck the codex app-server glue (needs the codex CLI)
```

Run the suites on **Node 24**: the codex suite's unref'd-timer tests fail on 22.22–23.x, which is
why CI pins 24 even though `engines` still allows `>=22.3`.

Layout: `skills/<skill>/` is the exact install payload; `tests/<skill>/` mirrors it with a hermetic suite
(fake binaries, redirected `CODEX_COMPANION_DATA` and `HOME`, no real network). Contributor rules
live in [`AGENTS.md`](AGENTS.md); per-skill developer notes in `docs/<skill>-dev.md`.
