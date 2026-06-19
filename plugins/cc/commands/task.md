---
description: Run a task on a headless Claude Code instance — the profile picks the engine (native Claude, a cheap endpoint, or any model)
argument-hint: "<prompt> [--prompt-file <path>] [--profile <name>|--settings <path>] [--background|--wait] [--json] [--model <id>] [--read-only] [--resume-job <job>|--resume-last] [--timeout-ms <n>]"
---

Run the cc companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-companion.mjs" task $ARGUMENTS
```

- The prompt must be a complete, self-contained instruction — spell out files,
  constraints, and the definition of done. The instance runs whatever model the
  chosen profile points at (native Claude with an empty profile, or a cheaper
  endpoint), so don't assume a strong model unless the profile is native.
- For long tasks use `--background`, then poll with `/cc:status` (or, for an
  orchestrator, use the companion `wait <id>` verb to block until completion).
- Use `--json` to receive machine-readable output (job id, status, exit code).
- Use `--prompt-file <path>` to pass a prompt stored in a file instead of inline.
- Use `--read-only` to run the instance without write permissions.
- Use `--model <id>` to override the model the instance runs (defaults to the profile's model).
- Use `--resume-job <job>` or `--resume-last` to continue a previous job.
- Report the companion's output back to the user verbatim.

## Profile selection (no --profile given)

If the user's arguments include `--profile` or `--settings`, forward them
as-is. Otherwise, if the CC_DEFAULT_PROFILE environment variable is
set, also forward as-is (the companion uses it). Otherwise:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cc-companion.mjs" setup`
   and read the `✓ profile <name>` lines to learn which profiles exist.
2. No profiles: run `/cc:setup` first — it auto-creates a `native` profile
   (empty settings = native Claude). Then run with `--profile native`.
3. Exactly one profile: run the task with `--profile <name>` and tell the
   user which profile was used.
4. Two or more: use AskUserQuestion to let the user pick one (one option per
   profile), noting that setting CC_DEFAULT_PROFILE skips this
   question. Then run with the chosen `--profile`.

Never guess a profile for the user, and never re-run a failed job on a
different profile — failed jobs may already have side effects.
