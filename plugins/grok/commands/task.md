---
description: Run a headless Grok Build task (grok-4.5) — launch, then wait/poll for the result
argument-hint: "<prompt> [--prompt-file <path>] [--model <id>] [--effort none|minimal|low|medium|high|xhigh|max] [--no-subagents] [--schema <path>] [--background|--wait] [--json] [--resume-job <job>|--resume-last] [--timeout-ms <n>]"
---

Run the grok companion with the user's arguments and relay its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task $ARGUMENTS
```

- The prompt must be a complete, self-contained instruction — spell out files,
  constraints, and the definition of done. It runs headlessly with tool
  execution auto-approved, against `grok-4.5` by default.
- **Grok is cheap (grok-4.5) — fan out, but fence the final report.** For
  research or broad sweeps, tell Grok to spawn parallel subagents (it has
  first-class subagent support); a wide fan-out costs little here. The catch:
  a multi-agent run concatenates *every* agent's text into one undelimited
  stream — subagent output leaks into the result and can't be told apart, no
  matter what you instruct the subagents (tested: it leaks regardless). The one
  reliable fix is a sentinel the leader controls. End the prompt with this:
  > Wrap ONLY your final consolidated report between two sentinels, each on its
  > own line: a line `<<<GROK_FINAL>>>`, then the report, then a line
  > `<<<GROK_END>>>`. Anything outside the sentinels (subagent chatter, your own
  > thinking-aloud) is discarded — do not try to suppress it.

  The companion returns only what's between the sentinels as the result; the
  full raw stream stays in the job log (`/grok:logs`). No sentinels emitted →
  you get the full text unchanged. Use `--no-subagents` to force a single agent
  (no fan-out) when you don't want this at all.
- For long tasks use `--background`, then poll with `/grok:status` (or, for an
  orchestrator, the companion `wait <id>` verb blocks until completion).
- Use `--json` for machine-readable output (job id, status, exit code).
- Use `--prompt-file <path>` to pass a prompt stored in a file.
- Use `--model <id>` (only `grok-4.5` and `grok-composer-2.5-fast` exist — see
  `grok models`) or `--effort` (`none|minimal|low|medium|high|xhigh|max`) to tune the run.
- **Structured output**: pass `--schema <path>` (a JSON Schema file) to constrain
  the answer to that shape — `resultText` comes back as JSON matching the schema,
  ready to `JSON.parse`. This runs Grok non-streaming (no live `/grok:logs` for
  that job) and needs no fan-out sentinel. Good for extraction/classification
  tasks where you want fields, not prose.
- Use `--resume-job <job>` or `--resume-last` to continue a previous Grok session.
- Never re-run a failed job — it may already have side effects.
- Report the companion's output back to the user verbatim.
