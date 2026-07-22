# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] — 2026-07-22

### Changed
- **Model guidance refreshed for agy 1.1.5 / Gemini 3.6 Flash** (docs only, no code change —
  the adapter forwards `--model` verbatim and hardcodes no model). Verified on real agy 1.1.5:
  `agy models` now prints slugs (`gemini-3.6-flash-medium`) instead of display names, though
  display names still work; the no-`--model` default remains a Gemini 3.5 Flash tier; 3.6 Flash
  is fast and clean in headless `--print` (~4s, clean SVG/markup, actually switches — unlike
  3.1 Pro) including through the plugin's background job path. `SKILL.md` now says so.

## [0.5.0] — 2026-07-14

### Added
- **Opt-in write mode for `/antigravity:rescue` and `/antigravity:task`.** `--apply` binds
  the job cwd as an agy project (`--new-project`) and auto-applies edits (`--mode accept-edits`)
  so agy 1.1's `--print` actually edits files in the repo instead of only printing a plan or
  writing to `~/.gemini` scratch. Off by default — the plain text-out contract is unchanged.
  `--dangerously-skip-permissions` (auto-approve every tool, not just edits) is a further opt-in
  and only takes effect together with `--apply`.
  Verified end-to-end against real agy 1.1.2: `--apply` writes into the job cwd; the default
  (no `--apply`) writes to agy's `~/.gemini` scratch instead — the pathology this fixes.

### Changed
- **Corrected `review` / `adversarial-review` read-only claims.** The code claimed `--sandbox`
  prevents a misbehaving model from mutating the tree. Verified false on agy 1.1.2: in headless
  `--print` mode neither `--sandbox` (terminal/nsjail containment only; the model can
  `BypassSandbox`) nor the fine-grained permission `deny`/`ask` lists are enforced against file
  writes — even a global `deny: write_file(*)` still wrote. The read-only guarantee rests solely
  on the prompt. Comments in `review.mjs` / `adversarial-review.mjs` / `prompt-templates.mjs`
  and the plugin `AGENTS.md` now say so; no behavior change.

### Fixed
- **Version drift across the plugin's manifests.** `plugin.json` (the `--version` source),
  `package.json`, `.codex-plugin/plugin.json`, and `.agents/plugins/marketplace.json` had lagged
  behind the marketplace-authoritative version since the 0.3.0/0.4.0 bumps only touched the
  Claude-side pair. All six version locations are now in lockstep at 0.5.0.

## [0.4.0] — 2026-07-14

### Added
- **Passive liveness observability** for antigravity jobs on the fleet status/doctor board
  (shipped as part of the fleet-wide liveness work). Released without a CHANGELOG entry at the
  time; recorded here retroactively.

## [0.3.1] — 2026-07-02

### Documentation
- **Model guidance** in `SKILL.md`. Documents the `--model` option (accepted by every
  verb but previously undocumented) and recommends omitting it to use agy's default
  Gemini 3.5 Flash tier — fast and reliable in `--print` mode, including SVG / markup
  generation. Warns against `Gemini 3.1 Pro (High)`, which stalls in headless print mode
  (never returns off the backend wait, doesn't actually switch models) and can wedge the
  session so later calls appear to hang too.

## [0.3.0] — 2026-07-02

Migrated the job runtime onto the shared `shared/lib/` foundation (directory-per-job
state-store + O_EXCL terminal CAS + TTL claim-orphan reconcile + orphan-lock sweep),
replacing the bespoke flat-`state.json` runtime. Same shape as `cc` (a ~120-line
`ProcessAdapter` for agy + the shared `runWorker`). This is a **hardening upgrade** —
the race protections now match `cc`/`codex`.

### Behavior changes
- **On-disk job layout** is now directory-per-job (`jobs/<id>/…` + append-only
  `events.ndjson`). Jobs started under ≤0.2.0 are **not visible** to 0.3.0 commands —
  let them finish or cancel before upgrading. The old `state.json` job index is inert;
  its `config` block (`stopReviewGate`) is migrated once into `config.json`.
- **OAuth**: an unauthenticated background job now fails fast with `errorKind:"auth"` and
  a hint to run `/antigravity:setup` and retry (the background pause-and-surface flow is
  gone). The interactive `/antigravity:setup` OAuth path is unchanged.
- Foreground commands no longer stream stdout live (agy `--print` is one-shot).
- Health/heartbeat/watchdog fields removed from `status`/`result`/`wait` output; liveness
  is now shared reconcile-per-poll + TTL claim-orphan detection.
- Added a recursion guard (`ANTIGRAVITY_ACTIVE`) that refuses agy-in-agy invocation.

### Hardening (via the shared store)
- Cross-process terminal CAS with a TTL, claim-owner (not worker-pid) dead-PID reconcile,
  orphan-lock sweep, and no-resurrect-on-prune — none of which the 0.2.0 runtime had.

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
