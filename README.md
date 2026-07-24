# agent-fleet — one marketplace for AI-agent delegation plugins

Five Claude Code plugins, one marketplace:

| Plugin | Commands | What it delegates to |
|---|---|---|
| `codex` | `/codex:*` (review, adversarial-review, task, execute-plan, rescue, handoff, status, wait, logs, result, attach, cancel, setup) | OpenAI Codex (app-server) |
| `antigravity` | `/antigravity:*` (review, adversarial-review, rescue, task, image, handoff, status, wait, logs, result, cancel, setup) | Google Antigravity CLI (`agy`) |
| `cc` | `/cc:*` (task, status, wait, logs, result, cancel, setup) | A headless Claude Code instance; profile picks the engine (native Claude / cheap endpoint / any model) |
| `grok` | `/grok:*` (task, status, wait, logs, result, cancel, setup) | xAI Grok Build (`grok`), headless — default model grok-4.5; auth via `grok login` or `XAI_API_KEY` |
| `fleet` | `/fleet:*` (setup, doctor, status) | Guided onboarding plus read-only fleet diagnostics/status |

> **`cc` v0.3.0** runs on the shared job runtime (`shared/lib/`). Its companion
> CLI also exposes machine-layer re-entry verbs `wait` and `logs` (with `--json`
> projections) for editors/orchestrators, and the same verbs are now exposed as
> `/cc:wait` and `/cc:logs`. `execute-plan` was removed in v0.2.0;
> hand a plan to `task` directly (or via `--prompt-file <path>`).

## Install

```bash
/plugin marketplace add audichuang/agent-fleet-cc

# Recommended starting point — install fleet and run the guided onboarding:
/plugin install fleet@agent-fleet
/fleet:setup

# fleet only *guides* the deep fixes; install the engine plugins you chose so
# their /<engine>:setup commands exist:
/plugin install codex@agent-fleet
/plugin install antigravity@agent-fleet
/plugin install cc@agent-fleet
/plugin install grok@agent-fleet
/reload-plugins
```

Install only the ones you use. Per-plugin requirements (codex CLI login, agy OAuth,
Anthropic-compatible endpoint profiles) are documented in each plugin's directory
under `plugins/<name>/`.

### Quick start: `fleet` (recommended first run)

```text
/fleet:setup        # pick the engines you want; checks readiness for each
/fleet:doctor       # direct local readiness check; no auth or network verification
/fleet:status       # read-only CLI board across installed engines; not a full TUI
```

`/fleet:setup` asks which engines you want (multi-select), runs one fast,
network-free readiness check, then — one decision at a time — explains any gap and
points you at that engine's own `/<engine>:setup` to fix it (install, `codex login`,
agy OAuth, or a `cc` profile). It is **guide-only**: it never runs another
command or logs you in for you. A `ready` engine means its binary/profile is
present, **not** that auth is done — run `/<engine>:setup` once on first use to
complete login, then re-run `/fleet:setup` to confirm.

`/fleet:doctor` is the non-interactive version of the local prerequisite check.
`/fleet:status` shells out to each installed engine's own read-only status command,
normalizes the rows, and prints a compact table with follow-up actions. The slash
wrappers intentionally run the all-engine view without raw slash arguments so user
text is never injected into a shell command; the underlying `fleet-doctor.mjs` and
`fleet-status.mjs` CLIs still support `--only` and `--json` for automation. This is
not a full terminal UI and does not translate any engine transcript.

### Lifecycle commands

The P0/P1 lifecycle surface is intentionally command-line oriented:

```text
/codex:task "..." --background
/codex:wait <job-id>
/codex:logs <job-id>

/antigravity:task "..." --background
/antigravity:wait <job-id>
/antigravity:logs <job-id> [--follow]

/cc:task "..." --background --profile <name>
/cc:wait <job-id>
/cc:logs <job-id> [--follow]

/fleet:doctor
/fleet:status
```

Codex log streaming delegates to its native attach/live-log path. Antigravity logs
come from persisted job logs; `agy --print` does not expose a tool-event stream, so
the plugin does not invent one. cc logs expose the shared-runtime event log.

### Quick start: `cc`

```text
/cc:setup        # checks the `claude` CLI + auto-creates a `native` profile on first run
```

`cc:setup` auto-creates a `native` profile (empty settings `{}` = your native
Claude login + default model), so `/cc:task "..."` works immediately. To run a
*different* engine, add another profile (a standard Claude Code settings JSON) at
`~/.claude/plugins/data/cc/profiles/<name>.json` with an `env` block pointing at
that endpoint (e.g. a cheaper model):

```json
{ "env": { "ANTHROPIC_BASE_URL": "https://...", "ANTHROPIC_AUTH_TOKEN": "sk-...", "ANTHROPIC_MODEL": "..." } }
```

Then run work:

```text
/cc:task "a complete, self-contained instruction" --profile <name>
/cc:status              # list jobs in this workspace
/cc:wait <job-id>       # block until a job reaches a terminal state
/cc:logs <job-id>       # print job events; add --follow to stream
/cc:result <job-id>     # fetch a job's result
/cc:cancel <job-id>     # cancel a running job
```

Long tasks: add `--background`, then poll `/cc:status`, block with
`/cc:wait <id>`, or inspect events with `/cc:logs <id> --follow`. Flags:
`--prompt-file <path>`, `--json`, `--model <id>`, `--read-only`,
`--resume-job <id>|--resume-last`, `--timeout-ms <n>`. Secrets in a profile's `env`
are read at spawn time and never written to job state.

### codex → cc handoff (Phase 2)

`cc` 是雙宿主 plugin:除了在 Claude Code 用 `/cc:*`,也能在 **Codex 當 host** 時把明確指派的子任務交給 headless Claude。

**安裝到 codex(使用者操作)**:將本 repo 註冊為 codex marketplace 後 `codex plugin add cc@<marketplace>`,確認 `~/.codex/config.toml` 出現 `[plugins."cc@<marketplace>"] enabled = true`。

**用法**:在給 codex 的 prompt 裡明確指派,例如「這段翻譯交給 Claude 跑」。codex 會載入 `cc-handoff` skill → 定位 `cc-companion`(PATH launcher 或搜尋)→ 設 `CC_PLUGIN_DATA` → 在專案根以 `cc-companion task --prompt-file <abs> --json` 前景同步跑 → 回報結果與「claude 改了哪些檔」。

**注意**:handoff 預設可寫(`bypassPermissions`);要唯讀加 `--read-only`。codex 端需先有 cc profile(`cc-companion setup` 會自動建 native)。

## Migrating from the standalone repos

This repo supersedes `audichuang/codex-plugin-cc` and `audichuang/antigravity-plugin`
(both archived) plus the local-only delegate plugin (since renamed to `cc`). The
codex/antigravity prefixes are unchanged; the old `/delegate:*` prefix is now `/cc:*`.

1. Uninstall the old plugins and remove the old marketplaces
   (`openai-codex`, `antigravity`, `claude-delegate`) — prefixes would collide.
2. Add this marketplace and install (commands above).
3. Done. Job state and profiles live under `~/.claude/plugins/data/<plugin>/`,
   keyed by plugin name — they survive unchanged (your `profiles/*.json` included).

## Development

```bash
npm test               # structure + shared + cc + antigravity + codex + grok + fleet + e2e
npm run test:cc        # one suite at a time (also test:fleet, test:codex, test:grok, …)
npm run test:e2e       # black-box CLI end-to-end regression for all 5 plugins (real subprocess, fake engine, no API key)
npm run sync-shared    # re-vendor shared/lib into each plugin's scripts/lib/shared/ (CI drift-checks this)
npm run build:codex    # typecheck the codex app-server glue (needs the codex CLI)
```

Run the suites on **Node 24**: the codex suite's unref'd-timer tests fail on 22.22–23.x, which is
why CI pins 24 even though `engines` still allows `>=22.3`.

Layout: `plugins/<name>/` is the exact install payload; `tests/<name>/` mirrors it with a hermetic
suite (fake binaries, redirected `CLAUDE_PLUGIN_DATA`, no real network). Contributor rules — how
to bump a version, what CI checks beyond `npm test`, which plugin may touch which — live in
[`AGENTS.md`](AGENTS.md).

**Shared foundation:** `shared/lib/` is a zero-dependency job runtime — a directory-per-job
state store with O_EXCL CAS terminal transitions, a generic adapter-driven worker (process-group
spawn/kill so engine grandchildren are reaped), mandatory env sanitization with a recursion
guard, and a parameterized 10-scenario conformance suite. `cc`, `grok`, and `antigravity` run the
full runtime — engine knowledge lives in a per-engine adapter (`makeClaudeAdapter`,
`makeGrokAdapter`, `makeAntigravityAdapter`), the job lifecycle in the shared lib — while `codex`
uses only the shared state core and drives its own app-server broker instead. Those four carry a
vendored copy under `scripts/lib/shared/`, kept in sync by `npm run sync-shared` and drift-checked
in CI. Designs live in `docs/specs/`.
