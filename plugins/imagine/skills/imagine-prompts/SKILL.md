---
name: imagine-prompts
description: Craft the prompt for a Grok Imagine still-image render, and choose the model, aspect and resolution to pair with it. Use this skill BEFORE any call to /imagine:image or scripts/imagine.mjs — each render costs quota and there are no free re-rolls, so the prompt is the whole job. Reach for it whenever the user wants a picture MADE rather than found or edited — a poster, hero image, banner, thumbnail, album or book cover, product shot, portrait, mascot, avatar, icon, key visual, illustration, technical diagram, UI mockup, or plainly "a photo of X" — including when they hand over a one-line idea and expect it expanded, and even if they never say the word "prompt". Also use to diagnose a render that came back generic, mushy, badly lit, or carrying invented text nobody asked for.
---

# Writing prompts for Grok Imagine

There are no free re-rolls and no `seed` — every call spends quota and a re-run will not
reproduce the last image. The prompt is the whole job.

**Pass the prompt on stdin, via a quoted heredoc.** Good prompts contain double quotes; a shell
argument silently strips them.

```bash
node …/imagine.mjs --out /abs/path/image.jpg --aspect 3:2 <<'PROMPT'
<the prompt, verbatim>
PROMPT
```

## What the recipe is actually for

Measured on a controlled A/B (`a photo of an old fisherman mending a net at dawn`, one-liner vs
full expansion, same flags): **the recipe converts "pretty" into "specified"** — the props,
wardrobe, palette, and framing you named all appeared, and the stock-photo cliché the one-liner
reproduced three times out of three did not.

It does **not** reliably convert into "better lit". In that test the one-liner's default dawn
light beat the expansion's specified light. Read that as the honest ceiling: **name what you
need to control; leave what you do not care about to the model, which has strong defaults.**

## The recipe

Write the clauses in this order. Skip a slot deliberately — whatever you leave out, the model
picks for you.

| # | Slot | What it does |
|---|------|--------------|
| 1 | **Medium + shot** | Sets the render mode before the model reaches the subject. A still noun: *photograph, painting, illustration, design, shot*. Never "video". |
| 2 | **Subject, pinned** | Concrete appearance and wardrobe, held in a **frozen pose**. |
| 3 | **Setting** | Where it sits. Omit and you get a backdrop of the model's choosing. |
| 4 | **Static framing** | Shot size, camera height, angle, foreground/middle/background layering. The **only** place camera vocabulary is legal. |
| 5 | **Lighting** | Source, quality, direction — and the shadow it casts. **The slot most often ignored; see below.** |
| 6 | **Palette** | Base value → grade → one or two **named accents**. |
| 7 | **Material & finish** | Substance and surface treatment. Reshapes a render more than any adjective pile. |
| 8 | **On-image text** | Only when the image carries type. Quote the literal string, name its role and position. See below. |
| 9 | **Mood** | Two or three words, near the end. |
| 10 | **Style anchor** | The closing clause. One named anchor beats a stack of adjectives. |
| 11 | **One scoped exclusion** | Optional, and weaker than it looks — see below. |

Worked examples for eight common jobs are in `references/examples.md`. Copying a whole example
and swapping the subject beats assembling from the table.

### When a slot is ignored, change model — not wording

Slot compliance differs **by model**, measured on one identical prompt:

- **Lighting direction** ("raking in from camera right, casting one long shadow to the left") was
  dropped 4 out of 4 times by `grok-imagine-image-2.0`, and rendered correctly by the cheaper
  `grok-imagine-image`.
- `grok-imagine-image-quality` **inverted** the light and invented two legible signs.

So a slot the model overrides is not a prompt bug you can word your way out of. Re-render on a
different model before rewriting. `references/model-and-params.md` has the measured profiles.

### On-image text

- **Name the literal words, give each a role and a position.** This is the load-bearing part:
  naming is what puts *your* copy on the image instead of plausible invented copy. A naive
  "with the band name and date at the bottom" rendered flawless typography — of words nobody
  asked for.
- **Quote them.** Measured: quoting does **not** improve glyph accuracy (identical strings
  rendered exactly with the quotes stripped, 3/3). What quoting does is stop **depictable** copy
  from becoming an object — `headline RED BALLOON` drew a red balloon; `headline "RED BALLOON"`
  did not. Cheap insurance, wrong mechanism to believe in.
- **Keep every string to a few words.** Split long copy into separate short elements.
- Roles are honoured loosely: "in small caps" came back as scaled full caps 3/3.
- Leaving filler copy **unquoted on purpose** is a legitimate technique — you get clean,
  plausible, correctly-formatted invented text (transaction rows, price lists, signage).
- `--resolution 2k` is **not** required for legibility (1k rendered the same strings equally
  clearly, 2/2). Use 2k when you want the detail, and know that **2k comes back as PNG**.

## Anti-patterns

The corpus behind this reference is a **video** prompt collection, so the risk is video
vocabulary laundered into image advice. But note the ceiling, measured: a prompt-rewriting
upsampler sits in front of the renderer and quietly converts much of this into visible state.
These cost you *control and clarity*, not usually the render.

1. **Camera movement** — dolly, pull-back, orbit, tracking, pan, tilt, push-in, zoom. **Delete
   the clause**; do not reword it into "sweeping" or "dynamic". Static framing is the legal
   residue → slot 4.
2. **Temporal sequencing** — "then", "first … then", numbered beats, "Scene 1 / Shot 2". Every
   "then" clause is a second frame the renderer cannot draw.
3. **A chain of action verbs where a pose was wanted.** Convert to one frozen pose.
4. **Morph / transformation** — "turns into", "becomes", arrow chains. Describe the endpoint.
5. **Duration, fps, slow-motion, loops, transitions.** Different endpoint entirely.
6. **Speech, dialogue, accents, music, sound.** No audio track — and a scripted line drags the
   render toward an open-mouthed talking pose.
7. **The word "video"** and its wrappers. Wastes the opening clause.
8. **Prefer a countable frozen instance to a plural continuous process.** "a single wave caught
   mid-break" produced one legible breaking wave; "small waves rolling in and breaking" produced
   a generic foam field. This is the defensible core of the "motion dressed as scenery" rule —
   measured, the motion phrasings themselves were rendered as visible states and cost nothing.
   It is a **specificity** win, not a motion-vs-state win.
9. **Image-editing idioms** — "keep everything else exactly the same", "add X to the scene".
   This *route* accepts no input image, so there is nothing to preserve or add to. (The models
   themselves report `input_modalities: ["text","image"]` — editing is a different endpoint.)
10. **Aspect ratio or resolution written into the prompt** — "16:9", "4k". Measured: they
    **cannot** change the pixel dimensions (a `1:1` call with "16:9 widescreen" in the prompt
    returned 1024×1024). Harmless waste rather than a trap — but use `--aspect` / `--resolution`,
    which own the decision.
11. **Broad style negation** — "not anime / not 3D". There is no `negative_prompt`, so it lands
    in the positive prompt. State the positive target instead: "natural documentary photography
    finish, visible skin texture" beats "not stylized".
12. **Quality-booster stacks** — "masterpiece, 12k quality, ultra detailed". Unearned; a concrete
    finish clause does real work in the same characters. Keep at most one detail qualifier.
13. **Brand names and real people** — outsources form to a brand prior instead of describing
    shape and material, and output is content-moderated. Describe the object.
14. **Junk tokens** — emoji tails, typos, symbolic notation. The upsampler reads your string
    before the renderer does; ambiguous junk is what gets expanded.

### `no other text` is not a switch

Slot 11's exclusions are weak, and on `grok-imagine-image-quality` **measurably useless**: a
harbour-stall scene carrying `, no other text` came back with *more* invented signage than the
same scene without it (2/2 renders on that model carried invented strings). Keep the clause —
it costs nothing — but if a render must be text-free, check it, and switch model rather than
escalating the wording.

## Choosing the model, aspect and resolution

- **Aspect**: request the frame you will ship. The model **recomposes** for the ratio rather than
  cropping into it, so the same prompt at 16:9 and 9:16 gives two different compositions.
  `auto` is legal and genuinely adapts (a "tall lighthouse from sea level" prompt returned 9:16
  unprompted). Do not validate ratios client-side — a bad one returns 422 with the full accepted
  enum, which beats any list.
- **Resolution**: `1k` or `2k` only. 2k is a genuine detail jump on 2.0 (net knots, rigging, a
  wooden needle that is mush at 1k) — not just more pixels. It also changes the format to PNG
  and the file to ~7 MB.
- **Model**: they differ in *aesthetic and in which slots they obey*, not just price — up to 3×.
  The measured profiles and the price grid are in `references/model-and-params.md`. Prompt cap is
  8000 characters (from the catalog, all three models).

The live catalog is free and is the authority on what exists:

```bash
TOK=$(jq -r 'to_entries[] | select(.key|startswith("https://auth.x.ai::")) | .value.key' ~/.grok/auth.json)
curl -s -H "Authorization: Bearer $TOK" https://api.x.ai/v1/image-generation-models | jq '.models[].id'
```

## Show your work

**Show the user the expanded prompt** alongside the result. They asked for an image from one
line; they should see what was actually sent, and be able to edit it for the next run.

## Where this came from, and what it is worth

Built from `github.com/YouMind-OpenLab/awesome-grok-imagine-prompts` (the README reproduces
**103** prompts in full; its stats table's 2573 refers to the linked gallery), plus xAI's docs
and provider guides — then **field-tested with 36 real renders on 2026-08-23**, which is where
every "measured" claim above comes from and which overturned three rules this file previously
shipped as imperatives.

**Standing of the advice:** xAI publishes **no image prompting guide at all**. Every corpus
prompt was written for the **video** model or the grok.com app, never for this endpoint. Where a
claim is measured, it says so and gives the n; everything else is a transferable observation.
`references/model-and-params.md` ends with what is still unverified — add to it rather than
quietly promoting a guess.
