---
description: Generate an image with Google Antigravity (agy / Imagen) and return the saved path
argument-hint: '[--name <id>] [--output <path>] [--add-dir <path>] [--json] <description>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/image.mjs" $ARGUMENTS`

Flags:
- `--name <id>` ask agy to save the image under this name.
- `--output <path>` copy the generated file to this path.
- `--add-dir <path>` extra workspace directory (repeatable).
- `--json` emit structured JSON (`imagePath`, `source`, `copiedTo`, `warning`, `rawOutput`).

Notes:
- Runs in the foreground (image generation is a one-shot); no background job is created.
- The saved path is reported on the `Generated:` line; with `--output` the file is also copied there.

Auth note:
- If output mentions an OAuth URL or "not authenticated", run `/antigravity:setup` to complete the OAuth flow, then retry.

Output rules:
- Present the command output verbatim — do not paraphrase. Surface the `Generated:` path so the user knows where the image was saved.
