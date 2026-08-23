---
description: generate an image with Grok Imagine and return the verified saved path
argument-hint: "<description> [--out <path>] [--aspect auto|1:1|16:9|9:16|3:2|2:3]"
---

Generate ONE image with Grok's `image_gen` tool (Grok Imagine) and report the path of
the file that actually landed on disk. There is no `image` verb on the companion — this
is the existing `task` verb driven by a canned prompt, so **nothing here passes
`$ARGUMENTS` through**: parse `--out` / `--aspect` yourself and fold them into the
prompt text below.

## 1. Resolve the output path

`--out <path>` if given, else `./grok-image-1.jpg`. It **must sit inside the cwd you
hand grok**. Grok writes the original into its own session folder under `~/.grok`
(`<session_folder>/images/<n>.jpg`) and that directory is created `0700` — you cannot
reach in and copy it out afterwards. **Grok's own shell has to do the copy**, which is
why the prompt below ends with a `cp`.

**There is no `--cwd` flag on the companion** (it exits 1 with `Unknown flag: --cwd`) —
the run's cwd is simply the cwd of the Bash call, and the adapter forwards that to grok.
So either let `--out` be relative to where the Bash call already runs, or make it
absolute and confirm it is under that cwd. Resolve this before composing the prompt; a
`cp` to a path outside grok's cwd is the one failure that still leaves the run looking
successful.

## 2. Run it in the FOREGROUND with a long timeout

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task --no-subagents --json "<the prompt below>"`,
  description: "grok image_gen",
  timeout: 600000
})
```

The explicit `timeout: 600000` is not optional. `image_gen` alone is allowed 300s
in-engine and the image proxy can go over a minute without sending a byte, so the
default 120s would kill a perfectly healthy run and report it as a hang. Copy the
`node "…/scripts/grok-companion.mjs"` path **verbatim** — it is already expanded for
you; retyping the `<version>` segment from memory dies with "Cannot find module".

`--no-subagents` because one image needs no fan-out — and it sidesteps the
subagent text-leak problem entirely, so no `<<<GROK_FINAL>>>` sentinel is needed.
`--json` gives you the job id, which step 5 needs.

The prompt to pass, with the placeholders filled in:

> Use the `image_gen` tool exactly once, with this description: `<the user's
> description>`, and `aspect_ratio` `<the requested aspect, or auto>`. The tool returns
> the absolute path of the file it saved. Then run `cp "<that absolute path>" "<OUT>"`
> — copy it, do not move or delete the original. End your final message with exactly
> one line: `IMAGE_SAVED: <OUT>`. Do not describe the image, and do not read it back.

## 3. Flags to never pass

- **Never `--read-only`.** Grok's session folder under `~/.grok` stays writable even
  under the sandbox, so generation *succeeds* and only the `cp` into the repo fails —
  the worst failure mode there is: half-done, and the run still looks fine.
- **Never `--research`.** Its tool allowlist is authoritative, and it drops `image_gen`
  outright.

## 4. Verify the FILE, never grok's prose

The pass/fail gate is **the file exists and is non-empty** (`test -s "<OUT>"`). Grok's
`IMAGE_SAVED:` line is a convenience for reading the log, not evidence — same as any
other model text: untrusted, and no substitute for looking at the disk.

`od -An -N3 -tx1 "<OUT>"` printing `ff d8 ff` confirms a JPEG, but treat a mismatch as
a **warning only, not a failure**. Nothing upstream validates the format: the writer
always names the file `.jpg` and saves whatever bytes the API returned, so `.jpg` is a
naming convention rather than a format guarantee. A healthy non-JPEG payload must not
be reported as a failed generation.

## 5. Failure triage from the raw stream

Take the job id from `--json` and read the raw stream:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" logs <job>`.

- **Contains `SuperGrok`** → the user's tier (free / X Basic) is server-side
  zero-limited on Imagine. `image_gen` short-circuits and hands back the upsell prose as
  a **successful** tool result, so the job itself can look perfectly healthy. Match the
  substring `SuperGrok` only — never the full marketing sentence, which upstream can
  reword. Say the tier can't generate images, point at the upgrade, and **do not retry**.
- **A `tool_call_update` line carrying a typed `rawOutput`** whose `"type"` is
  `"ImageGen"` → grok generated the image but skipped the copy. `path` is a *top-level*
  key of that object (`{path, filename, session_folder, uploaded_url?}`) — copy it to
  `<OUT>` yourself and re-verify per step 4. Getting the wire shape right matters: a
  `tool_call_update` line has **no** `toolName` field at all (its fields are exactly
  `toolCallId`, `status`, `content`, `rawOutput`, `locations`), so a grep for
  `"toolName":"image_gen"` on one **never** matches. Match on `rawOutput`'s type, or
  correlate `toolCallId` back to the earlier `tool_call` line, which is the variant that
  does carry `toolName`.
- **No `image_gen` `tool_call` at all** → the tool is not registered in this
  environment. Cheapest confirmation: the `available_commands` line at the top of the raw
  stream lists every tool the session got, `image_gen` included when it is on. The
  disablers are `GROK_IMAGE_GEN`, `[features] image_gen` in grok's config, and the remote
  `imagine_tool_disabled` kill switch. Report it; do not retry blindly.

Verified against real `grok 1.0.5` on 2026-08-23 (one live generation, 35s, exit 0):
`image_gen` appears in `available_commands` on the headless path; the tool events do reach
the raw job log; the `tool_call_update` line's keys are exactly `content`, `locations`,
`rawOutput`, `status`, `toolCallId`, `type` — **no `toolName`**, confirming the grep trap
above; and `rawOutput` came back as `{"type":"ImageGen","path":…,"filename":"1.jpg",
"session_folder":"images"}` — note `session_folder` is the bare directory *name*, not a
path, and `uploaded_url` is simply absent for local output. The tier-restricted branch was
**not** exercised (the account under test has SuperGrok), so that one bullet is still
source-read only.

## 6. Cost

Every image spends the user's SuperGrok quota and hits the network. One call is one
image (`n:1`, `1k` resolution) — no batching and no free re-rolls, so ask before
generating a second. Report the verified path verbatim.

The aspect list in the argument-hint mirrors the tool's own schema description, but the
field is a free-form string passed straight to the API, not a validated enum — a typo
fails server-side mid-run, not locally.
