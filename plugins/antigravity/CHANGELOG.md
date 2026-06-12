# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-06-10

Hardening fork (audichuang). Adds features, makes background jobs
crash-survivable, and fixes the slash-command wiring — all behind a CI-gated,
hermetic test suite.

### Added

- **`/antigravity:image`** — generate images with agy's built-in `generate_image`
  (Imagen); recovers the saved path from an `IMAGE_PATH:` marker (last-wins,
  with a scrape fallback) and optionally copies it to `--output`.
- **`/antigravity:handoff`** — reflect → write a handoff document to the OS temp
  dir → hand it to agy to continue → bring the response back (`--print` to only
  write the doc). Includes a suggested-skills section and redaction guidance.
- **`/antigravity:adversarial-review`** — strict, structured (JSON) review,
  parsed tolerantly and rendered via `renderReviewResult` (previously dead code).
- **`/antigravity:setup`** Claude slash command (was reachable only via npx/Codex).
- **Liveness watchdog** (`scripts/commands/_watchdog.mjs` + `lib/liveness.mjs`):
  a detached, escalate-not-kill monitor that reaps a dead/wedged background
  worker without anyone polling status.
- Native **`--model`** forwarding (verbatim) on review/adversarial-review/rescue/
  task/image; review/adversarial-review enforce read-only via **`--sandbox`**.
- **`--prompt-file`** on rescue (used by handoff); configurable timeouts
  (`AGY_PRINT_TIMEOUT_MS`, `AGY_JOB_TIMEOUT_MS`) wired to agy's `--print-timeout`
  plus a Node-side hard backstop.
- GitHub Actions CI running the hermetic suite on Node 22.x/24.x.

### Fixed / Changed

- **Cross-process terminal CAS** (`claimTerminalTransition` / `applyJobPatchIfActive`,
  O_EXCL `.lock`, first-writer-wins): a cancel racing a worker's natural
  completion no longer clobbers the real result (was last-writer-wins).
- **Dead-PID reconcile** on every `listJobs`: a SIGKILL'd/rebooted worker's job
  is auto-failed instead of staying `running` forever.
- **Cancel safety**: re-reads the per-job file for the authoritative pid,
  verifies liveness before signalling, and terminates the whole process group
  (so the real `agy` grandchild is reaped, not just the Node worker).
- **Self-invoke shim** (`lib/cli-entry.mjs`) on every command module — the
  slash-command `.md` path (`node …/<verb>.mjs`) previously did nothing.
- Corrupt `state.json` / per-job files are quarantined + warned instead of
  silently returning an empty index; progress heartbeats now populate
  `lastProgressAt`/`lastHeartbeatAt` so health reporting is truthful.
- Resume hint points at the working `agy --continue` (agy exposes no print-mode
  conversation id to capture).

## [0.1.0] — 2026-05-22

Initial release. Replaces and supersedes
[`gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc)
ahead of the June 18, 2026 Gemini CLI deprecation.

### Added

- Delegation runtime targeting **Google Antigravity CLI (`agy`)** via `agy --print`,
  `agy --continue`, and `agy --conversation <id>`. No ACP — agy 1.0.1 does not
  expose `--acp`.
- Multi-host packaging from a single source tree:
  - Claude Code (`.claude-plugin/plugin.json` + `marketplace.json`).
  - Codex CLI (`.codex-plugin/plugin.json`).
  - agy itself (`plugin.json` at root — importable via `agy plugin import claude`
    or installable via `agy plugin install antigravity@sakibsadmanshajib`).
  - Standalone CLI (`npx antigravity-plugin`).
- `/antigravity:setup` interactive auth wizard; background workers also surface
  the OAuth URL via `/antigravity:status` for re-auth flows.
- `/antigravity:review`, `/antigravity:rescue`, `/antigravity:status`,
  `/antigravity:result`, `/antigravity:cancel`, `/antigravity:task` commands
  (ported from `gemini-plugin-cc` v1.0.1).

### Removed

- All ACP client / broker code (`acp-client`, `acp-broker`, `acp-diagnostics`).
  agy does not speak ACP.
- Live token streaming and thought-chunk surfacing — `agy --print` returns a
  single final response.
- `gemini --experimental-acp` runtime path — deprecation deadline is too close
  to maintain a transitional fallback.

[Unreleased]: https://github.com/audichuang/antigravity-plugin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/audichuang/antigravity-plugin/releases/tag/v0.2.0
[0.1.0]: https://github.com/sakibsadmanshajib/antigravity-plugin/releases/tag/v0.1.0
