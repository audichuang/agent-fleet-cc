---
description: generate an image with Grok Imagine and return the verified saved path
argument-hint: "<description> [--out <path>] [--aspect auto|1:1|16:9|9:16|3:2|2:3]"
---

Generate ONE image with Grok's `image_gen` tool (Grok Imagine) and report the path of
the file that actually landed on disk. There is no `image` verb on the companion — this
is the existing `task` verb driven by a canned prompt, so **nothing here passes
`$ARGUMENTS` through**: parse `--out` / `--aspect` yourself and fold them into the
prompt text below.

## 1. Reserve the output path

Default (no `--out`) — reserve a fresh directory and put the image inside it:

```bash
d=$(mktemp -d ./grok-image-XXXXXX) && echo "$PWD/${d#./}/image.jpg"
```

The printed absolute path is `<OUT>`. `mkdir` is atomic, so that directory is
**exclusively this run's**: no concurrent `/grok:image` can pick the same name, nothing
else is in it, and `<OUT>` cannot already exist. That — not a scan for a free
`grok-image-N.jpg` — is what makes step 4's gate proof that *this* run produced the file,
with no mtime or inode bookkeeping to get wrong. Two of these in flight at once cannot
overwrite each other.

With an explicit `--out <path>`: if it already exists, stop and ask before spending
quota, never overwrite — but the guarantee is genuinely weaker there. The check and
grok's `cp` are seconds apart, so another process, or a symlink planted at that path, can
still win the race, and step 4 cannot tell that apart from a healthy run. The default
path has no such window; `--out` trades it for a name the user chose.

**Grok's own shell does the copy** — that is why the prompt below ends with a `cp` — but
only because grok already holds the absolute path mid-turn, so it is one step instead of a
parse-the-log round trip. It is **not** a permissions matter: grok writes the original
into its own session folder under `~/.grok` at `0700`/`0600`, owned by the same user
running this session, so you can read and copy it yourself (verified 2026-08-23), which is
exactly what step 5's recovery branch does. The copy is a **convenience, not a
sandbox-independent guarantee** — whether it lands depends on the profile the run got, see
step 3.

**There is no `--cwd` flag on the companion** (it exits 1 with `Unknown flag: --cwd`) —
the run's cwd is simply the cwd of the Bash call, and the adapter forwards that to grok.
So a relative `--out` lands wherever the Bash call already runs, which is also why the
snippet above resolves `<OUT>` to an absolute path before it goes into the prompt. A
destination **outside** that cwd is not forbidden: with the default profile (`off`) no
sandbox is applied at all, so `/tmp/result.jpg` works fine. What decides it is whether the
destination is writable under the run's profile — step 3's business.

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

- **Never `--read-only`.** It leaves only `~/.grok` and the temp dirs writable, so
  generation *succeeds* (the session folder is under `~/.grok`) and it is the `cp` into the
  cwd that the profile blocks — when the sandbox actually applies; it can also refuse to
  start, or silently not enforce, so do not read this as a guarantee in either direction
  (mechanisms and anchors: the contract audit's Part 3). The worst case is the one to
  design against: half-done, and the run still looks fine.
  A `/tmp` destination would in fact survive even here, which is the point: the copy is
  not sandbox-independent, it just needs a writable destination. A managed or custom
  profile can take the cwd out of the writable set the same way; the other built-ins
  (`workspace`, `devbox`, `strict`) all keep it writable.
- **Never `--research`.** Its tool allowlist is authoritative, and it drops `image_gen`
  outright.

## 4. Verify the FILE, never grok's prose

The pass/fail gate is **a regular, non-empty file at `<OUT>`**: `test -f "<OUT>" && test
-s "<OUT>"`. Step 1 supplies the freshness half — on the default path `<OUT>` sits in a
directory this run created empty and exclusively, so a non-empty regular file there was
written by this run. Every clause is load-bearing — `test -s` on its own is happy with a
non-empty **directory** (so `--out .` "passes" while the `cp` landed somewhere else or
failed outright), and with an explicit `--out` just as happy with a leftover file from an
earlier run when this run generated nothing at all. Grok's `IMAGE_SAVED:` line is
a convenience for reading the log, not evidence — same as any other model text:
untrusted, and no substitute for looking at the disk.

`od -An -N3 -tx1 "<OUT>"` printing `ff d8 ff` confirms a JPEG, but treat a mismatch as
a **warning only, not a failure**. Nothing upstream validates the format: the writer
always names the file `.jpg` and saves whatever bytes the API returned, so `.jpg` is a
naming convention rather than a format guarantee. A healthy non-JPEG payload must not
be reported as a failed generation.

## 5. Failure triage from the raw stream

Take the job id from `--json` and read the raw stream:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" logs <job>`.

Check these **in this order** — the first bullet is positive proof a generation happened,
so it settles the question before any triage that concludes it didn't.

- **A `tool_call_update` line carrying a typed `rawOutput`** whose `"type"` is
  `"ImageGen"` → grok generated the image but skipped the copy. `path` is a *top-level*
  key of that object (`{path, filename, session_folder, uploaded_url?}`) — copy it to
  `<OUT>` yourself and re-verify per step 4. Getting the wire shape right matters: a
  `tool_call_update` line has **no** `toolName` field at all (its fields are exactly
  `toolCallId`, `status`, `content`, `rawOutput`, `locations`), so a grep for
  `"toolName":"image_gen"` on one **never** matches. Match on `rawOutput`'s type, or
  correlate `toolCallId` back to the earlier `tool_call` line, which is the variant that
  does carry `toolName`.
- **`SuperGrok` inside the completed `image_gen` tool RESULT** → the user's tier (free /
  X Basic) is server-side zero-limited on Imagine. `image_gen` short-circuits and hands
  back the upsell prose as a **successful** tool result, so the job itself can look
  perfectly healthy. Locate it, do not grep for it: take the `toolCallId` off the
  `tool_call` line carrying `"toolName":"image_gen"`, find the `tool_call_update` line
  with that same `toolCallId`, and look for the substring `SuperGrok` in **its** `content`
  / `rawOutput` — nowhere else in the log. A whole-stream grep reads the user's own words
  back: the prompt text and the `tool_call`'s `rawInput` both echo into the stream, so
  `/grok:image "a SuperGrok mascot"` would triage a healthy generation whose `cp` failed
  as a tier block. Match the substring `SuperGrok` only — never the full marketing
  sentence, which upstream can reword. Say the tier can't generate images, point at the
  upgrade, and **do not retry**.
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
