# agent-fleet-cc — agent working rules

A Claude Code plugin marketplace: 5 plugins (`codex`, `antigravity`, `cc`, `grok`,
`fleet`). Each `plugins/<name>/` is the exact install payload; engine knowledge lives
per plugin, the job runtime is shared in `shared/lib/`. Tests mirror each plugin under
`tests/<name>/`.

**These plugins ship to other people's machines** — this is a product, not a personal
setup. When you learn something reusable (an engine quirk, a model to prefer/avoid, a
gotcha), route it to a surface that travels with the plugin and gets reviewed: the
plugin's `SKILL.md` / `README`, or this file. **Never** leave it only in private agent
memory — that helps one session on one machine, and users never see it.

## IRONCLAD — do not touch siblings
When working on one plugin, do **NOT** modify other plugins or their tests
(`plugins/{codex,antigravity,cc,grok,fleet}/`, `tests/{codex,antigravity,cc,grok,fleet}/`).
When **adding** a sibling plugin, the only existing files you may edit are:
`.claude-plugin/marketplace.json`, `tests/fleet-structure.test.mjs` (the marketplace
consistency test), `package.json` (add a `test:<plugin>` script), `scripts/sync-shared.mjs`
(add the plugin to the vendored-runtime target list — CI drift-checks it), and `README.md`.

## Commands
- `npm test` — full chain: structure + shared + cc + antigravity + codex + grok + fleet + e2e.
  Run on **Node 24**: codex's unref'd-timer tests fail on Node 22.22–23.x (`engines` still says
  `>=22.3`, but CI pins 24 for this reason — see `.github/workflows/ci.yml`).
- `node --test tests/<plugin>/*.test.mjs` — run one plugin's suite (antigravity also needs
  `--experimental-test-module-mocks`)
- `npm run test:e2e` — black-box CLI e2e for all 5 plugins (cc + codex + antigravity + fleet + grok;
  real subprocess, fake engine, no API key)
- `npm run sync-shared` — after editing `shared/lib/`, re-vendor it into each migrated
  plugin's `scripts/lib/shared/` (`cc`, `codex`, `antigravity`, `grok`). **Commit BOTH the source and
  the vendored copy** — CI drift-checks them.
- `npm run bump-version <plugin> <patch|minor|major>` — the one way to bump a version; locks
  `plugins/<name>/.claude-plugin/plugin.json` ↔ its `marketplace.json` entry (`npm run
  check-version` verifies). It syncs only those two; the per-plugin `.codex-plugin/plugin.json`
  dual-host manifests (`cc`, `antigravity`) also carry a version and drift silently — hand-sync
  those. (Root `package.json` holds the repo's own version, not a plugin mirror;
  `.agents/plugins/marketplace.json` carries no version — neither needs touching on a plugin bump.)

## Conventions
- New scripts: zero-dependency, pure ESM `.mjs`. Tests use only `node:test` +
  `node:assert/strict`, and are hermetic — fake binaries, redirected `CLAUDE_PLUGIN_DATA`,
  no network. Prefer injectable seams (spawn / env / fs) over calling them directly so
  tests need no real binaries.
- Attribution: don't add `Co-Authored-By` trailers by hand — Claude Code's settings control
  it, and this repo keeps them off. (Historical commits carry one; new ones must not.)
- `main` is push-ready: commit a feature/behavior change straight to `main` only after the
  **full CI chain** is green **and** an independent diff review (`/codex:handoff`, another model,
  or a human). CI (`ci.yml`) is more than `npm test` — it also runs a `sync-shared` drift check
  and `npm run build:codex` (a `tsc` typecheck `npm test` skips), so run those two as well before
  pushing (a codex type error reddens CI while `npm test` stays green). To automate that,
  `.claude/hooks/pre-push-ci-gate.sh` blocks a push that would fail either check — opt in per
  machine via a `PreToolUse` hook in `.claude/settings.local.json` (not repo-wide: build:codex
  needs the codex CLI on PATH). Trivial doc/comment edits are exempt; still branch for risky or
  exploratory work.

## Autonomy & approval boundaries
- **Do without asking:** read/search the repo; run tests (`npm test`, per-plugin suites,
  the hermetic e2e — all offline, no API key); `npm run sync-shared` / `build:codex` /
  `check-version`; create a branch and commit to it; edit files inside the current
  work-stream's scope.
- **Confirm first** (outward, destructive, or scope-expanding):
  - **`git push`** to any remote — outward and effectively permanent; confirm every time.
  - **Landing on `main`** — only after the full CI chain is green *and* an independent
    review (per the bullet above); branch for anything risky or exploratory.
  - **Adding a dependency / installing packages** — this repo is deliberately
    zero-dependency ESM; a new dep needs a reason and sign-off.
  - **Deleting or `rm -rf`-ing files you didn't create**, or rewriting git history.
  - **Editing CI** (`.github/workflows/`) or repo-wide config.
  - **Touching a sibling plugin** while in a single-plugin work-stream (see IRONCLAD).
  - **Real-engine (non-hermetic) runs** that spend another engine's quota or hit the network.

## Gotchas
- `tests/codex/runtime.test.mjs` and `tests/shared/worker.test.mjs` are occasionally flaky
  (event-ordering races) — re-run once to confirm; an intermittent failure there, locally or
  in CI, is not a real regression.
- `shared/lib/` is the source of truth. `cc`, `antigravity`, and `grok` run the full shared
  runtime (ProcessAdapter + runWorker); `codex` **uses** the shared **state-store only** — note
  `sync-shared` still vendors the whole runtime (incl. `worker.mjs`) into codex, it just never
  calls `runWorker` (its app-server broker stays engine-specific). Don't assume a plugin uses the
  shared runtime the same way — check before editing.

## Where things live
- Domain glossary (the project's ubiquitous language): `CONTEXT.md`
- Architecture decisions (why a shape was chosen, not how): `docs/adr/`
- Specs / plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/specs/`
- SDD progress ledger (full build history per feature): `.git/sdd/progress.md`
- Per-plugin requirements (CLI login / OAuth / endpoint profiles): each `plugins/<name>/`
  directory and `README.md`
- Codex ↔ CLI protocol/health sync audit (+ how to re-run it when Codex ships new commits):
  `docs/codex-protocol-sync-audit.md`
