---
description: Run a headless Grok Build task (grok-4.5) — launch, then wait/poll for the result
argument-hint: "<prompt> [--prompt-file <path>] [--model <id>] [--effort high|medium|low] [--background|--wait] [--json] [--resume-job <job>|--resume-last] [--timeout-ms <n>]"
---

Run the grok companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task $ARGUMENTS
```

- The prompt must be a complete, self-contained instruction — spell out files,
  constraints, and the definition of done. It runs headlessly with tool
  execution auto-approved, against `grok-4.5` by default.
- For long tasks use `--background`, then poll with `/grok:status` (or, for an
  orchestrator, the companion `wait <id>` verb blocks until completion).
- Use `--json` for machine-readable output (job id, status, exit code).
- Use `--prompt-file <path>` to pass a prompt stored in a file.
- Use `--model <id>` (e.g. `grok-composer-2.5-fast`) or `--effort` to tune the run.
- Use `--resume-job <job>` or `--resume-last` to continue a previous Grok session.
- Never re-run a failed job — it may already have side effects.
- Report the companion's output back to the user verbatim.
