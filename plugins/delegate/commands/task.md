---
description: Delegate an execution task to a cheap-model headless Claude Code instance
argument-hint: "<prompt> [--profile <name>|--settings <path>] [--background] [--resume-last|--resume-id <job>] [--timeout-ms <n>]"
---

Run the delegate companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" task $ARGUMENTS
```

- For long tasks add `--background`, then poll with /delegate:status.
- The prompt must be a complete, self-contained instruction — the delegate
  is a cheap model: spell out files, constraints, and the definition of done.
- Report the companion's output back to the user verbatim.

## Profile selection (no --profile given)

If the user's arguments include `--profile` or `--settings`, forward them
as-is. Otherwise, if the DELEGATE_DEFAULT_PROFILE environment variable is
set, also forward as-is (the companion uses it). Otherwise:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" setup`
   and read the `✓ profile <name>` lines to learn which profiles exist.
2. No profiles: do not run the task. Show the user the setup output and how
   to create a profile.
3. Exactly one profile: run the task with `--profile <name>` and tell the
   user which profile was used.
4. Two or more: use AskUserQuestion to let the user pick one (one option per
   profile), noting that setting DELEGATE_DEFAULT_PROFILE skips this
   question. Then run with the chosen `--profile`.

Never guess a profile for the user, and never re-run a failed job on a
different profile — failed jobs may already have side effects.
