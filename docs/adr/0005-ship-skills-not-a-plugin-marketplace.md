# Ship skills, not a Claude Code plugin marketplace

**Context.** By codex 2.0.1 and imagine 0.3.0 both plugins had shed everything a plugin adds
over a skill: no slash commands, subagents, hooks or MCP servers, one `SKILL.md` each plus the
scripts it runs. The marketplace wrapper still cost a manifest pair per plugin kept in step by a
bump script, a vendored copy of the job store kept in step by a sync script, a separate install
path per agent, and a plugin data dir the scripts had to reverse-engineer from the install path
because a skill's Bash call never sees `CLAUDE_PLUGIN_DATA`. On 2026-10-11 a session whose config
dir linked `plugins/` to another config dir called the companion through that symlink; the entry
guard compared the symlinked `argv[1]` with the real module path, skipped `main()`, and exited 0
with no output, and the session lost a round finding out why.

**Decision.** The repo ships two skills, `skills/codex/` and `skills/imagine/`, under `skills/`, installed with
aghub or `npx skills` like the maintainer's other skills. The marketplace, plugin manifests,
`bump-version`, `sync-shared`, the repo-level `shared/` source and the `local-install-test` skill
are removed. A skill's version is `metadata.version` in its `SKILL.md`, paired with its CHANGELOG.
codex keeps jobs in `~/.local/state/codex-companion` (`CODEX_COMPANION_DATA` overrides) and still
finds jobs the plugin wrote by id. Entry guards compare real paths, because installed skills are
symlinks by default.

**Why.** One payload per skill that every agent installs the same way, with one version field and
no copies to keep in sync. The repo's edit is the live skill after a re-sync, instead of a
versioned cache that silently kept the old copy.

**Cost.** Users of the plugin have to uninstall it and install the skill; an installed 2.0.1 keeps
working but gets no updates. `${CLAUDE_SKILL_DIR}` is a Claude Code substitution; other agents are
told in the `SKILL.md` to use the skill's own directory. Developer notes moved out of the skill
directories into `docs/<skill>-dev.md`, so they no longer load when an agent opens the files under
`skills/codex/` or `skills/imagine/`.
