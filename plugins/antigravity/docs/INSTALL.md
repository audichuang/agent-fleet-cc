# Installation

`antigravity-plugin` runs the same source tree under four hosts. Pick the one
that matches your workflow.

## Prerequisites (all hosts)

1. **Node.js ≥ 18.18.0** — `node --version`.
2. **agy CLI v1.0.1+** — Google Antigravity CLI on `PATH`.
   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   agy --version
   ```
3. **Google account** for `agy` OAuth. Either run `agy --print 'hi'` once and
   complete the browser flow, or use the plugin's `/antigravity:setup` wizard
   after install.

## Claude Code

```bash
claude plugin marketplace add audichuang/antigravity-plugin
claude plugin install antigravity@antigravity
# inside Claude Code:
/antigravity:setup
```

## Codex CLI

Codex auto-discovers `antigravity-plugin` via three files at the plugin install
root: `.codex-plugin/plugin.json` (canonical manifest), `SKILL.md` (skill
discovery), and `agents/openai.yaml` (the `$antigravity` implicit-invocation
contract). Per the [OpenAI Codex plugin docs](https://developers.openai.com/codex/plugins/build),
plugins are registered through a marketplace descriptor at either
`$REPO_ROOT/.agents/plugins/marketplace.json` (repo-scoped) or
`~/.agents/plugins/marketplace.json` (personal).

### Option A — `codex plugin marketplace add` (recommended)

```bash
git clone https://github.com/audichuang/antigravity-plugin.git ~/code/antigravity-plugin
codex plugin marketplace add ~/code/antigravity-plugin
# the local marketplace is the repo's .agents/plugins/marketplace.json
codex plugin marketplace list                    # confirm it shows up
# restart Codex, then inside Codex CLI:
$antigravity setup
$antigravity review --base main
```

### Option B — personal marketplace

If you prefer to keep one curated personal marketplace, copy the entry from
this repo's `.agents/plugins/marketplace.json` into `~/.agents/plugins/marketplace.json`
under the `plugins[]` array, pointing `source.path` at your local clone:

```json
{
  "name": "personal",
  "interface": { "displayName": "Personal plugins" },
  "plugins": [
    {
      "name": "antigravity",
      "source": { "source": "local", "path": "~/code/antigravity-plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity",
      "interface": { "displayName": "Antigravity (agy)" }
    }
  ]
}
```

Restart Codex; the plugin is available under `$antigravity`. Verbs:
`setup`, `review`, `rescue`, `task`, `status`, `result`, `cancel`.

## agy itself

```bash
# either install from the marketplace
agy plugin install antigravity@antigravity

# or, if you already have it as a Claude Code plugin, import it
agy plugin import claude
```

## Standalone (any shell)

```bash
npx antigravity-plugin review
npx antigravity-plugin rescue 'investigate why the tests started failing'
npx antigravity-plugin status
```

## Verifying

```bash
# host-agnostic check
agy --version              # 1.0.1+
node --version             # 18.18.0+
which agy                  # /home/<user>/.local/bin/agy on Linux
```

## Troubleshooting

### `agy` not found on WSL after a Windows install

The Windows Antigravity Desktop ships a symlink at `~/.local/bin/agy` that
points to the Windows binary and fails on WSL. Remove the symlink and run the
Linux installer instead:

```bash
rm -f ~/.local/bin/agy
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

### `agy --print` blocks on first run

That's the OAuth flow. Open the URL printed on stdout in your browser, paste
the resulting code back in the terminal, and the prompt continues. Subsequent
calls reuse the cached token. The plugin's `/antigravity:setup` (or
`$antigravity setup` / `npx antigravity-plugin setup`) wraps this for you.

### `agy plugin install` syntax

`agy plugin install <name>@<marketplace>` — same as Claude Code. Use the
marketplace short name (`sakibsadmanshajib`) once the marketplace has been
registered, or `agy plugin import claude` to pull from your local Claude Code
install.
