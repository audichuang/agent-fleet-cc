#!/usr/bin/env node
// Direct xAI Imagine call — no companion, no job, no log triage.
//
// Auth: the grok CLI's own OAuth access token, read from ~/.grok/auth.json. That
// file is grok's to own — we NEVER write it and never touch `refresh_token`:
// auth.x.ai may rotate refresh tokens on use, so an out-of-band refresh here
// could silently log the user out of grok itself. Expired token => tell them to
// run grok once and let it refresh. `XAI_API_KEY` is the fallback for machines
// with no grok login.
import { lstatSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const ISSUER_PREFIX = "https://auth.x.ai::";
const DEFAULT_TIMEOUT_MS = 180_000;

// The API tells us what it actually sent. 2k comes back as PNG, 1k as JPEG —
// measured, and the single most surprising thing about this endpoint.
const EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

export class ImageError extends Error {}

export function defaultAuthFile() {
  return process.env.GROK_AUTH_FILE ?? path.join(homedir(), ".grok", "auth.json");
}

// Returns the bearer to use, or throws an ImageError whose message is the fix.
export function resolveToken({ authFile = defaultAuthFile(), now = Date.now() } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(authFile, "utf8"));
  } catch {
    raw = null;
  }
  // Select the xAI OAuth entry by issuer — not the first key blind; the store is
  // keyed "<issuer>::<client_id>" and may hold more than one provider later.
  const entry = raw && Object.entries(raw).find(([k]) => k.startsWith(ISSUER_PREFIX))?.[1];
  const token = typeof entry?.key === "string" ? entry.key.trim() : "";
  if (token) {
    // A missing or unparseable `expires_at` deliberately falls THROUGH to the API
    // rather than failing closed: the token may be perfectly good, and grok owns
    // that file's shape. A real 401 carries the same fix as the guard below.
    const expiresAt = Date.parse(entry.expires_at ?? "");
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      throw new ImageError(
        `grok OAuth token expired at ${entry.expires_at}. Run \`grok\` once (any prompt) to let it refresh, then retry.`,
      );
    }
    return token;
  }
  const apiKey = (process.env.XAI_API_KEY ?? "").trim();
  if (apiKey) return apiKey;
  throw new ImageError(
    `No xAI credentials: no \`${ISSUER_PREFIX}…\` entry in ${authFile} and no XAI_API_KEY. Log in with \`grok\` or export XAI_API_KEY.`,
  );
}

// Rewrite the extension to match what the API actually returned, so a 2k render
// does not land as a PNG inside a file called .jpg.
export function outPathFor(out, mimeType) {
  const want = EXT_BY_MIME[mimeType];
  if (!want) return out; // unknown mime: honour the caller's name rather than guess
  return path.extname(out).toLowerCase() === want ? out : out.slice(0, out.length - path.extname(out).length) + want;
}

export async function generateImage({
  prompt,
  out,
  aspect = "1:1",
  model = "grok-imagine-image",
  resolution = "1k",
  quality,
  token,
  fetchImpl = fetch,
  baseUrl = process.env.XAI_BASE_URL ?? DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // Reserve the destination BEFORE spending money. A generation that succeeds and
  // then cannot be written is a paid image lost for good — the bytes are in memory
  // and the API's URL is ephemeral.
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  // ...and refuse a taken destination BEFORE the money is spent. The 'wx' write below
  // still closes the race and the renamed-extension case; this only avoids paying to
  // discover a collision we could see for free.
  // lstat, not existsSync: existsSync follows the link, so a DANGLING symlink reads as
  // free and then fails the 'wx' write after the image is paid for.
  if (lstatSync(out, { throwIfNoEntry: false })) {
    throw new ImageError(`${out} already exists — refusing to overwrite. Nothing was generated or billed; pick a different --out.`);
  }

  const body = { model, prompt, aspect_ratio: aspect, resolution, response_format: "b64_json" };
  if (quality) body.quality = quality;
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ImageError(`xAI did not respond within ${Math.round(timeoutMs / 1000)}s. Nothing was saved; the call may still have been billed.`);
    }
    throw error;
  }
  if (!res.ok) {
    // The body is echoed to the user; a bearer that came back in it must not ride along.
    // Redact BEFORE truncating, or a token straddling the 300-char cut leaves a fragment.
    // Every accepted credential, not just the long ones — a length threshold here only
    // existed to protect a test fixture's one-character "token", which is backwards.
    const raw = await res.text().catch(() => "");
    const detail = (token && raw.includes(token) ? raw.split(token).join("<redacted>") : raw).slice(0, 300);
    // Classify on the RAW body, never the redacted one: a short token like "key" turns
    // "Incorrect API key" into "Incorrect API <redacted>" and the 400 stops being
    // recognised as a credential failure — the redaction would eat its own classifier.
    // 401 is the documented shape; a rejected bearer has also been seen to come
    // back as 400 "Incorrect API key provided", so key on the message too.
    if (res.status === 401 || (res.status === 400 && /api key/i.test(raw))) {
      throw new ImageError(`xAI rejected the credential (${res.status}). If you log in through grok, run \`grok\` once to refresh, then retry. ${detail}`);
    }
    if (res.status === 403) {
      throw new ImageError(
        // xAI does not document what produces a 403 here, so name the likely cause as
        // likely rather than asserting it.
        `403 from xAI. The usual cause is that this account's tier is not entitled to Imagine over this surface — set XAI_API_KEY to use the metered path, or upgrade at x.ai/grok. ${detail}`,
      );
    }
    // 422 is worth passing through verbatim: xAI enumerates the whole accepted
    // enum in the message, which is more useful than anything we could validate.
    throw new ImageError(`xAI image generation failed (${res.status}): ${detail}`);
  }
  const first = (await res.json())?.data?.[0];
  let bytes;
  if (typeof first?.b64_json === "string" && first.b64_json) {
    bytes = Buffer.from(first.b64_json, "base64");
  } else if (typeof first?.url === "string" && first.url) {
    // Fetch NOW: xAI's imgen.x.ai URLs are ephemeral and 404 within minutes.
    // We ask for b64_json, so this is the fallback path, not the normal one.
    const img = await fetchImpl(first.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!img.ok) throw new ImageError(`xAI returned only a URL and it failed to download (${img.status})`);
    bytes = Buffer.from(await img.arrayBuffer());
  } else {
    throw new ImageError("xAI response contained neither b64_json nor url");
  }
  if (bytes.length === 0) throw new ImageError("xAI returned an empty image");

  const saved = outPathFor(out, first.mime_type);
  try {
    // 'wx' — never clobber. Cheaper and more honest than a check-then-write race,
    // and it also refuses a symlink planted at the destination.
    writeFileSync(saved, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ImageError(`${saved} already exists — refusing to overwrite. The image was generated and billed; re-run with a different --out to keep it.`);
    }
    throw new ImageError(`the image was generated and billed, but could not be written to ${saved}: ${error?.message ?? error}`);
  }
  return { out: saved, bytes: bytes.length, model, mimeType: first.mime_type, renamed: saved !== out };
}

const FLAGS = { "--out": "out", "--prompt-file": "promptFile", "--aspect": "aspect", "--model": "model", "--resolution": "resolution", "--quality": "quality" };

export function parseArgs(argv) {
  const opts = { aspect: "1:1", model: "grok-imagine-image", resolution: "1k" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = FLAGS[flag];
    if (key) {
      const value = argv[++i];
      if (value === undefined) throw new ImageError(`${flag} needs a value`);
      // A following flag is not a value: `--out --aspect 16:9` used to set out="--aspect"
      // and ship "16:9" as the prompt — a billed render of a silently corrupted request.
      if (value.startsWith("--")) {
        throw new ImageError(`${flag} needs a value, got the flag ${value}. For a path that really starts with --, write ./${value}`);
      }
      opts[key] = value;
    } else if (flag.startsWith("--")) {
      // Never let a typo'd flag slide into the prompt text — that spends quota on
      // a corrupted prompt and looks like a normal run.
      throw new ImageError(`unknown flag ${flag}. Known flags: ${Object.keys(FLAGS).join(" ")}`);
    } else {
      rest.push(flag);
    }
  }
  opts.prompt = rest.join(" ").trim();
  return opts;
}

// The prompt often contains double quotes (on-image text must be quoted), which a
// shell strips silently. Reading it from stdin sidesteps quoting entirely.
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // Verbatim. `--prompt-file -` promises the same byte-for-byte transport as a real file,
  // so the trimming that the bare-stdin fallback wants happens at its own call site.
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv, { stdin = readStdin } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
    // --prompt-file is the safe transport: a prompt carrying the caller's heredoc
    // delimiter used to end the here-document and run the rest as shell. A file has
    // no such escape, and it keeps the double quotes on-image text needs.
    //
    // When it is given it is THE source — never a preference that falls back to stdin or
    // to the positional words on empty. Precedence that changes with the file's CONTENT is
    // how a caller ends up billed for a prompt they cannot see.
    // `!== undefined`, not truthiness: `--prompt-file ""` used to be falsy and fall through
    // to stdin, which is the content-dependent precedence this branch exists to kill.
    if (opts.promptFile !== undefined) {
      if (opts.prompt) throw new ImageError("--prompt-file and a positional prompt are two prompts; pass one.");
      // Bytes as-is: the promise is verbatim transport. .trim() only decides emptiness.
      opts.prompt = opts.promptFile === "-" ? await stdin() : readFileSync(opts.promptFile, "utf8");
      if (!opts.prompt.trim()) throw new ImageError(`${opts.promptFile} is empty — nothing to render.`);
    }
    if (!opts.prompt) opts.prompt = (await stdin()).trim();
  } catch (error) {
    process.stderr.write(`imagine: ${error?.message ?? error}\n`);
    return 2;
  }
  if (!opts.prompt) {
    process.stderr.write(
      "usage: imagine.mjs --prompt-file <path|-> [--out <path>] [--aspect 1:1] [--resolution 1k|2k] [--model <id>] [--quality low|medium]\n" +
        '       the prompt may also be a positional argument ("<prompt>") or piped on stdin, but a file\n' +
        "       is the only transport a shell cannot corrupt. Without --out the image lands in a fresh temp dir.\n",
    );
    return 2;
  }

  try {
    // No --out: pick a private directory rather than making the caller compute one in the
    // shell and splice it back into the next command line. Inside the try — an unusable
    // TMPDIR must fail as the same one-line reason as everything else, not a stack trace.
    if (!opts.out) opts.out = path.join(mkdtempSync(path.join(tmpdir(), "imagine-")), "image.jpg");
    const r = await generateImage({ ...opts, token: resolveToken() });
    // The disk is the receipt — statSync so we report what actually landed.
    const note = r.renamed ? ` — extension corrected to match ${r.mimeType}` : "";
    process.stdout.write(`IMAGE_SAVED: ${path.resolve(r.out)} (${statSync(r.out).size} bytes, ${r.model})${note}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`imagine: ${error instanceof ImageError ? error.message : (error?.stack ?? error)}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
