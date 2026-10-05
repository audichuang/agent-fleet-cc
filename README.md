# agent-fleet — Codex delegation and image generation for Claude Code

Two Claude Code plugins, one marketplace:

| Plugin | How Claude Code reaches it | What it does |
|---|---|---|
| `codex` | the `codex` skill (no slash commands): ask for a Codex review, check, diagnosis, implementation or image | Delegates to OpenAI Codex (app-server, or the Codex desktop app over IPC) |
| `imagine` | the `imagine` skill: ask for an image (also `/imagine:imagine`) | The marketplace's only image entry point, on either of two engines: xAI Grok Imagine over `POST /v1/images/generations` (reuses the grok CLI's OAuth login read-only, or `XAI_API_KEY`), or `--engine agy` through Antigravity's built-in `generate_image` (the user's Google login, no API key). Not a delegation engine: the file on disk is the receipt |

## Install

```bash
/plugin marketplace add audichuang/agent-fleet-cc

/plugin install codex@agent-fleet
/plugin install imagine@agent-fleet
/reload-plugins
```

Install only the ones you use. Per-plugin requirements (the codex CLI login; for imagine, a grok
login, `XAI_API_KEY`, or the `agy` CLI) are documented under `plugins/<name>/`.

## Migrating from the standalone repos

This repo supersedes `audichuang/codex-plugin-cc` and `audichuang/antigravity-plugin` (both
archived). The antigravity, grok and cc plugins it once carried have since been retired; an
installed copy keeps working but receives no updates — uninstall it with `/plugin uninstall`.

## Development

```bash
npm run verify         # the whole CI chain: check-version, sync-shared drift, npm test, build:codex
npm test               # structure + shared + codex + imagine + e2e
npm run test:codex     # one suite at a time (also test:imagine, test:shared, …)
npm run test:e2e       # black-box CLI end-to-end regression for codex (real subprocess, fake engine, no API key)
npm run sync-shared    # re-vendor shared/lib into plugins/codex/scripts/lib/shared/ (CI drift-checks this)
npm run build:codex    # typecheck the codex app-server glue (needs the codex CLI)
```

Run the suites on **Node 24**: the codex suite's unref'd-timer tests fail on 22.22–23.x, which is
why CI pins 24 even though `engines` still allows `>=22.3`.

Layout: `plugins/<name>/` is the exact install payload; `tests/<name>/` mirrors it with a hermetic
suite (fake binaries, redirected `CLAUDE_PLUGIN_DATA`, no real network). Contributor rules — how
to bump a version, what CI checks beyond `npm test`, which plugin may touch which — live in
[`AGENTS.md`](AGENTS.md).

**Shared foundation:** `shared/lib/` is a zero-dependency job runtime — a directory-per-job
state store with O_EXCL CAS terminal transitions, a generic adapter-driven worker, mandatory env
sanitization with a recursion guard, and a parameterized conformance suite. `codex` uses only its
state core and drives its own app-server broker; it carries a vendored copy under
`scripts/lib/shared/`, kept in sync by `npm run sync-shared` and drift-checked in CI. Designs live
in `docs/specs/`.
