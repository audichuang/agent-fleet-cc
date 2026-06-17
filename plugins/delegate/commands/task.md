---
description: Delegate an execution task to a cheap-model headless Claude Code instance
argument-hint: "<prompt> [--prompt-file <path>] [--profile <name>|--settings <path>] [--background] [--json] [--model <id>] [--read-only] [--resume-job <job>|--resume-last] [--timeout-ms <n>]"
---

Run the delegate companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-companion.mjs" task $ARGUMENTS
```

- The prompt must be a complete, self-contained instruction — the delegate
  is a cheap model: spell out files, constraints, and the definition of done.
- For long tasks use `--background`, then poll with `/delegate:status` (or, for an
  orchestrator, use the companion `wait <id>` verb to block until completion).
- Use `--json` to receive machine-readable output (job id, status, exit code).
- Use `--prompt-file <path>` to pass a prompt stored in a file instead of inline.
- Use `--read-only` to run the delegate without write permissions.
- Use `--model <id>` to override the model the delegate runs (defaults to the profile's model).
- Use `--resume-job <job>` or `--resume-last` to continue a previous job.
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
