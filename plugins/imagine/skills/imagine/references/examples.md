# Worked examples

Eight jobs a CLI image plugin actually gets asked for. Each one is two pieces: the prompt text,
which you save to a file, and the flags to run it with.

**Copying a whole example and swapping the subject beats assembling from the recipe table.** The
`why` under each one is the part worth reading — it says which clause is doing the work.

Two things to know before you copy one:

- **The prompt goes in a file, via `--prompt-file`.** Several of these contain double quotes
  around on-image text, which a shell argument strips silently — and a here-document would let a
  prompt containing its own delimiter line escape into the shell. Each example below is a prompt
  block first — save that to a file — then the command to run it with.
- **Most of these name `--model grok-imagine-image-2.0`, which is not the plugin default and
  costs about 3x per image.** That is a deliberate choice for finish, not a requirement — drop
  the flag to render on the default, and read `model-and-params.md` first: 2.0 has the best
  texture but was measured *ignoring the lighting slot* 4/4 times, where the cheaper default
  obeyed it.
- **`--resolution 2k` returns a PNG**, and the script renames the file accordingly.

## Contents

- [Product shot on seamless](#product-shot-on-seamless)
- [Environmental portrait](#environmental-portrait)
- [Poster with real typography](#poster-with-real-typography)
- [Landing page hero mockup](#landing-page-hero-mockup)
- [Landscape / environment](#landscape--environment)
- [Character / mascot asset](#character--mascot-asset)
- [Food, overhead](#food-overhead)
- [Technical diagram / flat illustration](#technical-diagram--flat-illustration)

---

Where an example is adapted from the source corpus, the adaptation is described in its `why` (the
corpus is a *video* prompt collection, so every adaptation had to strip motion). Where it says
*authored*, the corpus had no prompt for that job at all.

## Product shot on seamless

`prompt.txt`:

```text
Photorealistic product photograph of a matte ceramic pour-over coffee dripper in warm sand beige, centered on a seamless off-white sweep, three-quarter view at eye level, soft large-softbox key from camera left with a single soft shadow falling to the right, gentle gradient falloff in the background, fine unglazed clay texture on the body and a polished chrome collar, muted warm neutrals with one deep terracotta accent, generous negative space around the object, clean commercial catalogue finish, high detail, no other text
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 1:1 --model grok-imagine-image-2.0
```

Runs the recipe straight through with zero motion: medium → subject → setting → framing → light (with direction and the shadow it casts) → palette → material → finish. Authored rather than adapted — the corpus contains no product-photography prompt. 1:1 is xAI's own stated use case for 'Social media, thumbnails', and a square frame keeps the object centred rather than recomposed around it. 'no other text' is the scoped negation that stops the model inventing packaging labels. Note what is absent: no quality-booster stack, and no resolution word — resolution=1k to iterate, 2k for the keeper.

## Environmental portrait

`prompt.txt`:

```text
Photorealistic environmental portrait of a woman in her fifties, silver-grey hair tied back, wearing a worn indigo canvas apron over a grey linen shirt, standing at a workbench in a timber-framed pottery studio, three-quarter portrait framing at eye level, shallow depth of field with the shelving behind falling soft, soft north-facing window light from camera left and a dim warm bulb behind her, visible skin texture and clay dust on her forearms, muted earth palette of raw clay, oxidised copper and pale grey, calm and focused mood, natural documentary photography finish, high detail
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 3:4 --model grok-imagine-image-2.0
```

Authored, not adapted. Subject is pinned as a pose ('standing at a workbench'), never an action — the corpus's talking-head cluster is exactly what this avoids. It deliberately supplies the vocabulary the corpus is thinnest on: depth-of-field appears in only 2/103 prompts and focal lengths in zero, so optics here come from photographic practice, not from the corpus. 'visible skin texture' is the concrete positive phrasing of the anti-plastic goal — better than negating 'not stylized', which is contested folklore. 3:4 = xAI's 'portraits' row.

## Poster with real typography

`prompt.txt`:

```text
Screen-printed gig poster design for a jazz night, headline "BLUE HOURS" across the top third in a wide condensed serif, the line "FRI 14 NOV · HARBOUR HALL · 9PM" in small caps directly beneath, a single silhouetted double bass player centred below the type, two-colour ink in deep navy and warm brass on uncoated cream paper stock, visible halftone grain and slight ink misregistration, flat graphic composition with generous margins, no other text
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 2:3 --model grok-imagine-image-2.0
```

Authored; no corpus prompt renders a quoted literal string, so this is built entirely on Runware's text-rendering guide. Every literal word is quoted, given a typographic role, and given a position — the three things that separate rendered copy from invented copy. Both strings are short (a few words each), which is the documented reliability threshold. Pair with resolution="2k": fine or crowded glyphs degrade at 1k. 2:3 is a standard print poster ratio and is on both of xAI's aspect lists. The print-process detail (halftone grain, misregistration) is the finish clause doing the work a 'vintage' adjective could not.

## Landing page hero mockup

`prompt.txt`:

```text
Landing page hero section design for a fictional deep-sea mapping startup, deep charcoal to near-black background, oversized immersive photographic imagery of a submersible above a trench, rich atmospheric depth, cool cyan and steel blue with soft amber accents, soft volumetric haze, pronounced cinematic contrast, subtle translucent glass UI panels, headline "MAP THE DARK" set top-left in a wide grotesque with a single short subhead line beneath, asymmetric composition, generous negative space, ultra-premium futuristic aesthetic, ultra high detail, no other text
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 16:9 --model grok-imagine-image-2.0
```

The corpus's purest attribute-stack dialect and its most image-native prompt — it contains no motion clause at all, which is why it survives almost intact. Two deliberate changes: the real brand is replaced with a fictional subject (shipped example prose should not lean on a trademark, and output is content-moderated), and the source's vague 'elegant refined typography' is upgraded to a quoted headline with a position, so the type renders as copy instead of as greeked texture. Its near-identical sibling in the corpus (the SpaceX variant) ends 'cinematic depth ready for smooth video motion' — that clause is the one thing that must be deleted when porting this template.

## Landscape / environment

`prompt.txt`:

```text
Wide cinematic shot of a lone astronaut standing on a high rocky outcrop at the edge of an unexplored world, looking out across a vast and silent alien terrain, a second sun sitting low on the horizon, a pale planet visible as a small distant sphere in the dark sky, their lander resting far below in the middle ground, soft natural light raking across the ridges, dust haze layering the distance, quiet hopeful atmosphere, photorealistic, filmic
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 16:9 --model grok-imagine-image-2.0
```

A worked demonstration of the image/video split, with three edits worth copying as a method. (1) The camera move — 'slow and steady camera retreat that gradually reveals the scale and emptiness of the new landscape' — is DELETED, not reworded into 'sweeping'; rewording a dolly into an adjective is exactly the laundering to avoid. (2) The in-prompt '16:9' is removed and moved to the aspect_ratio parameter, which owns it. (3) 'as a second sun begins to rise' is a durational verb, so it becomes 'sitting low on the horizon' — the same information as a visible state. What survives untouched is the explicit foreground/middle-ground/background layering, which is why this prompt was worth adapting at all. Earth is genericized to 'a pale planet' only so the frame is not tied to one specific readable fact; keep it if you want Earth.

## Character / mascot asset

`prompt.txt`:

```text
A majestic crow sculpted entirely from polished black onyx gemstone, wings spread wide in a heroic pose, intricate silver filigree and ornate patterns etched across its body, feathers, and wings, sharp emphasized edges catching a hard rim light, standing on a plain dark slate plinth against a flat charcoal backdrop, cool silver-and-black palette with a single violet reflection in the stone, museum product-render finish, ultra detailed
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 1:1 --model grok-imagine-image-2.0
```

The corpus's 'creature sculpted from a material' formula — the most image-native pattern it contains: an animal specified by substance and surface finish rather than by species alone. Adaptation notes: the source line is TRUNCATED IN THE README ITSELF (the trailing 'crystall...' is in the file, inserted by the generator), so the tail is reconstructed, not quoted. 'powerfully spreading its wings wide in a heroic pose' becomes 'wings spread wide in a heroic pose' — a state, not an act. A plain plinth and flat backdrop are added because a mascot has to cut out cleanly; 1:1 for an avatar or app icon.

## Food, overhead

`prompt.txt`:

```text
Photorealistic overhead flat-lay food photograph of a bowl of ramen on a dark walnut table, a halved soft-boiled egg with a glossy yolk, charred corn, spring onion, and a sheet of nori leaning against the rim, hard window light from the top of the frame with a white bounce filling the shadows, faint steam catching the backlight, deep browns and amber broth against matte black ceramic, wet sheen on the noodles and beads of chilli oil on the surface, tight crop with the bowl slightly off-centre, appetising editorial food photography finish, high detail, no other text
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 4:3 --model grok-imagine-image-2.0
```

Authored. Food is a material-and-light problem, so this prompt spends almost everything on surface (glossy, wet sheen, beads, charred) and on a named light setup with a bounce. 'faint steam catching the backlight' is the one place worth being careful: steam is a visible medium in a still and is fine, whereas 'steam rising and curling' would be smuggling motion in — the test is whether the phrase names an appearance or a change. Overhead flat-lay is the framing token that costs one clause and completely determines the shot. 4:3 suits recipe cards and menus.

## Technical diagram / flat illustration

`prompt.txt`:

```text
Flat vector technical illustration of a three-stage water filtration cartridge, cutaway side view, centred on a pale grey grid background, each stage in a distinct flat colour — sediment layer in warm sand, carbon layer in charcoal, membrane in teal — thin dark outlines throughout, three short leader lines pointing to the layers and labelled "SEDIMENT", "CARBON", "MEMBRANE" in small uppercase sans, generous margins, clean instructional-manual aesthetic, no gradients and no drop shadows, no other text
```

then:

```bash
node …/imagine.mjs --prompt-file /abs/path/prompt.txt --aspect 3:2 --model grok-imagine-image-2.0
```

Authored. Diagrams are the hardest image case because they are typography plus geometry, so this leans on both text rules at once: quoted labels with a stated role and position, and short strings. Run it at resolution="2k" — small glyphs are exactly what 1k loses. It also carries the only kind of negation with published support: two concrete, scoped exclusions ('no gradients and no drop shadows', 'no other text') rather than a broad style manifesto. Expect to iterate; no source claims any model gets label placement right first try.
