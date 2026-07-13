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
- `npm test` — full chain: structure + shared + cc + antigravity + codex + grok + fleet + e2e (Node >= 22.3)
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
- Branch from `main` for new feature work; don't commit features straight to `main`.

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
- Specs / plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/specs/`
- SDD progress ledger (full build history per feature): `.git/sdd/progress.md`
- Per-plugin requirements (CLI login / OAuth / endpoint profiles): each `plugins/<name>/`
  directory and `README.md`
- Codex ↔ CLI protocol/health sync audit (+ how to re-run it when Codex ships new commits):
  `docs/codex-protocol-sync-audit.md`
