# imagine — changelog

## 0.2.0

**A second engine: `--engine agy`.** The same command now renders through Google Antigravity's
CLI as well as xAI — `node scripts/imagine.mjs --engine agy --prompt-file p.txt --aspect 16:9`.

- **No API key at all on that path.** agy's built-in `generate_image` tool renders on the user's
  own Google login: verified 2026-09-05 with `GEMINI_API_KEY` and `GOOGLE_API_KEY` cleared from
  the environment and none stored under `~/.gemini/`. A machine with no grok login and no
  `XAI_API_KEY` can now generate an image, which is what this engine is for.
- **Image generation in agy is built in, not MCP.** `agy models` lists no image model and
  `agy mcp list` is irrelevant to it; the third-party nano-banana MCP servers are a different,
  optional path this plugin does not use. Evidence and the re-run recipe:
  `docs/imagine-agy-image-audit.md`.
- **The contract did not move: the file on disk is still the receipt.** The script asks agy for a
  JPEG at an absolute path and then `statSync`s that path itself. `status: SUCCESS` with no file
  is a failure, and the error quotes what agy said plus the artifact directory its tool drops
  renders into. That is the guard that lets this plugin drive an agent without repeating the
  `/grok:image` failure it was built to escape — deleting the `statSync` turns four tests red.
- **The prompt still never reaches a shell.** It rides in an argv array (`spawn`, no shell), so
  quotes, a stray heredoc delimiter and `$(…)` are all inert. `--prompt-file` remains the only
  transport into the script.
- **`--dangerously-skip-permissions`, with `cwd` set to the output directory.** A headless run
  cannot answer a permission prompt. The cwd is there so a relative path of agy's lands where we
  expect; it is **not** a sandbox, and the docs say so rather than implying the flag is fenced.
- **`--model`, `--resolution` and `--quality` are refused (exit 2) with `--engine agy`** rather
  than silently dropped — agy's tool takes a prompt and an aspect ratio and nothing else, and a
  dropped `--model` is a render nobody asked for, paid for all the same. `--aspect` is passed
  into the tool's own `AspectRatio`.
- **The extension still matches the bytes**, now by sniffing the file's own header.
- `AGY_BIN` overrides the binary; otherwise it comes off PATH. The prompt skill says which of its
  measured claims carry over to agy (the recipe) and which do not (every number in it).

## 0.1.0
First release. `/imagine:image` generates one image with xAI Grok Imagine and reports the path of
the file that actually landed on disk.

- **Direct API call, not a delegated job.** `POST https://api.x.ai/v1/images/generations`, one
  HTTP round trip. No job lifecycle, no event stream, no shared runtime — the failure signal is an
  HTTP status, not prose that has to be parsed out of a log.
- **Reuses the grok CLI's OAuth login, read-only.** The access token in `~/.grok/auth.json` carries
  an `api:access` scope, so a SuperGrok login already authorises this surface — verified live on
  2026-08-23 with no `XAI_API_KEY` present. The plugin **never writes that file and never touches
  `refresh_token`**: auth.x.ai may rotate refresh tokens on use, and refreshing out-of-band could
  log the user out of grok itself. Expired token ⇒ fail with "run `grok` once". `XAI_API_KEY` is
  the fallback for machines with no grok login.
- **A `url`-only response is downloaded immediately.** xAI's `imgen.x.ai` assets are ephemeral and
  404 within minutes, so the bytes are materialised before the tool returns.
- **The prompt gets first-class treatment.** `skills/imagine-prompts/` carries the recipe, worked
  examples, and anti-patterns; `commands/image.md` sends you there before spending quota, because
  there are no free re-rolls.
- **`/imagine:image` transports the prompt in a file (`--prompt-file <path|->`).** Shell
  arguments strip the double quotes on-image text needs, and a here-document is worse: a prompt
  whose own text contains the delimiter line closes it, and the rest runs as shell. A positional
  prompt still works for a caller who has one safely in hand; the command doc, the prompt skill and
  its examples all use the file. `--out` is optional — without it the script mkdtemps its own
  directory, so no caller has to compute a path in one shell call and splice it into the next. The
  prompt is transported verbatim, `-` (stdin) included: given `--prompt-file`, nothing falls back to
  stdin or to positional words, and an empty file — or an empty `--prompt-file` value — is a usage
  error rather than a silent substitution.
- **Two guards against paying for a request nobody wrote.** A destination that already exists is
  refused *before* the POST (only the extension-corrected collision can still cost money, and its
  message says so), and a flag is never accepted as another flag's value — `--out --aspect 16:9`
  used to render `"16:9"` as the prompt. A response body echoed back in an error has any
  credential-length token redacted out of it.

Supersedes `/grok:image` (removed in `grok@0.8.0`). Contract and evidence:
`docs/imagine-xai-image-api-audit.md`.
