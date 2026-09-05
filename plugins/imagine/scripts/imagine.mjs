#!/usr/bin/env node
// Two engines, one contract: the file on disk is the receipt.
//
// `grok` (default) is a direct xAI Imagine call — no companion, no job, no log triage.
// Auth: the grok CLI's own OAuth access token, read from ~/.grok/auth.json. That
// file is grok's to own — we NEVER write it and never touch `refresh_token`:
// auth.x.ai may rotate refresh tokens on use, so an out-of-band refresh here
// could silently log the user out of grok itself. Expired token => tell them to
// run grok once and let it refresh. `XAI_API_KEY` is the fallback for machines
// with no grok login.
//
// `agy` spawns the Antigravity CLI and lets its built-in `generate_image` tool do
// the render, on the user's Google login — no xAI credential, no key at all. It is
// an agent, so its word means nothing here: the run is judged by `statSync(out)`
// exactly like the HTTP path, and "SUCCESS" with no file is a failure.
import { constants, lstatSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const ISSUER_PREFIX = "https://auth.x.ai::";
const DEFAULT_TIMEOUT_MS = 180_000;
// agy renders in ~30s. Its own --print-timeout fires first with a clean error;
// this backstop only covers a process that hangs without printing.
const AGY_PRINT_TIMEOUT = "4m";
const AGY_TIMEOUT_MS = 270_000;
// SIGTERM, then SIGKILL: a child that ignores the first must not hold this process open.
const SIGKILL_GRACE_MS = 5_000;
// SIGKILL still cannot force `close` when a descendant holds the pipes. This is how long
// we wait for it before answering anyway — and saying the tree was not confirmed dead.
const FINAL_DEADLINE_MS = 5_000;

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

// Reserve the destination BEFORE spending anything. A render that succeeds and then
// cannot be written is a paid image lost for good.
// lstat, not existsSync: existsSync follows the link, so a DANGLING symlink reads as
// free and then fails the write after the image is paid for.
function reserveOut(out) {
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  if (lstatSync(out, { throwIfNoEntry: false })) {
    throw new ImageError(`${out} already exists — refusing to overwrite. Nothing was generated or billed; pick a different --out.`);
  }
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
  // The bytes are in memory and the API's URL is ephemeral, so the destination is
  // claimed before the money is spent. The 'wx' write below still closes the race and
  // the renamed-extension case; this only avoids paying to discover a free collision.
  reserveOut(out);

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

// ---------------------------------------------------------------- agy engine

// Same name the antigravity plugin uses, so one export overrides both.
export function resolveAgyBin(env = process.env) {
  return (env.AGY_BIN ?? "").trim() || "agy";
}

// The extension has to match the bytes, the same promise the xAI path keeps. agy is
// asked for a JPEG and has obliged both times measured, but it is an agent holding a
// tool we do not control, so the file itself decides.
const MAGIC = [
  [Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"],
];
export function sniffMime(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(8);
    const n = readSync(fd, head, 0, 8, 0);
    return MAGIC.find(([sig]) => n >= sig.length && head.subarray(0, sig.length).equals(sig))?.[1];
  } finally {
    closeSync(fd);
  }
}

// The prompt is user- and model-authored text, which is why it never reaches a shell
// anywhere in this plugin. Here it rides in an argv array — spawn without a shell has
// no word splitting, no quote stripping and no here-document to close, so the wrapper
// below can safely embed it verbatim.
export function agyPrompt({ prompt, aspect, out }) {
  return (
    `Call your generate_image tool with AspectRatio "${aspect}" and this Prompt, verbatim:\n\n` +
    `${prompt}\n\n` +
    `Save the generated image as a JPEG at exactly ${out}. Do not convert or re-encode it. ` +
    `Reply with only that path — nothing else, no summary.`
  );
}

function runAgy({ bin, args, cwd, timeoutMs, spawnImpl, killImpl = process.kill, graceMs = SIGKILL_GRACE_MS, deadlineMs = FINAL_DEADLINE_MS }) {
  return new Promise((resolve, reject) => {
    // detached puts agy in its own process group so a timeout can signal the GROUP. agy
    // spawns helpers; signalling only the leader leaves them holding the inherited pipes
    // and `close` never arrives — measured, a 100ms timeout took 1087ms to settle behind
    // a 1s descendant. Without detached, a negative pid would signal our own group.
    const child = spawnImpl(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let escalation;
    let deadline;
    const clearAll = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(deadline);
    };
    // One settle, whatever arrives first. `close` after a deadline, or an `error` a
    // synchronous kill emits, must not resolve a promise that already answered.
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearAll();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearAll();
      reject(error);
    };
    const signalTree = (sig) => {
      try {
        if (child.pid) killImpl(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // ESRCH: already gone. Nothing to do, and nothing worth reporting.
      }
    };
    // A timeout does NOT reject: agy has been seen to finish the render and then hang
    // narrating it, and rejecting here would discard an image that is already on disk.
    // Kill the group, then let the caller judge by the file like every other path does.
    const timer = setTimeout(() => {
      timedOut = true;
      // Arm the escalation BEFORE signalling: a kill that emits `close` synchronously
      // would otherwise leave a timer nobody can clear, firing SIGKILL at a dead pid and
      // holding the event loop open for the grace period (measured: 22ms promise, 5.06s
      // process).
      escalation = setTimeout(() => {
        signalTree("SIGKILL");
        // Even SIGKILL cannot guarantee `close` — a descendant outside the group, or one
        // holding the pipes, can outlive it. Settle on our own clock and tell the caller
        // the tree was never confirmed dead, so it does not delete a directory something
        // may still be writing into.
        deadline = setTimeout(() => settle({ code: null, stdout, stderr, timedOut, treeConfirmedDead: false }), deadlineMs);
      }, graceMs);
      signalTree("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (e) => {
      fail(
        new ImageError(
          e?.code === "ENOENT"
            ? `agy is not installed (looked for \`${bin}\`). Install the Antigravity CLI, or set AGY_BIN — or drop --engine agy to use xAI.`
            : `could not run agy: ${e?.message ?? e}`,
        ),
      );
    });
    child.on("close", (code) => settle({ code, stdout, stderr, timedOut, treeConfirmedDead: true }));
  });
}

// Drive agy's built-in generate_image tool. No API key: it renders on the user's own
// Google login, which is the whole reason this engine exists next to the xAI one.
export async function generateWithAgy({
  prompt,
  out,
  aspect = "1:1",
  agyBin = resolveAgyBin(),
  spawnImpl = spawn,
  killImpl = process.kill,
  timeoutMs = AGY_TIMEOUT_MS,
  graceMs = SIGKILL_GRACE_MS,
  deadlineMs = FINAL_DEADLINE_MS,
}) {
  reserveOut(out);
  const abs = path.resolve(out);
  // agy renders into a private staging directory, never straight onto the destination.
  // The real extension is only knowable once the bytes exist, and correcting `.jpg` to
  // `.png` in place would rename over a `.png` that reserveOut never looked at — the xAI
  // path's "never clobber" promise, quietly broken. Staging also means a second
  // invocation cannot hand us its file as our receipt.
  let stage;
  try {
    stage = mkdtempSync(path.join(tmpdir(), "imagine-agy-"));
  } catch (error) {
    throw new ImageError(
      `could not create a staging directory under ${tmpdir()}: ${error?.message ?? error}. Set TMPDIR to a writable directory, or fix that path.`,
    );
  }
  const staged = path.join(stage, "image.jpg");
  // Set when the bytes on disk are worth more than a tidy /tmp: a render we could not
  // publish, or a tree we could not confirm dead and must not delete underneath.
  let keepStage = null;
  try {
    const args = [
      "-p",
      agyPrompt({ prompt, aspect, out: staged }),
      "--output-format",
      "json",
      "--print-timeout",
      AGY_PRINT_TIMEOUT,
      // agy needs to write the file where we asked, which is a tool permission it would
      // otherwise stop and ask for in a headless run. Note what cwd below does NOT do: an
      // agent whose permissions are skipped can still reach anywhere by absolute path, so
      // cwd only decides where a RELATIVE path of agy's lands. It is not a fence.
      "--dangerously-skip-permissions",
    ];
    const { code, stdout, stderr, timedOut, treeConfirmedDead } = await runAgy({ bin: agyBin, args, cwd: stage, timeoutMs, spawnImpl, killImpl, graceMs, deadlineMs });
    if (!treeConfirmedDead) keepStage = "agy did not exit and may still be writing there";

    // The receipt is the file, never the JSON — an agent reporting success it did not
    // achieve is the exact failure mode this plugin refuses to inherit. The response text
    // is only ever quoted back as the reason a missing file is missing.
    let saved;
    try {
      saved = statSync(staged);
    } catch {
      const said = (() => {
        try {
          return JSON.parse(stdout)?.response ?? "";
        } catch {
          return stdout;
        }
      })();
      const tail = (said || stderr || "").trim().replace(/\s+/g, " ").slice(0, 300);
      if (timedOut) {
        throw new ImageError(
          `agy did not finish within ${Math.round(timeoutMs / 1000)}s and left no image. The render may still have cost quota. ` +
            (treeConfirmedDead ? "" : "agy did not exit even after SIGKILL — a helper process may still be running. ") +
            (tail ? `agy said: ${tail}` : "agy printed nothing before it was killed."),
        );
      }
      throw new ImageError(
        `agy exited ${code} but wrote no file. ` +
          `Its generate_image tool saves into ~/.gemini/antigravity-cli/brain/<conversation-id>/ first, so a render may be there. ` +
          (tail ? `agy said: ${tail}` : "agy said nothing."),
      );
    }
    if (saved.size === 0) throw new ImageError("agy wrote an empty file");

    // Unknown bytes are a failed render, not an image with a surprising type. Letting
    // them through would put HTML or an error page behind an IMAGE_SAVED line and a zero
    // exit — the shape this whole plugin exists to refuse.
    const mimeType = sniffMime(staged);
    if (!mimeType) {
      throw new ImageError(
        `agy wrote ${saved.size} bytes that are not a JPEG or a PNG. Treating that as a failed render rather than reporting junk as an image.`,
      );
    }

    const target = outPathFor(abs, mimeType);
    try {
      // COPYFILE_EXCL publishes through an O_EXCL create: it cannot clobber, and it
      // cannot be raced. This is where `--out image.jpg` + PNG bytes stops being able to
      // land on top of someone's image.png.
      copyFileSync(staged, target, constants.COPYFILE_EXCL);
    } catch (error) {
      // The render happened and was paid for. Deleting it in the finally below would
      // charge the user twice for the same picture, and a re-run does not reproduce it.
      keepStage = "the render is kept here because the destination was taken";
      if (error?.code === "EEXIST") {
        throw new ImageError(
          `${target} already exists — refusing to overwrite. The image was generated and billed; it is at ${staged} — move it, or re-run with a different --out (a re-run costs quota and will not reproduce this image).`,
        );
      }
      throw new ImageError(`the image was generated and billed, but could not be written to ${target}: ${error?.message ?? error}. It is at ${staged}.`);
    }
    return { out: target, bytes: saved.size, model: "agy/generate_image", mimeType, renamed: target !== abs };
  } finally {
    // Only ever delete a directory nothing is still writing to and nothing of value is
    // left in. `force` so a half-created stage is not a second error on the way out.
    if (keepStage) process.stderr.write(`imagine: keeping ${stage} — ${keepStage}\n`);
    else rmSync(stage, { recursive: true, force: true });
  }
}

const FLAGS = { "--out": "out", "--prompt-file": "promptFile", "--aspect": "aspect", "--model": "model", "--resolution": "resolution", "--quality": "quality", "--engine": "engine" };

const ENGINES = ["grok", "agy"];
// Knobs the xAI endpoint owns. agy's tool takes a prompt and an aspect ratio and
// nothing else, so accepting these there would silently drop them — and a dropped
// --model is a render the caller did not ask for, billed all the same.
const GROK_ONLY = ["--model", "--resolution", "--quality"];

export function parseArgs(argv) {
  const opts = { aspect: "1:1", model: "grok-imagine-image", resolution: "1k", engine: "grok" };
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
  if (!ENGINES.includes(opts.engine)) {
    throw new ImageError(`unknown engine ${opts.engine}. Known engines: ${ENGINES.join(" ")}`);
  }
  if (opts.engine === "agy") {
    const given = GROK_ONLY.filter((f) => argv.includes(f));
    if (given.length) {
      throw new ImageError(
        `${given.join(", ")} ${given.length > 1 ? "are" : "is"} xAI-only. --engine agy renders through agy's built-in generate_image tool, which takes a prompt and an aspect ratio.`,
      );
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

export async function main(argv, { stdin = readStdin, spawnImpl = spawn } = {}) {
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
      "usage: imagine.mjs --prompt-file <path|-> [--engine grok|agy] [--out <path>] [--aspect 1:1]\n" +
        "                  [--resolution 1k|2k] [--model <id>] [--quality low|medium]   (last three: --engine grok only)\n" +
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
    // resolveToken is reached only on the xAI path: agy renders on the user's Google
    // login, so a machine with no grok and no XAI_API_KEY can still generate.
    const r = opts.engine === "agy" ? await generateWithAgy({ ...opts, spawnImpl }) : await generateImage({ ...opts, token: resolveToken() });
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
