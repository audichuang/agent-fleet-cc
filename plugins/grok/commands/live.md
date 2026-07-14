---
description: Run a Grok Build task (grok-4.5) as a VISIBLE live shell — a background streaming shell you watch run and see fail, instead of a silent detached job
argument-hint: "<prompt> [--prompt-file <path>] [--model <id>] [--effort none|minimal|low|medium|high|xhigh|max] [--no-subagents] [--schema <path>] [--json] [--resume-job <job>|--resume-last] [--timeout-ms <n>]"
allowed-tools: Bash(node:*)
---

Run grok as a **visible live shell**: the same one-shot task as `/grok:task`, but
launched inside a Claude Code background shell so the user *watches it run and sees
it die*. Grok's raw progress streams to the shell (stderr) as it works, the final
report lands on stdout when it finishes, and if the job fails the shell exits
non-zero and turns red at that moment. Reach for this whenever you want a
delegation kept visible — never fire a silent detached job and walk away.

## Launch it (run_in_background)

Launch the companion's live-streaming task inside a `run_in_background: true` Bash
**tool** call — NOT the shell foreground, and NOT `--background` (that flag is the
durable detached worker, which runs silently):

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task --live $ARGUMENTS`,
  description: "grok live task",
  run_in_background: true
})
```

**Path guard — copy it, do not reconstruct it.** The `node "…/scripts/grok-companion.mjs"`
in the command above is already a concrete absolute path (the plugin-root
placeholder was expanded before you saw it). **Copy that exact string into the Bash
call.** The path legitimately lives under a versioned cache dir
(`…/agent-fleet/grok/<version>/scripts/…`) — that is fine *as shown*; what is fatal
is rebuilding it yourself. Do not guess or retype the `<version>` segment from
memory or another context (it drifts every release), and do not paste an unexpanded
`${…}` placeholder (a plain Bash call will not expand it). Either mistake dies with
"Cannot find module". The path you were shown is correct — use it verbatim.

## Rules

- **Prompt.** It must be complete and self-contained — spell out files, constraints,
  and the definition of done. For a large or multi-line prompt, write it to a file
  and pass `--prompt-file <path>`; never `"$(cat file)"` as the positional prompt (a
  missing/mis-written file silently collapses to an empty prompt and the run does
  nothing).
- **Session-scoped.** `run_in_background: true` keeps the job alive only within THIS
  session — close the session and the job ends. For a durable job that must outlive
  the session (fire-and-forget), run `/grok:task --background` instead and accept
  that it detaches into a silent job.
- **Watch it, don't abandon it.** After launching, monitor the background shell:
  relay grok's streamed progress, and when it exits report the final result. A
  non-zero exit is a failure — surface it. Never silently re-run a failed job; it may
  already have side effects.
- **Flags** pass through to `task` unchanged (`--model`, `--effort`,
  `--no-subagents`, `--resume-job` / `--resume-last`, `--timeout-ms`, `--json`).
  `--live` is foreground-only — it cannot combine with `--background` or `--wait`.
- **`--schema` runs non-streaming.** grok's structured-output mode emits one JSON
  object only at completion, so `/grok:live --schema` has *no* live progress — the
  shell stays quiet until it finishes, giving death-visibility (red on failure) but
  not a live stream. Use plain `/grok:live` when you want to watch it work.
- Fan-out and the `<<<GROK_FINAL>>>` sentinel behave exactly as in `/grok:task` — see
  that command when you tell grok to spawn subagents.
