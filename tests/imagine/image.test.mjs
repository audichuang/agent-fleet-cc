import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolveToken,
  generateImage,
  parseArgs,
  outPathFor,
  main,
  ImageError,
} from "../../plugins/imagine/scripts/imagine.mjs";

const dir = () => mkdtempSync(path.join(tmpdir(), "imagine-"));

function authFileWith(entries) {
  const f = path.join(dir(), "auth.json");
  writeFileSync(f, JSON.stringify(entries));
  return f;
}

const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";
const jpegBody = (b64 = Buffer.from("JPEGBYTES").toString("base64")) => ({
  ok: true,
  json: async () => ({ data: [{ b64_json: b64, mime_type: "image/jpeg" }] }),
});

test("resolveToken picks the xAI entry by issuer, not the first key", () => {
  const authFile = authFileWith({
    "https://auth.example.com::other": { key: "WRONG", expires_at: FUTURE },
    "https://auth.x.ai::client": { key: "RIGHT", expires_at: FUTURE },
  });
  assert.equal(resolveToken({ authFile }), "RIGHT");
});

test("resolveToken refuses an expired token instead of using it", () => {
  const authFile = authFileWith({ "https://auth.x.ai::c": { key: "STALE", expires_at: PAST } });
  assert.throws(() => resolveToken({ authFile }), (e) => e instanceof ImageError && /expired/.test(e.message));
});

test("resolveToken falls back to XAI_API_KEY when there is no grok login", (t) => {
  t.after(() => delete process.env.XAI_API_KEY);
  process.env.XAI_API_KEY = "xai-fallback";
  assert.equal(resolveToken({ authFile: path.join(dir(), "missing.json") }), "xai-fallback");
});

test("generateImage writes the b64 payload to <out>", async () => {
  const out = path.join(dir(), "image.jpg");
  const r = await generateImage({ prompt: "a cat", out, token: "xai-test-bearer-0123456789", fetchImpl: async () => jpegBody() });
  assert.equal(readFileSync(out, "utf8"), "JPEGBYTES");
  assert.equal(r.bytes, 9);
});

test("generateImage asks for b64_json — without it the API only ever returns an ephemeral URL", async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return jpegBody("eA==");
  };
  await generateImage({
    prompt: "a cat",
    out: path.join(dir(), "i.jpg"),
    aspect: "16:9",
    resolution: "2k",
    token: "xai-test-bearer-0123456789",
    fetchImpl,
  });
  assert.deepEqual(body, {
    model: "grok-imagine-image",
    prompt: "a cat",
    aspect_ratio: "16:9",
    resolution: "2k",
    response_format: "b64_json",
  });
});

test("--quality rides along only when asked for", async () => {
  const bodies = [];
  const fetchImpl = async (_u, init) => (bodies.push(JSON.parse(init.body)), jpegBody("eA=="));
  const out = () => path.join(dir(), "i.jpg");
  await generateImage({ prompt: "x", out: out(), token: "xai-test-bearer-0123456789", fetchImpl });
  await generateImage({ prompt: "x", out: out(), token: "xai-test-bearer-0123456789", quality: "low", fetchImpl });
  assert.ok(!("quality" in bodies[0]));
  assert.equal(bodies[1].quality, "low");
});

test("a PNG response is not written into a .jpg filename", async () => {
  // 2k renders come back as image/png. Deterministic, and the whole reason this exists.
  const out = path.join(dir(), "image.jpg");
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [{ b64_json: Buffer.from("PNGBYTES").toString("base64"), mime_type: "image/png" }] }),
  });
  const r = await generateImage({ prompt: "x", out, resolution: "2k", token: "xai-test-bearer-0123456789", fetchImpl });
  assert.equal(path.extname(r.out), ".png");
  assert.equal(r.renamed, true);
  assert.ok(!existsSync(out), "must not also leave a mislabelled .jpg behind");
  assert.equal(readFileSync(r.out, "utf8"), "PNGBYTES");
});

test("outPathFor leaves an unknown mime alone rather than guessing", () => {
  assert.equal(outPathFor("/tmp/a.jpg", undefined), "/tmp/a.jpg");
  assert.equal(outPathFor("/tmp/a.jpg", "image/jpeg"), "/tmp/a.jpg");
  assert.equal(outPathFor("/tmp/a.jpg", "image/png"), "/tmp/a.png");
});

test("a destination that is already taken is refused BEFORE the request is paid for", async () => {
  const out = path.join(dir(), "taken.jpg");
  writeFileSync(out, "PRECIOUS");
  let requested = false;
  await assert.rejects(
    generateImage({ prompt: "x", out, token: "xai-test-bearer-0123456789", fetchImpl: async () => { requested = true; return jpegBody(); } }),
    (e) => e instanceof ImageError && /refusing to overwrite/.test(e.message) && /never|nothing was generated/i.test(e.message),
  );
  assert.equal(requested, false, "the collision was visible for free — we must not pay to discover it");
  assert.equal(readFileSync(out, "utf8"), "PRECIOUS");
});

test("a collision only the corrected extension reveals still refuses, and says it was billed", async () => {
  // --out image.jpg + a PNG response renames to image.png, which the pre-flight check
  // could not have seen. Here the money IS spent, so the message must say so.
  const d = dir();
  writeFileSync(path.join(d, "shot.png"), "PRECIOUS");
  const png = { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from("PNGBYTES").toString("base64"), mime_type: "image/png" }] }) };
  await assert.rejects(
    generateImage({ prompt: "x", out: path.join(d, "shot.jpg"), token: "xai-test-bearer-0123456789", fetchImpl: async () => png }),
    (e) => e instanceof ImageError && /refusing to overwrite/.test(e.message) && /billed/.test(e.message),
  );
  assert.equal(readFileSync(path.join(d, "shot.png"), "utf8"), "PRECIOUS");
});

test("the output directory is created BEFORE the request, so a paid image is never lost to ENOENT", async () => {
  const out = path.join(dir(), "deep", "nested", "image.jpg");
  let requested = false;
  const fetchImpl = async () => {
    // If the directory were only created at write time, this ordering assertion
    // is what would fail — the point is that we do not pay before we can save.
    assert.ok(existsSync(path.dirname(out)), "destination must exist before we spend money");
    requested = true;
    return jpegBody();
  };
  await generateImage({ prompt: "x", out, token: "xai-test-bearer-0123456789", fetchImpl });
  assert.ok(requested);
  assert.equal(readFileSync(out, "utf8"), "JPEGBYTES");
});

test("generateImage downloads a url-only response immediately (the URL is ephemeral)", async () => {
  const out = path.join(dir(), "image.jpg");
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (seen.length === 1) return { ok: true, json: async () => ({ data: [{ url: "https://imgen.x.ai/tmp-1" }] }) };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode("DOWNLOADED").buffer };
  };
  await generateImage({ prompt: "a cat", out, token: "xai-test-bearer-0123456789", fetchImpl });
  assert.equal(seen[1], "https://imgen.x.ai/tmp-1");
  assert.equal(readFileSync(out, "utf8"), "DOWNLOADED");
});

test("credential rejection is recognised as 401 AND as the 400 the API actually sends", async () => {
  const fail = (status, text) => async () => ({ ok: false, status, text: async () => text });
  const call = (status, text) =>
    generateImage({ prompt: "x", out: path.join(dir(), "i.jpg"), token: "xai-test-bearer-0123456789", fetchImpl: fail(status, text) });
  await assert.rejects(call(401, "nope"), (e) => /refresh/.test(e.message));
  await assert.rejects(
    call(400, '{"error":"Incorrect API key provided."}'),
    (e) => e instanceof ImageError && /refresh/.test(e.message),
  );
  // a 400 that is NOT about credentials must stay generic, not misdiagnose
  await assert.rejects(call(400, "bad prompt"), (e) => /failed \(400\)/.test(e.message));
  await assert.rejects(call(403, "nope"), (e) => /tier/.test(e.message));
});

test("a 422 is passed through verbatim — xAI enumerates the legal enum in it", async () => {
  const enumMsg = "unknown variant `7:11`, expected one of `1:1`, `16:9`, `auto`";
  await assert.rejects(
    generateImage({
      prompt: "x",
      out: path.join(dir(), "i.jpg"),
      token: "xai-test-bearer-0123456789",
      fetchImpl: async () => ({ ok: false, status: 422, text: async () => enumMsg }),
    }),
    (e) => e.message.includes(enumMsg),
  );
});

test("a hung request fails with a stated timeout instead of blocking forever", async () => {
  await assert.rejects(
    generateImage({
      prompt: "x",
      out: path.join(dir(), "i.jpg"),
      token: "xai-test-bearer-0123456789",
      timeoutMs: 5,
      fetchImpl: (_u, init) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
    }),
    (e) => e instanceof ImageError && /did not respond within/.test(e.message),
  );
});

test("a typo'd flag is an error, never silent prompt text", () => {
  // The old parser folded `--frobnicate hello` into the prompt and spent quota on it.
  assert.throws(() => parseArgs(["--frobnicate", "hello", "--out", "x"]), (e) => /unknown flag/.test(e.message));
  assert.throws(() => parseArgs(["a cat", "--out"]), (e) => /--out needs a value/.test(e.message));
  // `--out --aspect 16:9` used to set out="--aspect" and ship "16:9" as the prompt:
  // a billed render of a request nobody wrote. A flag is never another flag's value.
  assert.throws(
    () => parseArgs(["cat", "--out", "--aspect", "16:9"]),
    (e) => /--out needs a value, got the flag --aspect/.test(e.message),
  );
  assert.deepEqual(parseArgs(["a", "cat", "--out", "x.jpg"]).prompt, "a cat");
});

test("--prompt-file carries a prompt no shell could: it contains the heredoc delimiter itself", async () => {
  // The exact prompt that made the old heredoc transport unsafe. A line reading PROMPT
  // ended the here-document and handed the next line to the shell.
  const d = dir();
  const pf = path.join(d, "prompt.txt");
  const nasty = 'a cat holding a sign reading "PROMPT"\nPROMPT\nrm -rf /nope\n';
  writeFileSync(pf, nasty);
  let sent;
  const authFile = authFileWith({ "https://auth.x.ai::c": { key: "T", expires_at: FUTURE } });
  process.env.GROK_AUTH_FILE = authFile;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => ((sent = JSON.parse(init.body)), jpegBody());
  try {
    const code = await main(["--prompt-file", pf, "--out", path.join(d, "i.jpg")]);
    assert.equal(code, 0);
    assert.equal(sent.prompt, nasty, "every byte of the prompt must reach the model, trailing newline included");
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.GROK_AUTH_FILE;
  }
});

test("--prompt-file is THE source: it never silently falls back, and never doubles up", async () => {
  const d = dir();
  const empty = path.join(d, "empty.txt");
  writeFileSync(empty, "   \n");
  const authFile = authFileWith({ "https://auth.x.ai::c": { key: "T", expires_at: FUTURE } });
  process.env.GROK_AUTH_FILE = authFile;
  const origFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => { requested = true; return jpegBody(); };
  try {
    // An empty file used to fall through to stdin — precedence that turns on the file's
    // CONTENT, which is how you get billed for a prompt you cannot see.
    assert.equal(await main(["--prompt-file", empty], { stdin: async () => "a cat" }), 2);
    // Two prompts is a usage error, not a silent winner.
    const pf = path.join(d, "p.txt");
    writeFileSync(pf, "a dog");
    assert.equal(await main(["a cat", "--prompt-file", pf]), 2);
    assert.equal(requested, false, "neither malformed invocation may reach the API");
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.GROK_AUTH_FILE;
  }
});

test("a DANGLING symlink at the destination is caught before the request, not after the bill", async () => {
  const d = dir();
  const out = path.join(d, "link.jpg");
  symlinkSync(path.join(d, "nowhere.jpg"), out); // points at nothing: existsSync reads it as free
  let requested = false;
  await assert.rejects(
    generateImage({ prompt: "x", out, token: "xai-test-bearer-0123456789", fetchImpl: async () => { requested = true; return jpegBody(); } }),
    (e) => e instanceof ImageError && /nothing was generated/i.test(e.message),
  );
  assert.equal(requested, false, "the name is taken — a dangling link still fails the wx write");
});

test("a short credential is redacted too — the threshold that protected a test fixture is gone", async () => {
  const token = "sk-shortish";
  await assert.rejects(
    generateImage({
      prompt: "x",
      out: path.join(dir(), "i.jpg"),
      token,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => `key ${token} rejected` }),
    }),
    (e) => e instanceof ImageError && !e.message.includes(token),
  );
});

test("without --out the script picks its own fresh directory, so no path is computed in a shell", async () => {
  const authFile = authFileWith({ "https://auth.x.ai::c": { key: "T", expires_at: FUTURE } });
  process.env.GROK_AUTH_FILE = authFile;
  const origFetch = globalThis.fetch;
  const origWrite = process.stdout.write.bind(process.stdout);
  let line = "";
  process.stdout.write = (chunk) => ((line += chunk), true);
  globalThis.fetch = async () => jpegBody();
  try {
    const code = await main(["a cat"]);
    process.stdout.write = origWrite;
    assert.equal(code, 0);
    const saved = line.match(/IMAGE_SAVED: (\S+)/)?.[1];
    assert.ok(saved, `expected an IMAGE_SAVED line, got: ${line}`);
    assert.equal(readFileSync(saved, "utf8"), "JPEGBYTES");
  } finally {
    process.stdout.write = origWrite;
    globalThis.fetch = origFetch;
    delete process.env.GROK_AUTH_FILE;
  }
});

test("a credential error never echoes the bearer back, even if the API reflects it", async () => {
  const token = "sk-super-secret-1234";
  await assert.rejects(
    generateImage({
      prompt: "x",
      out: path.join(dir(), "i.jpg"),
      token,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => `bad key ${token} rejected` }),
    }),
    (e) => e instanceof ImageError && !e.message.includes(token) && /<redacted>/.test(e.message),
  );
});

test("main reads the prompt from stdin, so shell quote-stripping cannot corrupt it", async () => {
  const out = path.join(dir(), "i.jpg");
  const quoted = 'headline "BLUE HOURS" across the top third';
  let sent;
  const authFile = authFileWith({ "https://auth.x.ai::c": { key: "T", expires_at: FUTURE } });
  process.env.GROK_AUTH_FILE = authFile;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => ((sent = JSON.parse(init.body)), jpegBody());
  try {
    const code = await main(["--out", out], { stdin: async () => quoted });
    assert.equal(code, 0);
    assert.equal(sent.prompt, quoted, "the quotes must survive intact");
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.GROK_AUTH_FILE;
  }
});
