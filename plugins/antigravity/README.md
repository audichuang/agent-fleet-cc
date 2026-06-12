# antigravity-plugin

Multi-host plugin for delegating tasks and code reviews to
[Google Antigravity CLI (`agy`)](https://antigravity.google).

Hardened fork of
[`sakibsadmanshajib/antigravity-plugin`](https://github.com/sakibsadmanshajib/antigravity-plugin)
(itself the successor to `gemini-plugin-cc`, archived because Google
[retires Gemini CLI on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
for free / personal users). This fork adds image generation and a handoff
loop, makes background jobs crash-survivable (cross-process terminal CAS,
dead-PID reconcile, a liveness watchdog), and ships the missing slash-command
wiring with a CI-gated test suite.

## Status

> **Pre-release (v0.2.0).** Active development. Expect breaking changes until
> v1.0.0. See [`CHANGELOG.md`](./CHANGELOG.md).

## What it does

Spawns `agy --print` (or `--continue` / `--conversation <id>`) from inside your
preferred AI host so you can:

- Review uncommitted changes or a branch diff — free-form or as a strict,
  structured **adversarial review**.
- Delegate a fix, investigation, or refactor without leaving your current host.
- Generate images with agy's built-in Imagen tool.
- **Hand off** the session to agy with a one-key reflect → handoff → continue loop.
- Run multiple delegations in parallel with background job tracking that
  **survives a crashed worker** (a detached watchdog reaps dead/hung jobs).

## Where it runs

The marketplace is named `antigravity` (from `.claude-plugin/marketplace.json`),
so the plugin installs as `antigravity@antigravity` after adding this fork's repo
as a marketplace.

| Host             | Install command                                                    |
|------------------|--------------------------------------------------------------------|
| Claude Code      | `claude plugin marketplace add audichuang/antigravity-plugin` then `claude plugin install antigravity@antigravity` |
| Codex CLI        | `codex plugin marketplace add <path-to-clone>` then `$antigravity setup` (see [docs/INSTALL.md](./docs/INSTALL.md)) |
| Antigravity (agy)| `agy plugin marketplace add audichuang/antigravity-plugin` then `agy plugin install antigravity@antigravity` |
| Standalone       | `npx antigravity-plugin <command>`                                 |

## Requirements

- Node.js ≥ 18.18.0 (the test suite needs ≥ 22.3 for `mock.module`)
- `agy` v1.0.7+ on `PATH` ([install from antigravity.google](https://antigravity.google/download))
- A Google account for `agy` OAuth (run `agy --print 'hi'` once or `/antigravity:setup`)

## Quick start (Claude Code)

```bash
# 1. add the marketplace (registered as `antigravity`)
claude plugin marketplace add audichuang/antigravity-plugin

# 2. install  (plugin@marketplace = antigravity@antigravity)
claude plugin install antigravity@antigravity

# 3. one-time auth
/antigravity:setup

# 4. use
/antigravity:review
/antigravity:rescue investigate why the tests started failing
/antigravity:image a flat icon of a paper plane --output /tmp/plane.png
/antigravity:handoff           # hand the session to agy to continue
```

## Commands

| Command | What it does |
|---------|--------------|
| `/antigravity:setup` | Verify `agy` is installed + complete OAuth (idempotent). |
| `/antigravity:review [--base <ref>] [--scope ...] [--model <id>]` | Free-form review of the working-tree or branch diff (read-only `--sandbox`). |
| `/antigravity:adversarial-review` | Strict, structured (JSON) review rendered as markdown. |
| `/antigravity:rescue <task> [--background] [--continue] [--model <id>] [--prompt-file <p>]` | Delegate a free-form task to agy. |
| `/antigravity:task <task> [--foreground] [--wait]` | Free-form prompt with background job tracking (background by default). |
| `/antigravity:image <desc> [--name <n>] [--output <path>]` | Generate an image with agy's `generate_image` (Imagen). |
| `/antigravity:handoff [focus] [--print] [--background]` | Write a handoff doc and hand the work to agy to continue. |
| `/antigravity:status [<id>] [--wait]` · `/antigravity:result [<id>]` · `/antigravity:cancel [<id>]` | Inspect / fetch / cancel background jobs. |

Background jobs survive a crashed or SIGKILL'd worker: a synchronous dead-PID
reconcile (on every status read) plus a detached liveness watchdog mark a job
failed instead of leaving it stuck `running` forever, and terminal transitions
use a cross-process O_EXCL lock so a cancel never clobbers a real result.

## Documentation

- [Installation](./docs/INSTALL.md) — per-host setup recipes
- [Spike findings](./docs/SPIKE-findings.md) — why we dropped ACP

## Testing

```bash
npm test   # node --test --experimental-test-module-mocks tests/*.test.mjs
```

The suite is **hermetic**: it never spawns the real `agy` or touches your real
`~/.claude`. Instead it points `CLAUDE_PLUGIN_DATA` at a temp dir and uses a
fake `agy` (a stub script via `AGY_BIN`). It covers the pure logic (CAS,
liveness classification, image-path extraction, review-JSON parsing) plus
real-subprocess integration of the worker, the watchdog reaping a dead-PID job,
and each command's self-invoke path. Runs in CI on Node 22.x/24.x.

## License

MIT — see [`LICENSE`](./LICENSE).
