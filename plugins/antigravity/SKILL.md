---
name: antigravity
description: Use Google Antigravity CLI (agy) for code review, adversarial review, debugging, long-running task delegation, or large-context investigation. Hands off to agy's large-context window when the host wants a second opinion or a background pass instead of solving the task file-by-file.
allowed-tools: Bash, Glob, Read
---

# antigravity — when to use the `$antigravity` shortcut

Reach for `$antigravity` when any of these apply:

- You want a **second opinion** on a non-trivial diff, refactor, or design choice.
- The task benefits from a **large context window** (cross-file review, repo-wide impact analysis, long log triage).
- You want to **delegate a long-running task to the background** so the host session can keep working — e.g. "investigate why CI started failing on main" or "draft a migration plan for switching from X to Y".
- You want an **adversarial review** of code that's about to ship.

Skip `$antigravity` for trivial one-line edits or anything that requires interactive back-and-forth tighter than agy's `--print` round trips.

## Verbs

All verbs map to `scripts/commands/<verb>.mjs` and are byte-equivalent across Claude Code (`/antigravity:<verb>`), Codex CLI (`$antigravity <verb>`), agy itself (installed via `agy plugin install antigravity@antigravity` or `agy plugin import claude` — see [docs/INSTALL.md](./docs/INSTALL.md); agy 1.1.5 has no standalone `plugin run` subcommand), and standalone (`npx antigravity-plugin <verb>`).

| Verb     | What it does |
|----------|--------------|
| `setup`  | One-time OAuth wizard. Runs a one-shot `agy --print` probe in the foreground so the user can complete the Google OAuth flow visibly. Idempotent. |
| `review` | Reviews the working tree or branch diff (`--base <ref>`, `--scope`). Foreground by default — blocks and prints the review; `--background` forks a worker and returns a job id. |
| `adversarial-review` | Stricter structured review: asks agy for a JSON verdict and renders it (falls back to raw text). Foreground only. |
| `rescue` | Delegates an investigation or fix to agy — e.g. `$antigravity rescue why are the tests failing`. Foreground by default — prints agy's answer; `--background` returns a job id. Repo writes are opt-in via `--apply`. |
| `task`   | Generic long-running delegation, background by default (returns a job id). Supports `--continue`, `--conversation <id>`, `--add-dir <path>`, `--wait`, `--foreground`, `--json`, `--apply`. |
| `status` | Shows a compact table of current and recent jobs (id, kind, phase, health, last progress). Surfaces any pending OAuth URL prominently. |
| `result` | Prints the final output of a completed job by id. |
| `cancel` | Sends SIGTERM to a running worker by job id. |
| `wait`   | Waits for a background job to reach a terminal state. Returns exit code 10 when the wait times out. |
| `logs`   | Shows or follows the persisted job log. This is stdout/job-log only; agy `--print` does not expose live tool events. |

## Model

Every verb accepts `--model <name>` (`agy models` lists the options; since agy 1.1.5 it
prints slugs like `gemini-3.6-flash-medium` — older display names such as
`Gemini 3.6 Flash (High)` are still accepted and do switch the model). **Omit it** — agy's
default (a Gemini 3.5 Flash tier as of 1.1.5) is the recommended choice: fast and reliable
in `--print` mode, including SVG / markup generation (returns in seconds, clean output).

**Avoid `gemini-3.1-pro-high`** (`Gemini 3.1 Pro (High)`). In headless `--print` mode it
stalls on a backend wait that never returns (minutes at 0% CPU, empty log), doesn't actually
switch off the default, and one stalled call can wedge the session so later calls appear to
hang too. If you must override the model, stay on a Gemini Flash variant — 3.6 Flash
(`gemini-3.6-flash-medium` / `-high`) is verified fast and clean in `--print`, including via
the plugin's background job path (real agy 1.1.5, 2026-07-22).

## Timeouts — foreground dies at about five minutes

A foreground verb (`review`, `adversarial-review`, `rescue`, `task --foreground`) is bounded by
**agy's own print-mode timeout, which defaults to 5 minutes**, and the plugin passes it through
(`DEFAULT_PRINT_TIMEOUT_MS` in `scripts/lib/adapter.mjs`). A Node-side backstop sits one minute
later on purpose, so the engine always times out first and you get a clean error instead of a
killed process. Override either with `AGY_PRINT_TIMEOUT_MS` / `AGY_JOB_TIMEOUT_MS`.

Judge against five minutes, not against whatever ceiling the calling host has — under Claude
Code the Bash tool's ten-minute limit is the looser of the two and will never be what stops an
agy turn. Anything likely to run longer belongs in `--background`, which returns a job id
immediately and is bounded by neither.

A foreground run that does die still leaves a job record: it is created before the worker
starts. It can read `running` until something calls the dead-pid reconcile. `status`, `logs`, `wait`
and `result` each do on their next read, so any of those four resolves a cut-off run —
`$antigravity status` is the obvious one. (`cancel` reconciles as well, but it changes job
state; never run it just to look.) A killed call is not the same as a lost turn.

## Auth requirements

agy is **OAuth-only** (still true as of 1.1.5) — there is no API-key path yet (tracked upstream as `antigravity-cli#78`).

1. Run `$antigravity setup` (or `/antigravity:setup` from Claude Code) once per machine / account.
2. agy prints an OAuth URL — open it in a browser, complete the Google flow.
3. agy persists the refresh token in its own credential store. Subsequent invocations of any verb run silently.

If a background worker hits the auth prompt (e.g. a fresh machine), it captures the OAuth URL and surfaces it on `$antigravity status <job-id>` so you can still complete auth from a non-interactive session.

## Example prompts

```
$antigravity review --base main
$antigravity rescue investigate why the integration tests started failing after PR #42
$antigravity task --continue draft a migration plan from Sequelize to Drizzle
$antigravity status
$antigravity wait antigravity-mrvibyu3-9702f6 --timeout-ms 600000
$antigravity logs antigravity-mrvibyu3-9702f6 --follow
$antigravity result antigravity-mrvibyu3-9702f6
```

## Where this plugin lives (for Codex auto-discovery)

Codex picks this plugin up via:

- `.codex-plugin/plugin.json` — canonical Codex manifest.
- `.agents/plugins/marketplace.json` — Codex personal-marketplace descriptor.
- This `SKILL.md` at the plugin install root — skill-discovery entry.
- `agents/openai.yaml` — implicit-invocation interface (the `$antigravity` shortcut).

Claude Code, agy, and standalone hosts ignore the Codex-specific files and consume `.claude-plugin/`, `plugin.json` (root), and `bin/antigravity.mjs` respectively. See [docs/INSTALL.md](./docs/INSTALL.md) for per-host install recipes.
