# agent-fleet-cc — agent working rules

A Claude Code plugin marketplace. Each `plugins/<name>/` is the exact install payload and one
entry in `.claude-plugin/marketplace.json` — that file is the roster, so don't keep a copy of it
here. Engine knowledge lives per plugin, the job runtime is shared in `shared/lib/`, and tests
mirror each plugin under `tests/<name>/`.

**These plugins ship to other people's machines** — this is a product, not a personal
setup. When you learn something reusable (an engine quirk, a model to prefer/avoid, a
gotcha), route it to a surface that travels with the plugin and gets reviewed: the
plugin's `SKILL.md` / `README`, or this file. **Never** leave it only in private agent
memory — that helps one session on one machine, and users never see it.

## IRONCLAD — do not touch siblings
When working on one plugin, do **NOT** modify other plugins or their tests
(anything under another `plugins/<name>/` or `tests/<name>/`).
When **adding** a sibling plugin, the only existing files you may edit are:
`.claude-plugin/marketplace.json`, `tests/fleet-structure.test.mjs` (the marketplace
consistency test), `package.json` (add a `test:<plugin>` script), `scripts/sync-shared.mjs`
(add the plugin to the vendored-runtime target list — CI drift-checks it), and `README.md`.

## Commands
- `npm test` — the full chain; `package.json` says what it is made of. Run on **Node 24**:
  codex's unref'd-timer tests fail on Node 22.22–23.x (`engines` still says `>=22.3`, but CI
  pins 24 for this reason — see `.github/workflows/ci.yml`).
- One plugin's suite: `node --test tests/<plugin>/*.test.mjs` (antigravity also needs
  `--experimental-test-module-mocks`). The hermetic-vs-real-engine split is the `e2e-testing`
  skill's job — ask it before claiming anything was verified end-to-end.
- `npm run sync-shared` — after editing `shared/lib/`, re-vendor it into each migrated
  plugin's `scripts/lib/shared/` (`cc`, `codex`, `antigravity`, `grok`). **Commit BOTH the source and
  the vendored copy** — CI drift-checks them.
- `npm run bump-version <plugin> <patch|minor|major>` — the one way to bump a version; locks
  `plugins/<name>/.claude-plugin/plugin.json` ↔ its `marketplace.json` entry (`npm run
  check-version` verifies). **It syncs only those two.** A plugin may carry versions in other
  manifests that drift silently — the dual-host ones (`cc`, `antigravity`) do, and both have
  drifted before. So before bumping: `grep -rn '"version"' plugins/<name>` and hand-sync whatever
  else it finds. Don't trust a written-down inventory here; that list is exactly what rots. Same
  for the CHANGELOG: only some plugins keep one, so `ls plugins/<name>/CHANGELOG.md` before you
  assume — that asymmetry is why a bump lands with no entry describing it.

## Conventions
- New scripts: zero-dependency, pure ESM `.mjs`. Tests use only `node:test` +
  `node:assert/strict`, and are hermetic — fake binaries, redirected `CLAUDE_PLUGIN_DATA`,
  no network. Prefer injectable seams (spawn / env / fs) over calling them directly so
  tests need no real binaries.
- **Prove a new or tightened test bites, both ways:** delete the behaviour it guards and watch it
  go red, then feed it the input it must accept and watch it stay green. `git log` holds more than
  one fix for a test that was green for the wrong reason. A guard that has to *guess* — at shell
  syntax, at a heredoc spelling — fails both ways at once, so prefer an invariant with no grammar
  to get wrong.
- Attribution: don't add `Co-Authored-By` trailers by hand — Claude Code's settings control
  it, and this repo keeps them off. (Historical commits carry one; new ones must not.)
- **Never enumerate an engine's runtime catalog in shipped prose** — models, effort levels, tool
  names. Point at the authority instead (grok: `grok models`; codex: the offline recipe in its
  audit doc) and say the levels are per-model. A written-down list reads authoritative and rots
  invisibly: grok's rotted inside 14 days, twice, and the second time it was actively telling
  users that `xhigh` would kill the job while it was the new default model's own top level. Same
  rule for the audit docs' prose — a pinned source anchor is a contract, an enumerated catalog is
  a liability.
- `main` is push-ready: commit a feature/behavior change straight to `main` only after the
  **full CI chain** is green **and** an independent diff review (`/codex:handoff`, another model,
  or a human). CI (`ci.yml`) is more than `npm test` — it also runs a `sync-shared` drift check
  and `npm run build:codex` (a `tsc` typecheck `npm test` skips), so run those two as well before
  pushing (a codex type error reddens CI while `npm test` stays green). To automate that,
  `.claude/hooks/pre-push-ci-gate.sh` blocks a push that would fail either check — opt in per
  machine via a `PreToolUse` hook in `.claude/settings.local.json` (not repo-wide: build:codex
  needs the codex CLI on PATH). Trivial doc/comment edits are exempt; still branch for risky or
  exploratory work.
- **A fix answering a review needs its own review round, and the gate is a *clean* round — not
  the second one.** Review-driven fixes keep introducing fresh defects: a wrong bucket, a doubled
  error string, an unref'd timer that left the job `running` forever. imagine 0.1.0 took four
  rounds; 2–4 each found a defect the previous fix introduced, round 4's inside the test round 3
  added. Rounds cost real quota — agree a fifth with the user instead of looping.
- **Don't touch the worktree while a review runs against this repo.** A reviewer worth having
  mutates the source to check a test actually bites, then restores it — and that `git restore`
  reverts your uncommitted edits too.

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
- **Editing `plugins/<name>/` does NOT change the agent/skill/command Claude Code actually runs.**
  It spawns from the installed copy at `~/.claude/plugins/cache/agent-fleet/<plugin>/<version>/`,
  so a subagent keeps its **old** frontmatter `description` (and body) until the plugin is bumped
  and reinstalled. Verifying a prose/routing change therefore needs a reinstall — a worktree edit
  plus a green `npm test` proves nothing about the live agent. Quickest check that you are looking
  at the live text: `diff ~/.claude/plugins/cache/agent-fleet/<plugin>/<version>/agents/<a>.md
  plugins/<plugin>/agents/<a>.md`. (The agent list in a running session shows the installed
  description — that is the authoritative tell.)
- `tests/codex/runtime.test.mjs` and `tests/shared/worker.test.mjs` are occasionally flaky
  (event-ordering races) — re-run once to confirm; an intermittent failure there, locally or
  in CI, is not a real regression.
- `shared/lib/` is the source of truth. `cc`, `antigravity`, and `grok` run the full shared
  runtime (ProcessAdapter + runWorker); `codex` **uses** only the shared **state core**
  (state-store / events / job / reconcile), **not** the worker — note
  `sync-shared` still vendors the whole runtime (incl. `worker.mjs`) into codex, it just never
  calls `runWorker` (its app-server broker stays engine-specific). Don't assume a plugin uses the
  shared runtime the same way — check before editing.

## Where things live
- Domain glossary (the project's ubiquitous language): `CONTEXT.md`
- Architecture decisions (why a shape was chosen, not how): `docs/adr/`
- Specs / plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/specs/`
- **Engine ↔ CLI contract audits** — every flag/output field a plugin depends on, pinned to a
  source anchor (or, for a closed binary, an evidence class) + the recipe to re-run the check.
  Update the audit doc, not the plugin's `AGENTS.md`, when you learn something about an engine:
  `docs/codex-protocol-sync-audit.md` · `docs/grok-cli-contract-audit.md` ·
  `docs/antigravity-cli-contract-audit.md` (`cc` has none — its engine is Claude Code itself).
