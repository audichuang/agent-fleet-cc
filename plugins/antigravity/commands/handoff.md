---
description: Write a handoff document summarising this session and (by default) hand it to Antigravity (agy) to continue the work, returning agy's response. Use --print to only write the doc.
argument-hint: '[focus for the next session — omit to hand off the work just done] [--print] [--background] [--model <id>]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(mktemp:*), Bash(cat:*)
---

Run the one-key **reflect → write handoff → hand to agy → bring back** loop. By
**default**, compose a handoff document, hand it to Antigravity (`agy`) as a
fresh agent told to continue the work, and return agy's response. With
`--print` (or `--prompt-only`), only write the handoff document and show it —
do NOT run agy.

Raw slash-command arguments:
`$ARGUMENTS`

## Step 1 — compose the handoff document

Strip the execution flags (`--print`, `--prompt-only`, `--background`,
`--model <id>`) from `$ARGUMENTS` first; the remainder (if any) is the **focus
for the next session**.

Write a handoff document so a *fresh agent with no memory of this conversation*
can continue the work. Follow these rules:

- **Reconstruct the state.** Use the working tree and history to ground the doc:
  - `git --no-pager status --short`
  - `git --no-pager diff --stat` and `git --no-pager diff` (unstaged)
  - `git --no-pager diff --stat --cached` (staged)
  - `git --no-pager log --oneline -10`
  Combine that with the intent, decisions, and trade-offs from this conversation.
- **Structure** (use these sections): `Goal` / `Current state` / `What's done` /
  `What's left` / `Key decisions & rationale` / `Gotchas & constraints` /
  `How to verify` / `Suggested skills`.
- **Suggested skills.** Include a section recommending the skills the next agent
  should invoke (by name), with one line each on why.
- **Don't duplicate** content already captured in other artifacts (PRDs, plans,
  ADRs, issues, commits, diffs). **Reference them by absolute path or URL** and
  point the next agent to read them itself — never paste large code/diff blobs.
- **Redact** any sensitive information (API keys, tokens, passwords, PII).
- **Tailor to the focus.** If the user passed a focus argument, treat it as the
  description of what the next session will work on and shape the doc toward it
  (most-relevant context first, an explicit "Start here" pointer).
- Prose in the user's language; section headers and shell/paths in English.

## Step 2 — write it to the OS temp directory (NOT the workspace)

```bash
TMPFILE=$(mktemp "${TMPDIR:-/tmp}/antigravity-handoff.XXXXXX.md")
cat <<'HANDOFF_EOF' > "$TMPFILE"
[the composed handoff document]
HANDOFF_EOF
echo "$TMPFILE"
```

## Step 3 — hand it to agy (default) or just print it

### If `--print` / `--prompt-only`: write only (do not run agy)
- Show the handoff document inside a single fenced ` ```markdown ` block and
  print its `$TMPFILE` path on its own line so the user can reuse it.
- End with one short line: "要直接交給 agy 續做就再跑一次 `/antigravity:handoff`（不加 `--print`）。"

### Otherwise (default): hand the document to agy and return its response

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/rescue.mjs" --prompt-file "$TMPFILE" [--model <id>] [--background]
```
- `rescue` reads the whole handoff document as the prompt (`--prompt-file`), so
  agy receives the full context as a fresh agent and continues the work.
- Foreground (default): return agy's output **verbatim** — do not paraphrase,
  summarize, or act on it yourself. Then note the `$TMPFILE` path. The user
  decides what to do next.
- `--background`: append `--background`; tell the user to track it with
  `/antigravity:status` and fetch the result with `/antigravity:result`.

Auth note:
- If output mentions an OAuth URL or "not authenticated", run `/antigravity:setup`,
  then retry.

## Operating rules

- Default is to **write the handoff AND run agy**, returning agy's response —
  the reflect → hand off → bring it back loop. Only `--print`/`--prompt-only`
  skips the agy run.
- Always save the handoff to the **OS temp directory**, never the workspace.
- Do not act on agy's response yourself; just return it.
