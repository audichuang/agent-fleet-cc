# Phase 1 spike — findings (2026-05-22)

Recorded here so future contributors don't redo the homework.

## Tested against
`/home/<user>/.local/bin/agy` v1.0.1 — fresh install via
`curl -fsSL https://antigravity.google/cli/install.sh | bash` (linux_amd64,
182 MB ELF).

## Headline
**agy 1.0.1 has no ACP mode.**

```
$ agy --acp
flags provided but not defined: -acp
```

`--experimental-acp` is rejected too. Several 3rd-party posts and the
[ai-sdk.dev community providers page](https://ai-sdk.dev/providers/community-providers/acp)
claim agy inherits ACP from gemini-cli — that is **wrong as of 1.0.1**.

## What agy actually exposes

Top-level flags:

| Flag                                  | Purpose                                          |
|---------------------------------------|--------------------------------------------------|
| `--print` / `-p` / `--prompt`         | Non-interactive single prompt → stdout           |
| `--prompt-interactive` / `-i`         | Interactive initial prompt then continue session |
| `--continue` / `-c`                   | Resume the most recent conversation              |
| `--conversation <id>`                 | Resume a specific conversation by ID             |
| `--add-dir <path>`                    | Add a workspace dir (repeatable)                 |
| `--dangerously-skip-permissions`      | Auto-approve all tool permission requests        |
| `--sandbox`                           | Sandboxed terminal restrictions                  |
| `--log-file <path>` / `--print-timeout` | Observability hooks                            |

Subcommands:

| Subcommand                 | Notes                                               |
|----------------------------|-----------------------------------------------------|
| `agy plugin list`          | Imported plugins                                    |
| `agy plugin import [gemini\|claude]` | Pulls plugins from gemini-cli or Claude Code  |
| `agy plugin install <plugin@marketplace>` | Same syntax as Claude Code               |
| `agy plugin uninstall` / `enable` / `disable` | Lifecycle                            |
| `agy plugin validate [path]` | Validates plugin layout                           |
| `agy plugin link <marketplace> <target>` | Generate marketplace link                |
| `agy install`              | Configure shell PATH                                |
| `agy update`               | Self-update                                         |
| `agy changelog`            | Release notes                                       |

## agy plugin layout (canonical)

`agy plugin validate <dir>` requires:

- `plugin.json` at the **root** of the plugin dir (not inside `.claude-plugin/`).
- Optional dirs alongside it: `skills/`, `agents/`, `commands/`, `mcpServers/`,
  `hooks/`.

Schema for `plugin.json` is the same as Claude Code's: `name`, `version`,
`description`, `author`, `license`, `homepage`.

To support all three plugin hosts (Claude Code, Codex CLI, agy) from one source
tree, we ship **byte-identical copies** of `plugin.json` at three locations:

```
plugin.json                     # for agy
.claude-plugin/plugin.json      # for Claude Code
.codex-plugin/plugin.json       # for Codex CLI
```

## Auth

`agy --print` blocks on first call with an OAuth URL:

```
Authentication required. Please visit the URL to log in:
  https://accounts.google.com/o/oauth2/auth?...
Waiting for authentication (timeout 30s)...
Or, paste the authorization code here and press Enter:
```

No API-key / headless path in 1.0.1. Tracked upstream as
[`antigravity-cli#78`](https://github.com/google-antigravity/antigravity-cli/issues/78).

Background-delegation workers must:

1. Detect "Authentication required" on stdout.
2. Capture and surface the OAuth URL via `/antigravity:status`.
3. Pause until the user completes the flow; retry on next prompt.

## Architectural impact

The original plan (spawn `agy --acp`, broker JSON-RPC over stdio, replicate the
ACP client + broker from `gemini-plugin-cc`) is **dead**.

**New shape:**

```
Host (Claude Code | Codex CLI | agy | npx)
        │
        ▼
  command (e.g. /antigravity:review)
        │
        ▼
  background worker: spawn `agy --print` (or --continue / --conversation)
        │
        ▼ stdout capture (final response only)
  job state → tail file → render to host on /status / /result
```

Losses vs. `gemini-plugin-cc` v1.0.1:

- No live token streaming.
- No thought chunks.
- No ACP cancel semantics — use SIGTERM on the worker.
- No structured tool-call events.

Gains:

- One binary surface to depend on.
- ~70% less code (entire ACP layer can be deleted).
- Ready for June 18, 2026 cliff with no transitional fallback to drag along.

## Gemini ACP baseline (reference)

`gemini --experimental-acp` v0.38.2 still works (for now). `initialize`
handshake captured cleanly:

- `protocolVersion: 1`
- 4 auth methods: `oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway`
- Agent capabilities: `loadSession`, `promptCapabilities` (image / audio /
  embeddedContext), `mcpCapabilities` (http / sse).

Not used by `antigravity-plugin`. Kept here only as documentation of the
prior-art protocol.
