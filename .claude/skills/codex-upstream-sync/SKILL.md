---
name: codex-upstream-sync
description: >-
  Checks that the codex skill is still compatible with the Codex CLI: the installed binary and
  what upstream main is about to ship. Use when a new codex-cli version is installed, when
  upstream codex has new commits since the last Audit-log row, or when asked whether the
  skill works with the latest Codex.
---

# Codex upstream sync

The skill drives Codex's app-server JSON-RPC protocol, and Codex moves daily. This is the
routine pass: a deterministic script does the diffing, you classify what it found, and the
result lands as a row in `docs/codex-protocol-sync-audit.md` so the next pass starts where this
one ended. The doc's "How to keep this current" section holds the deeper, multi-agent audits;
this skill says when to escalate to them.

## Steps

1. **Fetch the codex checkout.** It is `../codex` beside this repo's main checkout (the script
   finds it from a worktree too), or `$CODEX_REPO` when a machine keeps it elsewhere. `git -C <codex> fetch -q origin`, then
   `git -C <codex> merge -q --ff-only origin/main` when its worktree is clean. The script reads
   refs only and never fetches, so a stale checkout gives a stale answer; its report opens with
   the last fetch's age. When you cannot run git there (a sandboxed worktree), ask the user to
   fetch and stop until they have.

2. **Run the check and keep its exit code.**
   ```bash
   node .claude/skills/codex-upstream-sync/scripts/upstream-check.mjs > <scratchpad>/upstream-check.log; echo $?
   ```
   `--since <sha>` overrides the start point, which defaults to the commit on the newest
   Audit-log row. `--json` gives the same report as data. Exit 0: nothing removed at the
   installed pin. Exit 1: something the installed binary removed needs a verdict. Exit 2: the
   check could not run, most often no release ref matching the installed binary until you fetch.

3. **Classify every item in the report**, using the doc's severity words (`breaking`,
   `should-upgrade`, `cosmetic`, `none`). Done when every line of the pin section and the
   forward-look section has one.
   - *Pin sections* (one per candidate release branch) = what the installed binary gained since
     the last checked pin. A schema
     deletion or a "companion names gone upstream" entry is `breaking` until you show otherwise.
     Read the deleted lines against the dependency checklist in the doc's Part 1 ("What the
     plugin sends/reads").
   - *Forward-look section* = main, not shipped yet. Same reading, and the verdict is a heads-up
     for the next release rather than a fix now.
   - *Commit titles on protocol paths* catch behaviour changes the schema cannot show (a
     `thread/resume` that now restores settings, an error that became terminal). Open the
     commits that touch a method the companion uses; `--json` lists those names under
     `companionMethodNames`.
   - *New `CodexErrorDetails` variants*: the report marks the terminal ones. Check whether the
     skill's failure table (`skills/codex/references/background-jobs.md`) should name it and
     whether a wire `codexErrorInfo` tag came with it.
   - *Model catalog*: the configured default model must be listed. Model names and effort levels
     stay out of shipped prose (AGENTS.md conventions).

4. **Typecheck against the installed binary:** `npm run build:codex > <scratchpad>/build.log;
   echo $?`. Its prebuild regenerates types from the binary, so `tsc` catches drift in what the
   companion types. Its requests go through an untyped `client.request`, so neither this nor the
   script proves request params: for each params schema the pin section lists as changed, read
   it against what the companion sends (Part 1's checklist).

5. **Escalate** to the doc's two full audits and a real-engine smoke (the `e2e-testing` skill)
   when step 3 found anything `breaking` or `should-upgrade` at the pin, or a failure or error
   path changed. Both spend another engine's quota: ask the user first.

6. **Record the pass.** Paste the report's row skeleton at the top of the Audit log and fill in
   the verdict, the anchors you read, and what was **not run**. Keep its ``pin `<ref>` @ `<sha>` ``
   text as written: the next pass's pin sections start from it. A no-drift pass gets a row too:
   the next run's `--since` comes from it. When main has no commits past `--since` and the
   installed version matches the newest row, there is nothing new to record: report that
   instead of adding a row. A doc-only row may be committed straight to `main`;
   a companion fix follows AGENTS.md's review gate and touches only `skills/codex/` and
   `tests/codex/`. Pushing either waits for the user's go.

The pass is complete when the new row's commit is the fetched main and every reported item has
a verdict in it.

## How the script decides

- **Pin.** A `rust-v<version>` tag when one exists. Otherwise it exports the installed binary's
  schema and takes every `release/<version>*` branch whose `schema/json` matches it file for
  file. Matching schemas do not prove matching source, so each candidate gets its own section
  and a break in any of them fails the run.
- **Two baselines.** The forward look diffs main from `since`. The pin sections diff from the
  last recorded pin instead, because `since` follows main: a change first seen as a forward look
  is already behind `since` when it ships, and only the old pin still sees it as new. Both diffs
  start at the merge-base with the ref, so later main additions a release branch lacks do not
  read as deletions. With no recorded pin, the pin sections fall back to `since` and say so.
- **Companion names.** It collects every string literal in `skills/codex/scripts` and keeps the
  ones upstream declared as a method at any commit in the Audit log. A name in that set that the
  pin no longer declares is a break. Using every logged commit rather than `since` alone means a
  removal first seen as a forward look stays caught after its row moves `--since` past it. The
  set is derived from code, so it cannot drift from what the companion sends and handles.
