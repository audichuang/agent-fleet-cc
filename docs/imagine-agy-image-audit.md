# imagine plugin ↔ agy `generate_image` — Contract & Sync Audit

What `plugins/imagine`'s `--engine agy` path depends on, pinned to evidence, plus the recipe to
re-run every check. Update **this** file when you learn something about the surface — not the
plugin's `AGENTS.md` (root `AGENTS.md`: engine knowledge lives in the audit doc).

The engine here is the **Antigravity CLI binary** (`agy`), not an HTTP API. It is a closed
binary, so most of what follows is *live behavioural* evidence: what the process did on this
machine on the date stated. Nothing here is documented by Google.

> The same binary is audited from a different angle in `docs/antigravity-cli-contract-audit.md`
> (the `antigravity` plugin's job lifecycle). That file owns launch/wait/cancel; this one owns
> image generation. Neither should restate the other.

## Baseline

| Item | Value |
|------|-------|
| Verified against | `agy 1.1.27` on Linux, logged in, 2026-09-05 |
| Account under test | Google login through `agy`; **no `GEMINI_API_KEY`, no `XAI_API_KEY`** |
| Invocation | `agy -p <wrapped prompt> --output-format json --print-timeout 4m --dangerously-skip-permissions` |
| Reported model | none — the tool does not disclose it (see Part 2) |
| Evidence class | **Live behavioural** for the render, the credential-free path and the drop location; **self-reported** for the tool's parameter list; **absent** for the underlying image model |

## Part 1 — Image generation is built in, and is not MCP

`generate_image` is one of `agy`'s own built-in tools. A 1.1.13 changelog entry fixes how it
renders in the tool group, so it predates that release rather than arriving in it —
`agy changelog | grep -in generate_image` is the check, and the CLI's own `--help` / changelog
stay the authority on what else it ships.

What it is **not**, checked on the same machine:

- **Not MCP.** `agy mcp list` showed only the user's own unrelated servers; removing them would
  not remove image generation. The third-party nano-banana MCP servers and skills that circulate
  online (`xbill9/nb2lite-skill-agy`, `gemini-cli-extensions/nanobanana`) are a *different*,
  optional path that needs `GEMINI_API_KEY` — this plugin uses none of them.
- **Not a model choice.** `agy models` lists text models only; no image model appears, and
  `--model` cannot select one.
- **Not the Antigravity IDE feature.** Most public writing about "Antigravity generates images"
  describes the VS Code-fork IDE integrating Nano Banana Pro. Same brand, different product. The
  CLI capability documented here was verified independently.

## Part 2 — The tool's parameters (self-reported)

Asked to describe its own tool definition without rendering, `agy` reported:

| Parameter | Type | Default |
|-----------|------|---------|
| `Prompt` | STRING | required |
| `ImageName` | STRING | required |
| `AspectRatio` | STRING | `'1:1'` |
| `ImagePaths` | ARRAY of STRING | optional |
| `toolAction`, `toolSummary` | STRING | required (UI plumbing) |

**Evidence class: self-reported.** A model describing its own tool schema is weaker evidence
than a wire capture, and there is no wire to capture here. `Prompt` and `AspectRatio` are
corroborated behaviourally (below); `ImagePaths` is **not** — its purpose is untested, and the
plugin does not use it.

The underlying image model is **not disclosed** by the tool definition, and
`~/.gemini/antigravity-cli/log/` carries no `imagen` / `nano-banana` / `*-image` string. So the
plugin reports `agy/generate_image` as the model rather than inventing a name.

## Part 3 — What the renders proved (2026-09-05)

Two live runs, both through `agy -p … --output-format json --dangerously-skip-permissions`:

| # | Asked for | Landed | Bytes |
|---|-----------|--------|-------|
| 1 | "a red circle on a white background", saved to "the current working directory" | `$HOME/red_circle.jpg`, JPEG **1024×1024** | 458,122 |
| 2 | "a blue cat", 16:9, saved to an **absolute** path, with `GEMINI_API_KEY`/`GOOGLE_API_KEY` cleared from the environment | exactly that path, PNG **1376×768** | 1,388,143 |

Three contract facts follow, and each one shaped the code:

1. **No API key is involved.** Run 2 rendered with both key variables unset, and `~/.gemini/`
   holds no stored key (`grep -ril 'api_key\|apiKey\|GEMINI_API_KEY'` finds nothing) — only
   `oauth_creds.json` and `google_accounts.json`. The credential is the agy login itself.
2. **"Current working directory" is not honoured; an absolute path is.** Run 1 was given a cwd
   and filed the image under `$HOME`. This is why `generateWithAgy` always names an absolute
   path in the wrapper prompt.
3. **The tool drops the file in the conversation's artifact directory first.**
   `~/.gemini/antigravity-cli/brain/<conversation_id>/<ImageName>_<epoch_ms>.jpg` — verified for
   both runs (`red_circle_1788587080363.jpg`, 458,122 bytes, byte-identical in size to the copy
   under `$HOME`; `blue_cat_1788587139684.jpg`, 692,095 bytes, which the agent then *converted*
   to the 1,388,143-byte PNG it was asked for). Both drops were `.jpg` (n=2).

   **This path is a hint, never a code path.** It is undocumented, has moved once already
   (`~/.gemini/`, not `~/.antigravity/`, which is the IDE's directory), and reading it would
   couple the plugin to a private layout. It appears only in the error message for a render that
   produced no file, where it is the one useful clue.

## Part 4 — What the plugin therefore does

| Decision | Because |
|----------|---------|
| Judges the run by `statSync(out)`, never by `status: SUCCESS` | It is an agent. The whole reason `/grok:image` was retired (see the plugin's `AGENTS.md`) was a failure that looked like success. |
| Passes the prompt in an argv array (`spawn`, no shell) | The prompt is user/model-authored text. No word splitting, no quote stripping, no here-document to close. |
| Sends `--dangerously-skip-permissions`, with `cwd` set to the output directory | A headless run cannot answer a permission prompt. **`cwd` is not a fence** — an agent with permissions skipped reaches anywhere by absolute path; cwd only decides where a *relative* path of agy's lands. |
| Sniffs `FF D8 FF` / `89 50 4E 47` and corrects the extension | Same promise the xAI path keeps: the extension matches the bytes. agy is asked for JPEG and is not bound to comply. |
| Refuses `--model` / `--resolution` / `--quality` (exit 2) | The tool has no such parameters. Silently dropping `--model` would bill a render nobody asked for. |
| `--print-timeout 4m`, own backstop 270s | Renders take ~30s; the long tail is agy narrating. Asking it to "reply with only that path" is what keeps a run from timing out on its own report (measured: a run asked for a written explanation hit the 5-minute default *after* writing the file). |

## Re-run recipe

Free (no render):

```bash
agy --version
agy changelog | grep -in 'generate_image'          # still a built-in tool?
agy models | grep -i image                         # still no image model to choose?
agy mcp list                                       # image generation must NOT depend on a server here
grep -ril 'api_key\|apiKey\|GEMINI_API_KEY' ~/.gemini/ ; echo "exit $?"   # 1 = still key-free
```

Costs one render (only when you suspect the drop behaviour or the JSON shape changed):

```bash
cd "$(mktemp -d)"
printf 'a plain red circle on a white background' > p.txt
node <path-to-plugin>/scripts/imagine.mjs --engine agy --prompt-file p.txt --out "$PWD/probe.jpg"
file probe.jpg
ls ~/.gemini/antigravity-cli/brain/*/ -t | head    # the tool's own drop, newest first
```

The script exits non-zero and quotes agy back if the file is not there, so a green exit plus a
`file` line naming real image data is the whole check.

## Still unverified

- What `ImagePaths` does (reference images for editing? composition inputs?) — untested.
- Whether `AspectRatio` accepts anything outside the common ratios, and what it does with an
  invalid one. The plugin does not validate, matching the xAI path's stance.
- Whether the render is billed per image, per turn, or against a daily allowance on a Google
  account, and what happens when that runs out.
- Whether `agy --sandbox` (it is in `--help`) would actually fence a run that also carries
  `--dangerously-skip-permissions`, and at what cost to the render. Untested — the same probe is
  open in `docs/antigravity-cli-contract-audit.md`. Until it is answered, the plugin's position is
  that the agy path runs unfenced and says so.
- Windows behaviour. Everything above is Linux, one machine.
