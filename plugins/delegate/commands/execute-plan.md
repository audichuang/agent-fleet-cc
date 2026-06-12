---
description: Hand a plan file to a cheap-model headless Claude Code for full implementation
argument-hint: "<plan-file> [--profile <name>|--settings <path>] [--background] [--timeout-ms <n>]"
---

Run the delegate companion and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" execute-plan $ARGUMENTS
```

Plans are executed literally — make sure the plan file is complete before delegating.

## Profile selection (no --profile given)

If the user's arguments include `--profile` or `--settings`, forward them
as-is. Otherwise, if the DELEGATE_DEFAULT_PROFILE environment variable is
set, also forward as-is (the companion uses it). Otherwise:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" setup`
   and read the `✓ profile <name>` lines to learn which profiles exist.
2. No profiles: do not run the plan. Show the user the setup output and how
   to create a profile.
3. Exactly one profile: run the plan with `--profile <name>` and tell the
   user which profile was used.
4. Two or more: use AskUserQuestion to let the user pick one (one option per
   profile), noting that setting DELEGATE_DEFAULT_PROFILE skips this
   question. Then run with the chosen `--profile`.

Never guess a profile for the user, and never re-run a failed job on a
different profile — failed jobs may already have side effects.
