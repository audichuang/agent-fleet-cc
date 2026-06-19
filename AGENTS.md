# agent-fleet-cc — agent working rules

A Claude Code plugin marketplace: 4 plugins (`codex`, `antigravity`, `cc`,
`fleet`). Each `plugins/<name>/` is the exact install payload; engine knowledge lives
per plugin, the job runtime is shared in `shared/lib/`. Tests mirror each plugin under
`tests/<name>/`.

## IRONCLAD — do not touch siblings
When working on one plugin, do **NOT** modify other plugins or their tests
(`plugins/{codex,antigravity,cc}/`, `tests/{codex,antigravity,cc}/`).
When **adding** a sibling plugin, the only existing files you may edit are:
`.claude-plugin/marketplace.json`, `tests/fleet-structure.test.mjs` (the marketplace
consistency test), `package.json` (add a `test:<plugin>` script), and `README.md`.

## Commands
- `npm test` — full chain: structure + shared + cc + antigravity + codex + fleet + e2e (Node >= 22.3)
- `node --test tests/<plugin>/*.test.mjs` — run one plugin's suite (antigravity also needs
  `--experimental-test-module-mocks`)
- `npm run test:e2e` — black-box CLI e2e for all 4 plugins (cc + codex + antigravity + fleet;
  real subprocess, fake engine, no API key)
- `npm run sync-shared` — after editing `shared/lib/`, re-vendor it into each migrated
  plugin's `scripts/lib/shared/` (currently only `cc`). **Commit BOTH the source and
  the vendored copy** — CI drift-checks them.

## Conventions
- New scripts: zero-dependency, pure ESM `.mjs`. Tests use only `node:test` +
  `node:assert/strict`, and are hermetic — fake binaries, redirected `CLAUDE_PLUGIN_DATA`,
  no network. Prefer injectable seams (spawn / env / fs) over calling them directly so
  tests need no real binaries.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Branch from `main` for new feature work; don't commit features straight to `main`.

## Gotchas
- `tests/codex/runtime.test.mjs` is occasionally flaky — re-run `node --test tests/codex/*.test.mjs`
  once to confirm; an intermittent failure there is not a real regression.
- `shared/lib/` is the source of truth. `cc` (v0.3.0) is migrated onto it;
  `antigravity` and `codex` are **not yet** (roadmap). Don't assume a plugin uses the
  shared runtime — check before editing.

## Where things live
- Specs / plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/specs/`
- SDD progress ledger (full build history per feature): `.git/sdd/progress.md`
- Per-plugin requirements (CLI login / OAuth / endpoint profiles): each `plugins/<name>/`
  directory and `README.md`
