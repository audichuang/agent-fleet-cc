---
name: imagine
description: Generates a still image with xAI Grok Imagine (default) or Google Antigravity (agy) and returns the path of the file that actually landed on disk. Use whenever the user wants a picture MADE rather than found or edited — a poster, hero image, banner, thumbnail, album or book cover, product shot, portrait, mascot, avatar, icon, key visual, illustration, technical diagram, UI mockup, or plainly "a photo of X" — including a one-line idea they expect expanded, even if they never say "prompt". Also use to diagnose a render that came back generic, mushy, badly lit, or carrying invented text.
metadata:
  version: "0.4.0"
---

# Imagine

One call renders one image and spends quota. There are no free re-rolls and no `seed`: a re-run
does not reproduce the last image. The prompt is the whole job.

## 1. Write the prompt before you spend the quota

Unless the user handed you a fully-formed prompt to send verbatim, build it up with
[references/prompt-craft.md](references/prompt-craft.md). **Show the user the expanded prompt**
in your reply, so they can see what was sent and edit it for the next run.

## 2. Run it, with the prompt in a file

`Write` the prompt to a file in your scratchpad, then run the script:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/imagine.mjs" --prompt-file /abs/path/prompt.txt --aspect 16:9
```

`${CLAUDE_SKILL_DIR}` is this skill's directory, the one holding this `SKILL.md`; where your
harness does not fill it in, use that absolute path.

Give the Bash call a 240 s timeout (300 s with `--engine agy`).

- **Nothing from the prompt goes on the command line** — no heredoc, no shell argument. A shell
  argument silently strips the double quotes that on-image text needs, and a prompt containing
  a heredoc's delimiter line runs the rest of itself as shell. A file has no such escape.
- **Omit `--out`** unless the user named a path; the script picks its own directory and prints
  where the image landed.
- **`--engine grok`** (default) is billed to the user's SuperGrok login or `XAI_API_KEY`.
  **`--engine agy`** renders on their Google account with no API key. Pick grok unless the user
  asks for agy, has no xAI credential, or wants to spend Google quota instead.
- Defaults: `--aspect 1:1`, `--resolution 1k`. Do not validate the aspect yourself: a bad value
  returns 422 listing every accepted ratio.

## 3. Read the result

Success is one line and exit 0:

```
IMAGE_SAVED: /abs/path/image.png (6872209 bytes, grok-imagine-image) — extension corrected to match image/png
```

**Report the path the script printed, not the one you asked for**: the extension follows the
bytes. A failure exits non-zero with a one-line reason that carries the fix; relay it rather
than re-diagnosing. Exit 2 is a usage error, and nothing was billed.

## 4. Cost

One call is one image, on either engine. **Ask before generating a second.**

## References

| File | Read when |
|---|---|
| [references/prompt-craft.md](references/prompt-craft.md) | Writing or fixing a prompt: the recipe, anti-patterns, what changes on agy. |
| [references/examples.md](references/examples.md) | You want a worked example for a common job (poster, product shot, diagram, …). |
| [references/model-and-params.md](references/model-and-params.md) | Choosing a model, resolution or quality, or comparing their price. |
| [references/running.md](references/running.md) | Using the agy engine, or reading a specific failure (401, 403, "already exists", a timeout, agy wrote no file). |
