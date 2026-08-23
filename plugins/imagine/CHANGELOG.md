# imagine — changelog

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
  file is transported verbatim: given `--prompt-file`, nothing falls back to stdin or to positional
  words, and an empty file is a usage error rather than a silent substitution.
- **Two guards against paying for a request nobody wrote.** A destination that already exists is
  refused *before* the POST (only the extension-corrected collision can still cost money, and its
  message says so), and a flag is never accepted as another flag's value — `--out --aspect 16:9`
  used to render `"16:9"` as the prompt. A response body echoed back in an error has any
  credential-length token redacted out of it.

Supersedes `/grok:image` (removed in `grok@0.8.0`). Contract and evidence:
`docs/imagine-xai-image-api-audit.md`.
