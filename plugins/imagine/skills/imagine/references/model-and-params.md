# Model, aspect and resolution

Everything here was read off xAI's docs and pricing on **2026-08-23**. Model names and prices
rot; the live catalog is the authority and the GET is free:

```bash
TOK=$(jq -r 'to_entries[] | select(.key|startswith("https://auth.x.ai::")) | .value.key' ~/.grok/auth.json)
curl -s -H "Authorization: Bearer $TOK" https://api.x.ai/v1/image-generation-models | jq
```

grok-imagine-image-2.0 (NOT the plugin default — see the measured section below). Cost in its default configuration is $0.06/image (1k, quality=medium); $0.04 is the headline "at a glance" figure but it is the 1K·Low cell of the pricing grid (1K low $0.04 / 2K low $0.06 / 1K medium $0.06 / 2K medium $0.08) and is only reachable by explicitly sending quality="low". A 2k keeper at the default quality costs $0.08. It is the only image model xAI features in its own generation docs and the only one that accepts the optional `quality` parameter (low|medium, default medium) — which is why the desk research below originally proposed it as the default. The 36-render measurement in the next section overruled that; move to it for a stated reason, not by default. Its widely-quoted style range ("from ultra-realistic photography to anime, oil paintings, and pencil sketches") is real but appears in the Style-transfer section of the IMAGE EDITING page (docs.x.ai/developers/model-capabilities/images/editing), an endpoint this reference otherwise rules out of scope — cite it that way or lean on the in-scope justification instead. Caveat for a client library: `quality` is documented in guide prose and corroborated by the pricing grid but is ABSENT from the REST request schema — send it only when the user asks and let a 400 surface rather than assuming it is accepted.

grok-imagine-image (THE PLUGIN DEFAULT) at $0.02, flat at BOTH 1K and 2K — the only one of the three with no resolution premium, and therefore 3x cheaper than 2.0's real default, not 2x. This is the sweep model: fire n up to 10 with one variable changed and pick a direction, then re-render the keeper on 2.0. Two constraints: it is region-limited to us-east-1 (the other two list us-east-1 + us-west-2), and it has no quality axis.

grok-imagine-image-quality ($0.05 at 1K, $0.07 at 2K): this is the renamed grok-imagine-image-pro, which was retired on 2026-05-15 and now redirects here — so any third-party guide praising "-pro" is describing this model. Be honest in shipped copy: xAI publishes NO qualitative comparison between the three. No benchmark, no capability matrix, no "use X when Y". "Quality" is a product name, not a measured claim. Reach for it only after you have A/B'd it yourself on your own subject; by default the extra spend buys more at resolution=2k on 2.0 than it does here.

BATCH API — TWO xAI PAGES CONFLICT, DO NOT BUILD ON THE MODEL CARD ALONE: the model cards say grok-imagine-image-2.0 is "Supported" and grok-imagine-image-quality is "Not supported", while the Batch API page says the opposite for 2.0 — "Image and video requests currently support `grok-imagine-image` and `grok-imagine-video`; other Imagine models (including `grok-imagine-image-2.0` and `grok-imagine-video-1.5`) are rejected with \"not supported for batch processing\"". Route batch work to grok-imagine-image, the one model both pages agree on, and treat batch on 2.0 as verify-at-call-time — a batch path built on 2.0 may take a runtime rejection.

RESOLUTION: only "1k" and "2k" exist. Use 2k whenever the image carries text, fine ornament, or crowded detail; iterate a layout at 1k and re-render the keeper at 2k. On pixel meaning, be precise about what is actually documented: the only dimensions xAI publishes (1K = 1024x1024, 2K = 2048x2048) are on the grok-imagine-image and grok-imagine-image-quality model cards. The grok-imagine-image-2.0 card publishes no dimensions at all, and no xAI page states what 1k/2k mean at non-square ratios.

ASPECT_RATIO: request the frame you will actually ship rather than generating 1:1 and cropping — the model recomposes for the ratio, it does not crop into it, so the same prompt at 16:9, 1:1 and 9:16 gives three different compositions. Two xAI pages disagree on the enum: the REST reference lists 21:9 and 5:2, the guide table does not. Validate client-side against the intersection — 1:1, 3:4, 4:3, 9:16, 16:9, 2:3, 3:2, 2:1, 1:2, the 9:19.5 / 19.5:9 / 9:20 / 20:9 phone pairs, and `auto` (in both sources; the guide table's row reads "Model auto-selects the best ratio for the prompt") — and surface a clear error rather than silently substituting; treat 21:9 and 5:2 as verify-at-call-time. Never reject `auto`, even though a plugin shipping a fixed frame should essentially never send it. Re-check any typography after changing ratio — a 9:16 recomposition re-stacks what sat side by side in 16:9.

LATENCY AND THROUGHPUT ARE NOT A DIFFERENTIATOR: rate limits are identical across all three models (T0 6 rps rising to T4 100 rps, no TPM cap). The only real axes are price, batch eligibility, and the 2.0-only quality parameter — route on cost and on whether the image carries text, not on an imagined speed tier.

TWO FACTS A PLUGIN AUTHOR MUST KNOW BEFORE WRITING ANY PROMPT-TUNING FEATURE. First, a prompt-rewriting ("upsampler") LLM sits between your string and the renderer: xAI documents it only inside the usage token-accounting fields ("Prompt text tokens consumed by the prompt-rewriting (upsampler) LLM", "Rewritten-prompt text tokens generated by the prompt-rewriting (upsampler) LLM"). The string you send is not necessarily the string that renders, there is no documented way to disable it, and no revised_prompt comes back — so front-load what matters, keep every clause load-bearing, and do not build features that depend on single-token tuning. Second, there is no `seed` and no `negative_prompt` parameter, so output is not reproducible as documented; get variation from n (up to 10, stated in overview prose but not in the REST schema) rather than expecting a re-run to match. Prompt length has no documented cap and pricing is flat "regardless of prompt length" — length is free, but detail past a point competes with itself.

FINALLY, THE SOURCE-TIER RULE FOR ANYTHING ADDED LATER: xAI publishes no image prompting guide at all (the only prompting guide on docs.x.ai is for voice), so rank evidence xAI docs (fact) > Runware's image-backed model guides (strong) > xAI launch post and Morphic (vendor claim) > SEO blogs (folklore), and ship anything below the second tier as "try it", not "do this". Most findable "Grok Imagine practice" describes the grok.com app — which has region edits, multi-image input and its own prompt enhancer — not this API. And note the corpus's own standing: every prompt in it was written for the VIDEO model or the app, never for this endpoint, so the recipe's slot structure is a transferable observation, not a tested result.

## Measured against the live API, 2026-08-23 (36 renders)

Everything in this section was settled empirically. It overrides any conflicting prose above.

**The three models are three aesthetics with three different clause-compliance profiles** —
not a price ladder. On one identical 11-slot prompt:

| model | what it did |
|-------|-------------|
| `grok-imagine-image` (plugin default) | Followed the prop list and the **lighting direction** most literally — the specified long shadow appeared. Flatter texture, softer hands, ignored the framing slot (subject dead-centre). |
| `grok-imagine-image-2.0` | Best texture and hands, and a real detail jump at 2k. **Dropped the lighting direction 4/4 times.** |
| `grok-imagine-image-quality` | Strongest style-anchor compliance (reads as genuine 1975 reportage). **Inverted the light**, and invented two legible signs despite `no other text`. |

Route on which slots must be obeyed, not on price alone.

**Output format and dimensions.** `2k` returns `image/png` (~7 MB); `1k` returns `image/jpeg`
(~400 KB). The script reads `data[0].mime_type` and renames the file to match.

| aspect | 1k | 2k |
|--------|----|----|
| 1:1 | 1024×1024 | 2048×2048 |
| 3:2 | 1248×832 | 2496×1664 |
| 16:9 | 1280×720 | — |
| 9:16 | 720×1280 | — |

Identical across models. Note "1k" means 1024 only on the square ratio, and the area is not
constant (16:9 at 1k is 0.92 Mpx vs 1.05 for square).

**Parameters, all confirmed accepted:** `quality: "low"` → HTTP 200, billed at exactly the
$0.04 grid cell. `n: 2` → two images, billed 2×. `aspect_ratio: "21:9"` → 200. `response_format:
"b64_json"` → the bytes come back inline. **Without `response_format`, `b64_json` is never
returned** — you get only the ephemeral `imgen.x.ai` URL, so the plugin always sends it.
`resolution: "4k"` → 422. A bogus ratio → 422 enumerating every legal variant, which is the
cheapest authority there is:

    unknown variant `7:11`, expected one of `1:1`, `3:4`, `4:3`, `9:16`, `16:9`, `2:3`, `3:2`,
    `9:19.5`, `19.5:9`, `9:20`, `20:9`, `1:2`, `2:1`, `21:9`, `5:2`, `auto`

**`auto` works and genuinely adapts** — a "tall lighthouse from sea level" prompt returned 9:16
unprompted; the fisherman prompt returned 3:2.

**Prompt cap is 8000 characters** (`max_prompt_length`, all three models, from the free catalog
GET) — which contradicts "no documented cap" above.

**The upsampler's cited evidence is not observable here.** This endpoint's `usage` object is
`{"cost_in_usd_ticks": N}` and nothing else — no prompt-token or rewritten-prompt fields, on a
50-char prompt or a 1005-char one. The upsampler doctrine may still be right; its published
evidence is from elsewhere in xAI's docs.


## Not verified against this renderer

Nobody has tested these. Treat each as a question, not a setting — and when you settle one,
move it into the prose above and record it in `docs/imagine-xai-image-api-audit.md`.

- Whether grok-imagine-image-2.0 works in the Batch API. The model card says Supported, the Batch API page says 2.0 is rejected with "not supported for batch processing". One batch submission settles it; until then route batch to grok-imagine-image.
- Everything about the upsampler (its token fields are absent from this endpoint, see above): whether it can be suppressed, whether it rewrites short prompts more aggressively than long ones, and whether front-loading survives it. Nothing is documented beyond the two token-accounting field names, and no revised_prompt is returned, so the only probe is a paired A/B on prompts that differ only in clause order.
- Whether in-prompt exclusions suppress anything on the models other than `-quality`. Settled for `-quality`: they do NOT (2/2 renders carrying `no other text` produced invented signage, one of them *more* than the control). No 2.0 counterfactual was run — no 2.0 render in the test produced text at all.
- How many words a single quoted string can hold before glyphs degrade. The 2k-for-text rule is settled and was WRONG: 1k rendered the same strings exactly and equally legibly (2/2). One render held four exact strings plus six invented ones at 9:16, so the ceiling is above four — but it was never probed.
- Whether the measured model profiles above hold beyond one prompt. They come from a single 11-slot subject rendered on all three (n=1 per model, plus 4 repeats on 2.0 for the lighting result). The direction is clear; the generality is not. xAI still publishes no comparison of its own.
- Whether the README's 2573-prompt full collection (only 103 are reproduced in the file) shifts any of the slot frequencies. Every N/103 here is a ~4% sample.
