---
name: local-install-test
description: >-
  How to install a locally-developed agent-fleet-cc plugin (codex / antigravity /
  cc / grok) into the real Claude Code and test it — including how to
  REPLACE the currently-installed version with your edited copy. Use this whenever
  you edit a plugin in this repo and want to try it for real in Claude Code, or ask
  "how do I install this locally", "how do I test my plugin change", "how do I
  swap in the new version", "本地安裝測試", "直接替換", "我改了 codex plugin 怎麼測",
  or hit "I bumped the version / updated the marketplace but Claude Code still
  loads the old plugin". Scope: installing/testing THIS
  repo's plugins in Claude Code — not generic `npm install`, not authoring plugin
  features, not the hermetic `npm test` suite (that's the e2e-testing skill).
---

# Installing & testing an agent-fleet plugin locally

You edited a plugin in this repo and want to run the *real* thing in Claude Code —
not the unit tests, the actual installed plugin. The friction is that Claude Code
doesn't load your working tree directly; it loads a **versioned cache copy**, and
the path from "I edited a file" to "Claude Code runs my edit" has three non-obvious
gotchas that waste an afternoon if you don't know them. This skill is that path.

## Start here — the harness blocks the paths this skill talks about

Every path below under `~/.claude/plugins/` sits **outside the session's allowed
working directory**, and every `claude plugin ...` command needs its own approval.
So `cat ~/.claude/plugins/installed_plugins.json`, `ls ~/.claude/plugins/cache/...`
and `claude plugin list` do not fail loudly — they come back as
"was blocked. For security..." or "requires approval", and it is easy to burn most
of a session re-phrasing them. Read those paths as **explanation of the machinery**,
not as commands to run.

Two things actually work, so reach for them first:

```bash
npm run use-local -- <plugin> [version]   # does the whole job: refresh, repoint, back up
```

`use-local` runs from inside the repo, so nothing blocks it. It is the whole
happy path — refresh the marketplace, materialize the cache, repoint the pin.
Bump the version first (see the gotchas), run it, restart Claude Code.

When you genuinely need to *look* at the live install (say, to confirm which
version is pinned), ask the user to run it themselves — in Claude Code, a command
typed with a leading `! ` runs in the session and its output lands in the
conversation:

```
! claude plugin list
```

Everything below explains why this shape exists and covers the cases `use-local`
does not.

## The mental model (why the obvious thing doesn't work)

Three layers sit between your edit and what Claude Code runs:

1. **Marketplace clone** — `~/.claude/plugins/marketplaces/agent-fleet/` is a git
   clone of the marketplace source (by default GitHub `audichuang/agent-fleet-cc`).
   Claude Code reads plugin metadata from here, *not* from your working tree.
2. **Versioned cache** — when a plugin is installed/updated, its payload is copied
   to `~/.claude/plugins/cache/agent-fleet/<plugin>/<version>/`. **This directory is
   keyed by version.** Same version → same cache → your edit is invisible.
3. **The active pin** — `~/.claude/plugins/installed_plugins.json` records, per
   plugin, *which* cache dir is live: `plugins["<plugin>@agent-fleet"][0]` →
   `{ installPath, version, gitCommitSha }`. Claude Code loads exactly this path,
   read at session start.

So getting an edit live means: get it into the marketplace clone → materialize a
new versioned cache → repoint the active pin → restart Claude Code.

## The three gotchas (each one will bite you)

- **Bump the version, always.** The cache is keyed by version. If you edit code but
  leave the version unchanged, `marketplace update` reuses the existing
  `cache/.../<version>/` and serves the stale copy. For `codex` the version lives in
  **two** files that must match (a structure test enforces it):
  `plugins/codex/.claude-plugin/plugin.json` **and** the codex entry in
  `.claude-plugin/marketplace.json`. (Other plugins: same pattern — plugin.json +
  the marketplace entry.)
- **`claude plugin install` does NOT upgrade.** For an already-installed plugin it
  prints "already installed" and no-ops. The CLI has no `update`/`upgrade`
  subcommand. Upgrading is done by the `/plugin` UI, or by repointing the pin by
  hand (below).
- **Restart to load it.** `installed_plugins.json` is read at session start. A
  running session keeps the old version in memory — and may rewrite the file on a
  plugin op, clobbering a hand edit. After flipping, restart Claude Code, and don't
  run `/plugin` actions in the stale session.

## Workflow A — git source (the default install path)

Use when the marketplace points at the GitHub fork (the default). To confirm which
source is registered, ask the user to run `! claude plugin marketplace list` —
reading `~/.claude/plugins/known_marketplaces.json` yourself is blocked (see the
top section).

```bash
# 0) bump the plugin version (e.g. codex 1.0.18 -> 1.0.19) in BOTH:
#    plugins/<plugin>/.claude-plugin/plugin.json  AND  .claude-plugin/marketplace.json
# 1) commit + push to the fork so the marketplace source has your change
git add -A && git commit -m "..." && git push origin main
# 2) refresh the marketplace clone (fetches your push; materializes the new
#    version into ~/.claude/plugins/cache/agent-fleet/<plugin>/<version>/)
claude plugin marketplace update agent-fleet
# 3) flip the active version to the new cache dir — see "Flipping the version"
# 4) restart Claude Code, then verify — see "Verify"
```

## Workflow B — local path (fast dev loop, no git push)

Use when iterating quickly: point the marketplace at your working tree so a refresh
reads your edits directly — no commit/push per cycle.

```bash
# one-time: register THIS repo as a local marketplace source
claude plugin marketplace add /home/audichuang/research/agent-fleet-cc
# each cycle: edit code -> bump version -> refresh -> flip -> restart
claude plugin marketplace update agent-fleet   # reads the working tree, no push
```

Trade-off: you'll have a marketplace pointing at a local path (fine for dev). Real
releases still go through the git fork. You still must bump the version each cycle —
the cache is version-keyed regardless of source.

## Workflow C — unpushed branch (hand-materialize the cache)

Use when the marketplace points at GitHub but your change only exists on a local
branch (pre-review, nothing pushed). Skip the marketplace entirely — the cache is
just a directory and the pin is just JSON (verified end-to-end 2026-07-23, shipping
antigravity 0.6.0's subagent before it was pushed):

```bash
# 0) bump the version as always, then: payload -> versioned cache dir
cp -r plugins/<plugin> ~/.claude/plugins/cache/agent-fleet/<plugin>/<new>
# repoint the pin at it WITHOUT refreshing the marketplace (which would not have it)
npm run use-local -- <plugin> <new> --no-refresh
```

Re-copy after every rebase/amend or cache-worthy edit — the cache dir does not track
your working tree. `diff -rq plugins/<plugin> ~/.claude/plugins/cache/agent-fleet/<plugin>/<new>`
proves the payload is byte-identical.

## Flipping the active version

After `marketplace update` has materialized `cache/agent-fleet/<plugin>/<new>/`, make
it the live one. Three options, cleanest first:

1. **`/plugin` UI (official).** Open `/plugin`, find `<plugin>@agent-fleet`, choose
   update. It repoints the pin and persists correctly. One catch: it only offers an
   update if the marketplace's version is higher than the installed one — which is
   exactly why step 0 (the bump) matters.
2. **`npm run use-local` (direct replace, scripted — the easy button).** Wraps
   `scripts/use-local-version.mjs`: refreshes the marketplace, repoints
   `installed_plugins.json` at the new cache dir (backing the file up first), and
   verifies the cache exists before touching anything:
   ```bash
   npm run use-local -- codex            # version = whatever the marketplace offers
   npm run use-local -- codex 1.0.19     # or pin an explicit version
   npm run use-local -- codex --no-refresh   # skip the marketplace refresh
   ```
3. **Manual edit (direct replace, by hand).** Edit
   `~/.claude/plugins/installed_plugins.json`, the `"<plugin>@agent-fleet"` entry:
   set `installPath` → `.../cache/agent-fleet/<plugin>/<new>`, `version` → the new
   version, `gitCommitSha` → the marketplace clone's HEAD
   (`git -C ~/.claude/plugins/marketplaces/agent-fleet rev-parse HEAD`). Keep it
   valid JSON.

Then **restart Claude Code.**

## Verify

```bash
# the pin points at the new version
claude plugin list | grep <plugin>
# your actual change is in the live cache copy (grep for a string only your edit has)
grep -rc "<a string from your change>" \
  ~/.claude/plugins/cache/agent-fleet/<plugin>/<new>/
```

Then exercise it for real — e.g. for codex: `/codex:setup` shows `Status: ready`,
then run a real `/codex:rescue` or `/codex:review`. Grep'ing the cache is the fast
proof the bytes are live; the slash command is the proof it behaves.

Verifying plugin **agents** (subagents) has three extra traps (all hit for real on
2026-07-23):

- Agent definitions load at **session start**. `/reload-plugins` does NOT re-read
  `installed_plugins.json` — it reloads the paths resolved when the session started —
  and refreshing the cache dir under a running session changes nothing either. Every
  agent-content change needs a full restart to take effect.
- Headless `claude -p` loads **no plugin agents at all**, so it cannot probe them.
  Verify in an interactive session: call the Agent tool with
  `subagent_type: "<plugin>:<agent>"`, then prove the run went through the real
  runtime by checking it left a job record (e.g.
  `node plugins/antigravity/scripts/commands/status.mjs`).
- `claude plugin details <plugin>@agent-fleet` reflects the **marketplace clone**,
  not the installed pin — after a Workflow-C install it still shows the old
  version/component inventory. Trust `claude plugin list` (reads the pin) plus the
  cache grep instead.

## Quick reference

| Symptom | Cause | Fix |
|---|---|---|
| Updated marketplace, plugin still old | version unchanged → cache reused | bump version in plugin.json **and** marketplace.json |
| `claude plugin install` says "already installed" | install never upgrades | use `/plugin` update or repoint the pin |
| Repointed the pin, still old in this session | session loaded old version at start | restart Claude Code |
| Hand edit to installed_plugins.json reverted | a `/plugin` op in the stale session rewrote it | restart first, don't touch `/plugin` in the old session |
| `codex` structure test fails after bump | plugin.json and marketplace.json disagree | make both versions identical |
| Ran `/reload-plugins`, new agent still missing | reload keeps session-start paths, never re-reads the pin | full Claude Code restart |
| `plugin details` shows the old version after a flip | `details` reads the marketplace clone, not the pin | trust `claude plugin list` + cache grep |
