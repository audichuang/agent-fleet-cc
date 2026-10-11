# agent-fleet-cc — agent working rules

An agent-skills repo. Each directory under `skills/` (`skills/codex/`, `skills/imagine/`) is the exact install
payload — users install it with aghub or `npx skills`, and every agent that reads skills gets the
same copy. `tests/repo-structure.test.mjs` pins which directories ship, so don't keep a roster
here. Developer notes per skill live in `docs/<skill>-dev.md` (read the one for the skill you
touch), and tests mirror each skill under `tests/<name>/`.

**Nothing but payload goes inside a skill directory.** Installers copy the whole directory, and an
`AGENTS.md` / `CLAUDE.md` there loads into the user's session when the host reads a reference.
Installers also scan every depth for `SKILL.md`, so a second one with a shipped name (an eval
snapshot, a mirror) gets installed over the real skill; eval workspaces go in `*-workspace/`.

**These skills ship to other people's machines** — this is a product, not a personal
setup. When you learn something reusable (an engine quirk, a model to prefer/avoid, a
gotcha), route it to a surface that travels with the skill and gets reviewed: the
skill's `SKILL.md` / references, its dev notes, or this file. **Never** leave it only in private agent
memory — that helps one session on one machine, and users never see it.

## IRONCLAD — do not touch siblings
When working on one skill, do **NOT** modify the other skill or its tests
(anything under another `skills/<name>/` or `tests/<name>/`).
When **adding** a skill, the only existing files you may edit are:
`tests/repo-structure.test.mjs` and `tests/versions.test.mjs` (the shipped set),
`package.json` (add a `test:<skill>` script) and `README.md`.

## Commands
- `npm run verify` — **the whole CI chain in one command** (`check-versions`, `npm test`,
  `build:codex`). Run this before a push; `npm test` alone is not the chain — it skips the `tsc`
  typecheck. Needs the codex CLI on PATH (for `build:codex`'s prebuild).
- **Read `verify`'s exit code, never its tail.** `npm run verify | tail -n` reports *tail's*
  exit code, so a chain that failed prints a plausible-looking tail and exits 0 — a red run
  reads as green, and it has been reported as green here more than once. Run
  `npm run verify > <log>; echo $?` and grep the log, or read `${PIPESTATUS[0]}`.
- `npm test` — the test chain only; `package.json` says what it is made of. Run on **Node 24**:
  codex's unref'd-timer tests fail on Node 22.22–23.x (`engines` still says `>=22.3`, but CI
  pins 24 for this reason — see `.github/workflows/ci.yml`).
- One skill's suite: `node --test tests/<skill>/*.test.mjs`. The hermetic-vs-real-engine split is the `e2e-testing`
  skill's job — ask it before claiming anything was verified end-to-end.
- **Any content change to a shipped skill needs a version bump — prose-only counts.** The version
  is `metadata.version` in the skill's `SKILL.md` frontmatter, and its `CHANGELOG.md` gets a new
  top entry with the same number (`tests/versions.test.mjs` checks the pair). Same version with
  different content means nobody can tell an installed copy is stale. `fleet` once sat four
  content commits past its last bump and kept routing image generation to a verb `antigravity`
  had already retired. Dev notes, tests and `docs/` are not payload: no bump.

## Conventions
- New scripts: zero-dependency, pure ESM `.mjs`. Tests use only `node:test` +
  `node:assert/strict`, and are hermetic — fake binaries, redirected `CODEX_COMPANION_DATA` and `HOME`,
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
  names. Point at the authority instead (codex: the offline recipe in its
  audit doc) and say the levels are per-model. A written-down list reads authoritative and rots
  invisibly: the retired grok plugin's rotted inside 14 days, twice, and the second time it was actively telling
  users that `xhigh` would kill the job while it was the new default model's own top level. Same
  rule for the audit docs' prose — a pinned source anchor is a contract, an enumerated catalog is
  a liability.
- `main` is push-ready: commit a feature/behavior change straight to `main` only after the
  **full CI chain** is green **and** an independent diff review (the `codex` skill, another model,
  or a human). CI (`ci.yml`) is more than `npm test` — it also runs `npm run build:codex` (a `tsc`
  typecheck `npm test` skips). **`npm run verify` is all of it**;
  reach for that rather than reassembling the steps (a codex type error reddens CI while `npm test`
  stays green). As a second net,
  `.claude/hooks/pre-push-ci-gate.sh` blocks a push that would fail the typecheck — opt in per
  machine via a `PreToolUse` hook in `.claude/settings.local.json` (not repo-wide: build:codex
  needs the codex CLI on PATH). Trivial doc/comment edits are exempt; still branch for risky or
  exploratory work.
- **A fix answering a review needs its own review round, and the gate is a *clean* round — not
  the second one.** Review-driven fixes keep introducing fresh defects: a wrong bucket, a doubled
  error string, an unref'd timer that left the job `running` forever. imagine 0.1.0 took four
  rounds; 2–4 each found a defect the previous fix introduced, round 4's inside the test round 3
  added. Rounds cost real quota — agree a fifth with the user instead of looping. When a round
  finds a hole in the previous fix itself, drop to a simpler design rather than patch the patch:
  codex 1.7.0's Enter retry failed three rounds and ended as one Enter after a longer wait.
- **Don't touch the worktree while a review runs against this repo.** A reviewer worth having
  mutates the source to check a test actually bites, then restores it — and that `git restore`
  reverts your uncommitted edits too.

## Autonomy & approval boundaries
- **Do without asking:** read/search the repo; run tests (`npm test`, per-skill suites,
  the hermetic e2e — all offline, no API key); `build:codex` / `check-versions`; create a branch
  and commit to it; edit files inside the current work-stream's scope.
- **Confirm first** (outward, destructive, or scope-expanding):
  - **`git push`** to any remote — outward and effectively permanent; confirm every time.
  - **Landing on `main`** — only after the full CI chain is green *and* an independent
    review (per the bullet above); branch for anything risky or exploratory.
  - **Adding a dependency / installing packages** — this repo is deliberately
    zero-dependency ESM; a new dep needs a reason and sign-off.
  - **Deleting or `rm -rf`-ing files you didn't create**, or rewriting git history.
  - **Editing CI** (`.github/workflows/`) or repo-wide config.
  - **Touching the sibling skill** while in a single-skill work-stream (see IRONCLAD).
  - **Real-engine (non-hermetic) runs** that spend another engine's quota or hit the network.

## Gotchas
- **Installed skills are symlinks.** aghub links `~/.claude/skills/<name>` (and other agents'
  skill dirs) to its own copy, so a script's `process.argv[1]` is rarely its real path. An entry
  guard must compare real paths (`skills/codex/scripts/lib/entry.mjs`); a plain compare exits 0 with no
  output. Each skill has an `entry-symlink` test for this.
- **Editing the repo does not change the skill an agent runs** until it is re-synced to the
  installed copy (aghub's own skill says how). A green `npm test` proves nothing about the live
  skill; the skill list in a running session shows the installed description.
- `tests/codex/runtime.test.mjs` is occasionally flaky
  (event-ordering races) — re-run once to confirm; an intermittent failure there, locally or
  in CI, is not a real regression.
- `skills/codex/scripts/lib/shared/` is codex's job store (`core/{state-store,events,job,reconcile}.mjs`).
  It used to be vendored from a repo-level `shared/lib/` for several plugins; codex is the only
  user left, so it lives in the skill and is edited in place.

## Where things live
- Domain glossary (the project's ubiquitous language): `CONTEXT.md`
- Architecture decisions (why a shape was chosen, not how): `docs/adr/`
- Old specs and plans were removed from the tree; `git show 4cdeb2c:docs/<path>` reads them.
- **Developer notes per skill** — `docs/codex-dev.md`, `docs/imagine-dev.md`.
- **Engine ↔ CLI contract audits** — every flag/output field a skill depends on, pinned to a
  source anchor (or, for a closed binary, an evidence class) + the recipe to re-run the check.
  Update the audit doc, not the dev notes, when you learn something about an engine:
  `docs/codex-protocol-sync-audit.md` · imagine has two, one per engine it renders on:
  `docs/imagine-xai-image-api-audit.md` · `docs/imagine-agy-image-audit.md`. codex's desktop backend has its own:
  `docs/codex-desktop-ipc-audit.md` (the Codex desktop app's private IPC router).
