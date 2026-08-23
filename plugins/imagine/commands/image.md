---
description: generate an image with xAI Grok Imagine and return the verified saved path
argument-hint: "<description> [--out <path>] [--aspect <ratio|auto>] [--resolution 1k|2k] [--model <id>] [--quality low|medium]"
---

Generate ONE image with Grok Imagine and report the path of the file that actually landed
on disk. This POSTs xAI's `/v1/images/generations` directly — no job, no event stream, no
log triage. Parse `$ARGUMENTS` yourself and pass the pieces through as flags.

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

## 3. Read the result

On success the script prints one line and exits 0:

```
IMAGE_SAVED: /abs/path/image.png (6872209 bytes, grok-imagine-image-2.0) — extension corrected to match image/png
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
- **exit 2** → a usage error (unknown flag, missing value, no prompt). Nothing was billed.

## 4. Cost

One call is one image, billed to the user's SuperGrok subscription (verified 2026-08-23:
generation succeeds with the OAuth bearer alone, no `XAI_API_KEY` present). Models differ in
price by up to 3×; `skills/imagine-prompts/references/model-and-params.md` has the grid. No
batching and no free re-rolls — ask before generating a second.
