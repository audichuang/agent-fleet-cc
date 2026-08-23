# imagine plugin ↔ xAI Image API — Contract & Sync Audit

What `plugins/imagine` depends on, pinned to evidence, plus the recipe to re-run every check.
Update **this** file when you learn something about the surface — not the plugin's `AGENTS.md`
(root `AGENTS.md`: engine knowledge lives in the audit doc).

This plugin talks to **three** surfaces, and only the first belongs to a CLI we control:

1. the grok CLI's credential file, **read-only**
2. xAI's `POST /v1/images/generations`
3. xAI's `GET /v1/image-generation-models` (free — the re-run recipe)

## How to keep this current

Run the recipe at the bottom. It is free: the catalog GET spends no quota and the JWT decode is
local. Only re-run a **generation** when you have reason to believe the response shape changed —
that one costs an image. Never print the bearer token; every command below is written to avoid it.

## Baseline

| Item | Value |
|------|-------|
| Verified against | `grok 1.0.5` login, live `api.x.ai`, 2026-08-23 |
| Account under test | `tier: 5` (SuperGrok), no `XAI_API_KEY` present |
| Endpoint | `https://api.x.ai/v1` (override `XAI_BASE_URL`) |
| Default model | `grok-imagine-image` |
| Evidence class | **Live behavioural** for the happy path and the auth surface; **source-read** (hermes-agent's `plugins/image_gen/xai/__init__.py`) for the response variants we did not hit; **inference** for the 403 branch |

## Part 1 — grok's credential file (read-only, and the only grok-owned thing here)

`~/.grok/auth.json`, override `GROK_AUTH_FILE`. A JSON object keyed `"<issuer>::<client_id>"`.
We select the entry whose key starts **`https://auth.x.ai::`** — *not* the first key, because the
store is shaped to hold more than one issuer.

Fields we read, and **only** these two:

| Field | Use |
|-------|-----|
| `.key` | the OAuth access token (ES256 JWT), sent as `Authorization: Bearer` |
| `.expires_at` | RFC 3339; we refuse to send an expired token |

**We never write this file, and never touch `.refresh_token`.** auth.x.ai may rotate refresh
tokens on use, so an out-of-band refresh here could invalidate the one on disk and silently log
the user out of grok itself. Design-level decision, not an optimisation: expired ⇒ fail with
"run `grok` once to let it refresh".

**Observed 2026-08-23** on a real login: `create_time` 09:31:10Z → `expires_at` 15:31:10Z, i.e.
a **6 h** access-token lifetime; and the JWT's `scope` carries **`api:access`** next to
`grok-cli:access`.

**The recovery path is verified, not assumed** (2026-08-23, same day): with the token four
minutes from expiry, one `grok -p "…"` run rewrote `auth.json` and pushed `expires_at`
15:31:10Z → 21:26:58Z — another 6 h. So "run `grok` once, then retry" is a real fix, and grok
refreshes **lazily** (at use), not on a timer. That is the whole reason this plugin can stay
read-only. That scope is what makes a grok-CLI bearer usable on `api.x.ai` at all — if a
future grok release drops it, this plugin breaks and the recipe's decode step is how you find out.

Fallback when there is no grok login: `XAI_API_KEY`. This plugin ships to other people's
machines; grok is not a prerequisite.

## Part 2 — `POST /v1/images/generations`

Request: `Authorization: Bearer <token>`, `Content-Type: application/json`, body

```json
{"model": "grok-imagine-image", "prompt": "…", "aspect_ratio": "16:9", "resolution": "1k"}
```

`response_format` is **not optional for us**: without it the API returns **only**
`data[0].url` — an ephemeral `imgen.x.ai` asset that 404s within minutes (hermes-agent #26942).
Sending `"b64_json"` returns the bytes inline and removes the second network hop entirely.
Measured 2026-08-23: a default request's `data[0]` is `{mime_type, url}` with no `b64_json` at
all, so a client that merely *prefers* b64 never takes that branch. The `url` branch is kept as
a fallback and downloads immediately.

Response: `data[0]` carries `b64_json` (when requested), `url`, and **`mime_type`** — which the
client must read, because **`resolution: "2k"` returns `image/png`** and `1k` returns
`image/jpeg`. Deterministic, measured on both models. A client that names its output `.jpg` and
never checks writes PNG bytes into a JPEG filename on every 2k render.

`usage` on this endpoint is `{"cost_in_usd_ticks": N}` and nothing else — notably **none of the
upsampler token fields** xAI documents elsewhere, on a 50-char prompt or a 1005-char one.

Measured dimensions (identical across models): 1:1 → 1024×1024 / 2048×2048; 3:2 → 1248×832 /
2496×1664; 16:9 → 1280×720; 9:16 → 720×1280. "1k" means 1024 only on the square ratio.

Also confirmed accepted: `quality: "low"` (200, billed at the $0.04 grid cell), `n: 2` (two
images, billed 2×), `aspect_ratio: "21:9"`, `aspect_ratio: "auto"` (and it genuinely adapts the
frame to the prompt). `max_prompt_length` is 8000 for all three models, per the catalog.

Statuses we map:

| Status | Meaning we report | Retry? |
|--------|-------------------|--------|
| `401` | token expired or rejected → run `grok` once, retry | user retries |
| `403` | this account's tier is not entitled on this surface → upgrade, or `XAI_API_KEY` | **no** |
| other | verbatim, with the first 300 bytes of the body | no |

`aspect_ratio` and `resolution` are passed straight through — a typo fails server-side, not
locally. The plugin validates neither, deliberately, and this is the rare case where the server
is *strictly better* than a client-side check: a bad ratio returns **422 enumerating every legal
variant**, which is a live authority no shipped list can match (root `AGENTS.md`'s
don't-enumerate-the-catalog rule, satisfied for free):

    unknown variant `7:11`, expected one of `1:1`, `3:4`, `4:3`, `9:16`, `16:9`, `2:3`, `3:2`,
    `9:19.5`, `19.5:9`, `9:20`, `20:9`, `1:2`, `2:1`, `21:9`, `5:2`, `auto`

## Part 3 — What is proven, and what is not

**Live-verified 2026-08-23**, with the grok CLI's OAuth bearer and **no `XAI_API_KEY` present**:

- `GET /v1/image-generation-models` → `200`, three models
- one real generation at `16:9` / `1k` → **273,397-byte JPEG**, magic `ff d8 ff`, under 30 s,
  `data[0].b64_json` path taken, exit 0

So on a `tier: 5` account **the OAuth bearer is accepted on this surface and bills the
subscription**. Note this is the opposite of what hermes-agent documents for their OAuth path
(their guide warns of `HTTP 403` tier-gating and tells users to fall back to `XAI_API_KEY`,
issue #26847) — that did **not** reproduce here. Do not delete their warning from your mental
model on one account's evidence; treat 403 as live and possible.

**Carried forward UNPROVEN:**

1. **The 403 branch.** The account under test is entitled, so it never fired. Source-read + the
   hermes guide only.
2. **The `url`-only response path.** Our generation returned `b64_json`; the download branch is
   exercised by a hermetic test, never by the live API.
3. **Billing units.** The catalog reports `image_price: 200000000` for `grok-imagine-image`. We
   deliberately do **not** interpret that field. The evidence for "subscription, not metered" is
   narrower and sufficient: the generation succeeded on an account with no API key configured.

## Part 4 — Re-run recipe (free)

```bash
# 1. token scope + expiry, without printing the token
TOK=$(jq -r 'to_entries[] | select(.key|startswith("https://auth.x.ai::")) | .value.key' ~/.grok/auth.json)
echo "$TOK" | cut -d. -f2 | tr '_-' '/+' | base64 -d | jq '{scope, tier, exp}'
# expect: scope contains "api:access"

# 2. the live catalog — 200, and the model ids the plugin may be asked for
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOK" \
  https://api.x.ai/v1/image-generation-models
curl -s -H "Authorization: Bearer $TOK" \
  https://api.x.ai/v1/image-generation-models | jq '.models[] | {id, input_modalities}'

# 3. hermetic tests (no network, fake auth.json, injected fetch)
node --test tests/imagine/*.test.mjs
```

A generation is **not** part of the routine recipe — it costs an image. Run one only to re-prove
the response shape, and record it in the log below when you do.

## Audit log

| Date | Evidence | Verdict | Notes |
|------|----------|---------|-------|
| 2026-08-23 | live `api.x.ai` + `grok 1.0.5` login; hermes-agent `main` read for the response contract | **wired, working** | First pass — the plugin was created this day. Established: the `https://auth.x.ai::` entry shape and its two fields, the `api:access` scope and 6 h lifetime, the generations request/response contract, the ephemeral-URL hazard, and the free catalog GET. **Live:** catalog `200`; one generation → 273,397-byte JPEG (`ff d8 ff`) with OAuth only. **Not reproduced:** hermes-agent's documented OAuth 403 tier-gating (#26847). **Unproven:** the 403 branch, the `url`-only branch, and any reading of `image_price`. Supersedes the companion-driven `/grok:image` (removed in `grok@0.8.0`); the engine facts for *that* path survive in `docs/grok-cli-contract-audit.md` Part 4, marked superseded. |
| 2026-08-24 | 36 live renders across three models + direct API probes, by two independent field-test agents; a third (Codex) ran the failure paths and mutation-tested the suite | **six real defects found and fixed** | The first pass shipped on one happy-path render. Field-testing it properly found: (1) **the `b64_json` branch was dead code** — the API only returns a URL unless `response_format` is sent, so every call took the ephemeral-URL path the doc warns about; (2) **2k returns PNG** and the client wrote it into a `.jpg`; (3) `writeFileSync` **silently overwrote** an existing `--out` (it destroyed one of the tester's own control renders); (4) a write failure **after** a billed generation lost the image with a raw stack trace, because the directory was only touched at write time; (5) **no request timeout** — a hung call blocked forever; (6) a typo'd flag **became prompt text** and spent quota on a corrupted prompt. Also: a rejected credential comes back as **400 "Incorrect API key"**, not only 401. All six fixed and regression-tested (24 tests). **Independently confirmed working:** the token never appears on any output path (swept), and the issuer-prefix regression test was *proven live* — a reviewer mutated the selection to `Object.values(raw)[0]` and the suite went red within seconds. **Newly measured** and folded into Part 2: the dimension grid, mime behaviour, `quality`/`n`/`21:9`/`auto` acceptance, the 8000-char cap, and the absence of upsampler token fields. |
