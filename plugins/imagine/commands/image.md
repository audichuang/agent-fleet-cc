---
description: generate an image with xAI Grok Imagine or Google Antigravity (agy) and return the verified saved path
argument-hint: "<description> [--engine grok|agy] [--out <path>] [--aspect <ratio|auto>] [--resolution 1k|2k] [--model <id>] [--quality low|medium]"
---

Generate ONE image and report the path of the file that actually landed on disk. Parse
`$ARGUMENTS` yourself and pass the pieces through as flags.

Two engines, one contract — **the file on disk is the receipt**, and a failure always exits
non-zero:

| `--engine` | How it renders | Costs | Needs |
|---|---|---|---|
| `grok` (default) | POSTs xAI's `/v1/images/generations` — no job, no event stream, no log triage | the user's SuperGrok subscription | a grok login or `XAI_API_KEY` |
| `agy` | spawns the Antigravity CLI and drives its built-in `generate_image` tool | the user's Google account | `agy` on PATH, logged in — **no API key at all** |

Pick `grok` unless the user asks for agy, has no xAI credential, or wants to spend Google
quota instead. `--model`, `--resolution` and `--quality` belong to the xAI endpoint and are
refused (exit 2) with `--engine agy`, rather than silently dropped.

## 1. Write the prompt before you spend the quota

**Read `skills/imagine-prompts/SKILL.md` first** unless the user handed you a fully-formed
prompt they want sent verbatim. A one-line description generates a one-line-quality image,
there are no free re-rolls, and **a re-run does not reproduce the first image** — there is no
`seed`. Build the prompt up per the recipe there, and **show the user the expanded prompt** in
your reply so they can see what was actually sent and edit it for the next run.

## 2. Run it, with the prompt in a **file**

`Write` the expanded prompt to a file in your scratchpad, then point the script at it:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/imagine.mjs" --prompt-file /abs/path/prompt.txt --aspect 16:9`,
  description: "grok imagine",
  timeout: 240000
})
```

**Nothing from the prompt appears on the command line.** Good prompts contain double quotes —
the skill requires them around on-image text — and a shell argument strips them silently: the
words survive, the quoting does not, and nothing warns you. A heredoc fails worse: a prompt
whose own text happens to contain the delimiter line ends the here-document, and whatever
follows it is executed as shell. A file has no such escape. Never splice prompt text, or a path
derived from it, into a `command` string.

`--prompt-file -` reads stdin instead, for a caller that already has the prompt on a pipe.

**Omit `--out` unless the user named a path.** The script then mkdtemps its own directory and
prints where the image landed — one less path to compute in a shell and paste into the next
call. Pass `--out` only for a path the user actually asked for; the extension there is a
request, not a promise (see step 3).

Copy the `node "…/scripts/imagine.mjs"` path **verbatim** — it is already expanded; retyping
the `<version>` segment from memory dies with "Cannot find module".

Defaults: `--aspect 1:1`, `--resolution 1k`, `--model grok-imagine-image`. `--quality` is
accepted only by some models — send it only if the user asks.

**Do not validate the aspect ratio yourself.** A bad value returns 422 with xAI enumerating
every accepted ratio in the message, which is better than any list this plugin could hold.
`auto` is legal and genuinely adapts the frame to the prompt.

### Rendering through agy instead

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/imagine.mjs" --engine agy --prompt-file /abs/path/prompt.txt --aspect 16:9`,
  description: "agy imagine",
  timeout: 300000
})
```

Same flags, same output line, same `--prompt-file` rule — the script hands the prompt to agy
in an argv array, so nothing about it ever reaches a shell. `--aspect` is passed through to the
tool's own `AspectRatio` parameter.

agy renders into a private staging directory, never onto `--out`. The script then checks the
bytes itself — size, then magic number — and only publishes to the destination if they are a
real image, through a create that cannot overwrite. So an agy that reports success without
rendering fails here with its own words quoted back, and a corrected extension can never land
on top of a file you already had. Give it a longer timeout than the xAI path: it is a whole
agent turn, ~30s in practice.

`AGY_BIN` overrides the binary; otherwise it comes off PATH.

## 3. Read the result

On success the script prints one line and exits 0:

```
IMAGE_SAVED: /abs/path/image.png (6872209 bytes, grok-imagine-image) — extension corrected to match image/png
```

The byte count is from `statSync` **after** the write — disk evidence, not prose. **Report the
path the script printed, not the path you asked for**: `--resolution 2k` comes back as PNG
(measured, deterministic), and the script renames the file to match what the API actually
returned rather than leaving PNG bytes inside a `.jpg`.

Failures exit non-zero with a one-line reason; the messages carry the fix, so relay them
rather than re-diagnosing:

- **credential rejected (401, or a 400 saying "Incorrect API key")** → if the user logs in
  through grok, run `grok` once (any prompt) to let it refresh, then retry. The script
  deliberately **never** refreshes: `~/.grok/auth.json` is grok's file, and auth.x.ai may
  rotate `refresh_token` on use, so refreshing here could log the user out of grok.
- **403** → usually this account's tier is not entitled to Imagine on this surface (xAI does
  not document the cause). Point at `XAI_API_KEY` or the upgrade, and **do not retry**.
- **no credentials** → no `https://auth.x.ai::…` entry in `~/.grok/auth.json` and no
  `XAI_API_KEY`. Log in with `grok`, or export a key.
- **"already exists — refusing to overwrite"** → read the rest of the line. Caught before the
  request ("nothing was generated or billed"), just pick another `--out`. Caught after the
  extension was corrected ("generated and billed"), the bytes are gone unless you re-run with a
  different `--out`.
- **exit 2** → a usage error (unknown flag, missing value, no prompt, an unreadable or empty
  `--prompt-file`, a prompt given twice, an unknown `--engine`, or an xAI-only knob passed with
  `--engine agy`). Nothing was billed.

With `--engine agy` the model column reads `agy/generate_image` and the failures are different:

- **"exited N but wrote no file"** → the run finished without producing the image. The message
  quotes what agy said and names `~/.gemini/antigravity-cli/brain/<conversation-id>/`, where its
  tool parks a render before moving it — a file may be sitting there. Relay it; do not re-run
  blind.
- **"agy is not installed"** → the Antigravity CLI is not on PATH. Install it, set `AGY_BIN`, or
  drop `--engine agy`.
- **"bytes that are not a JPEG or a PNG"** → agy wrote something else at the path (an error
  page, prose). Treated as a failed render rather than reported as an image.
- **a timeout** → the script's own backstop, after agy's `--print-timeout`. It kills the run
  (SIGTERM, then SIGKILL) but **still checks the file first** — agy has been seen to finish the
  render and then hang narrating it, so a timeout can still succeed. Only when there is no file
  does it fail, and it says the render may still have cost quota rather than claiming nothing
  was spent.
- **"already exists — refusing to overwrite"** on the agy path → the image was generated; the
  destination (possibly with a corrected extension) was taken. Re-run with a different `--out`.

The agy path runs with `--dangerously-skip-permissions`, because a headless run has nobody to
answer a permission prompt. The script sets `cwd` to the output directory so a relative path of
agy's lands where we expect — that is **not** a sandbox, and skipped permissions are not fenced
by it. Say so if a user asks what the flag costs them.

## 4. Cost

One call is one image. **No batching and no free re-rolls on either engine — ask before
generating a second.**

- `--engine grok`: billed to the user's SuperGrok subscription (verified 2026-08-23: generation
  succeeds with the OAuth bearer alone, no `XAI_API_KEY` present). Models differ in price by up
  to 3×; `skills/imagine-prompts/references/model-and-params.md` has the grid.
- `--engine agy`: spends the user's Google account quota, and costs an agent turn on top of the
  render (verified 2026-09-05 with no `GEMINI_API_KEY` in the environment and none stored — agy
  renders on its own login).
