---
description: Guided onboarding for the agent-fleet engines (pick the ones you want, fix only those)
allowed-tools: Bash(node:*), AskUserQuestion
---

You are guiding the user through getting the agent-fleet engines ready. Be
Matt-Pocock-style: assume the user does not know the jargon, show sensible
defaults, ask exactly ONE decision at a time, and never dump everything at once.
Only ever check the engines the user picks.

**This command is GUIDE-ONLY.** You run `fleet-doctor` exactly ONCE (Step 2) and
you NEVER invoke another slash command yourself. For every gap you EXPLAIN the
problem and RECOMMEND the user run `/<engine>:setup` themselves, then they re-run
`/fleet:setup` to confirm. Do not claim to dispatch, run, or consume the output
of any other slash command.

## Step 1 — Pick engines (do this FIRST)

Your very first action is a single `AskUserQuestion` (multi-select) asking which
engines the user wants to set up. Offer exactly these options (plain-language
labels with the binary named):

- `codex` — OpenAI Codex CLI (review / delegate tasks)
- `antigravity` — Google Antigravity CLI (`agy`)
- `delegate` — cheap-model headless Claude Code via profiles

Only the chosen engines proceed.

**If the user selects nothing:** do NOT run `fleet-doctor`. Print exactly:
"nothing to set up — re-run `/fleet:setup` when you want to add an engine." and
stop.

## Step 2 — Explore (run the doctor ONCE)

Run this ONCE with the chosen engines comma-joined (canonical order does not
matter — the doctor re-sorts). This is the ONLY time you invoke fleet-doctor:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-doctor.mjs" --json --only <comma-joined-chosen-engines>
```

Parse the JSON from stdout. If stdout is empty or is not valid JSON, the check
could not run: tell the user plainly, show the raw stderr, and suggest
re-running `/fleet:setup`. (A usage error still returns a JSON `{"error": ...}`
object — surface its `error` message; that is not a crash.)

Remember: every engine's `authVerified` is `false`. Even `allReady: true` does
NOT mean the engines are logged in. If `allReady` is `true`, skip to Step 4
(which must still print the auth caveat).

## Step 3 — Explain + RECOMMEND the user-run fix, one decision at a time

For each `not-ready` engine, in the order they appear in `checkedEngines`:

1. Explain the gap in plain language from `summary` / `reason`
   (e.g. "Codex isn't installed yet — that's the OpenAI CLI this plugin drives.",
   or for `app-server-failed`: "Codex is installed but its app-server interface
   isn't responding, so it's not fully ready yet.").
2. Ask ONE `AskUserQuestion` to decide whether the user wants guidance to fix
   THIS engine now. Options: `Show me how to fix <engine> (Recommended)` /
   `Skip <engine>`. Do not ask about the next engine until this one is resolved.
3. On "show me how," GUIDE the user — state the gap and tell them the exact
   slash command THEY should run themselves. Do NOT invoke that command and do
   NOT wait on or consume its output:
   - **codex** (`binary-missing` / `version-failed` / `app-server-failed`):
     recommend the user run `/codex:setup` themselves (it offers
     `npm install -g @openai/codex`, re-checks, and preserves `!codex login`
     guidance). For `app-server-failed`, explain that `codex --version` worked
     but `codex app-server --help` did not, so codex is installed but not fully
     wired up — `/codex:setup` is still the right place to repair it. Do not
     install codex or run `codex login` yourself.
   - **antigravity** (`binary-missing` / `version-failed`): if `binary-missing`,
     tell the user to install from the engine's `installUrl`
     (`https://antigravity.google/download`), then run `/antigravity:setup`
     themselves. If `version-failed`, mention the resolved `binPath` /
     `resolvedFrom` so they know which binary failed, then point them at
     `/antigravity:setup`. Never run `agy --print` yourself.
   - **delegate** (`cli-missing` / `cli-version-failed` / `no-profiles` /
     `no-valid-profiles`): recommend the user run `/delegate:setup` themselves.
     For `no-valid-profiles`, surface the specific `profiles[].error`
     (`invalid-name` / `unparseable-json` / `non-scalar-env`) and the offending
     `name` so the user knows which file to fix, then tell them to run
     `/delegate:setup`.
4. **Plugin-not-installed fallback.** If the engine's plugin may not be installed
   (its `/<engine>:setup` slash command does not exist in this session), tell the
   user to FIRST run `/plugin install <engine>@agent-fleet`, THEN `/<engine>:setup`.
5. **Confirm by re-running.** After guiding, tell the user to re-run `/fleet:setup` once they have finished the deep fix, to confirm the engine is now `ready`. Do NOT re-run `fleet-doctor` — Step 2 was its only invocation, and you do not consume any nested re-check output.

On `Skip <engine>`, leave it `not-ready`, continue to the next engine, and list
it in the final summary. No nagging, no auto-retry, no in-flow dispatch.

## Step 4 — Ready-summary

Print a compact summary: for each chosen engine, either `ready` or
`still not-ready (run /<engine>:setup yourself, then re-run /fleet:setup)`.

**Auth caveat (ALWAYS print, even when every engine is `ready`).** Tell the user plainly: auth was NOT verified by fleet-doctor, so `ready` means local prerequisites only — not that the engine is logged in or usable right now. Because `fleet-doctor` never verifies auth (`authVerified: false` on every engine), on first use the user should run the engine's own setup to complete auth:
- codex → `/codex:setup` (guides `codex login`),
- antigravity → `/antigravity:setup` (runs the OAuth flow),
- delegate → `/delegate:setup` (the token lives in each profile's `env`;
  `fleet-doctor` only checked shape, never the token).

Do NOT present `ready` as "usable now."

**When `delegate` is `ready`** (claude CLI present + ≥1 valid profile),
additionally print this manual real-smoke one-liner as an informational hint,
using the REAL installed slash command and substituting `firstValidProfile`
for `<name>`:

```text
/delegate:task "hello" --profile <name> --json
```

This is a hint the user may run manually. Never run it yourself — that would be
a real-API smoke, which is out of scope.
