# Phase 7 — Smoke checklist (manual)

End-to-end verification of `antigravity-plugin` under each of the four hosts.
Run from a **fresh shell** (no env vars from prior sessions). Tick items as
you go.

## Prerequisites (do once)

- [ ] `node --version` → ≥ 18.18.0
- [ ] `agy --version` → ≥ 1.0.1
- [ ] Logged into a Google account that can use `agy` (run `agy --print 'hi'`
      once outside the plugin to complete OAuth — token cache persists)
- [ ] `gh auth status` → logged in as `sakibsadmanshajib`
- [ ] No `AGY_BIN`, `CLAUDE_ENV_FILE`, `CODEX_PLUGIN_DATA`, or `AGY_HOME`
      sourced from your shell rc that would confuse host detection

## Automated preflight

```bash
cd /path/to/antigravity-plugin
bash scripts/smoke.sh
```

Expected: every section emits `OK` and the final exit code is `0`.

## Host 1 — standalone (`npx`)

Run from any directory that is a git repo with at least one tracked change.

```bash
cd /tmp && rm -rf smoke-test && mkdir smoke-test && cd smoke-test
git init -q && echo "smoke" > README.md && git add -A && git commit -q -m init

node /path/to/antigravity-plugin/bin/antigravity.mjs --version
#   expect: 0.1.0

node /path/to/antigravity-plugin/bin/antigravity.mjs help review
#   expect: review flag summary

node /path/to/antigravity-plugin/bin/antigravity.mjs review --foreground
#   expect: agy launches, review completes, markdown printed to stdout, exit 0

node /path/to/antigravity-plugin/bin/antigravity.mjs status
#   expect: status table shows the just-completed review job
```

- [ ] `--version` works
- [ ] `help review` works
- [ ] `review` completes with markdown output
- [ ] `status` shows the job

## Host 2 — Claude Code

```bash
claude plugin marketplace add /path/to/antigravity-plugin
claude plugin install antigravity@antigravity
```

Inside Claude Code:

```
/antigravity:setup
/antigravity:review
/antigravity:rescue investigate why the existing tests pass
/antigravity:status
/antigravity:result <job-id>
/antigravity:cancel <job-id>   # only if you started a background job
```

- [ ] `/antigravity:setup` shows the OAuth URL or "already authenticated"
- [ ] `/antigravity:review` produces a review markdown
- [ ] `/antigravity:rescue` returns within a few minutes
- [ ] `/antigravity:status` lists jobs correctly
- [ ] `/antigravity:result` reproduces the review output
- [ ] No raw stack traces, no `Gemini` / `gemini-companion` / `--acp` strings

## Host 3 — Codex CLI

```bash
codex plugin marketplace add /path/to/antigravity-plugin
codex plugin marketplace list
#   expect: antigravity-plugin marketplace appears
```

Inside Codex CLI:

```
$antigravity setup
$antigravity review --base main
$antigravity status
```

- [ ] Marketplace registers
- [ ] `$antigravity setup` succeeds
- [ ] `$antigravity review` completes
- [ ] `$antigravity status` lists jobs

## Host 4 — agy native

```bash
agy plugin install antigravity@antigravity
#   OR (if Claude Code plugin already imported on this machine)
agy plugin import claude

agy plugin list
#   expect: antigravity appears

agy
#   then type a prompt that invokes the antigravity skill
```

- [ ] `agy plugin install` (or `agy plugin import claude`) succeeds
- [ ] `agy plugin list` shows `antigravity`
- [ ] Plugin commands are reachable from inside `agy`

## Reporting

Open `docs/SMOKE-REPORT-<date>.md` and capture:

1. Which boxes were ticked.
2. Any host that failed, with the exact command + output.
3. Whether OAuth had to be re-done (signal that auth scopes drifted between
   `agy --print 'hi'` cold-start and `/antigravity:setup`).
4. Wall-clock duration per host.

If any host fails, file an issue against `audichuang/antigravity-plugin`
with the report attached. Do **not** tag `v0.1.0` until every host has at least
one green smoke run.
