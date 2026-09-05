import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateWithAgy, agyPrompt, resolveAgyBin, sniffMime, parseArgs, main, ImageError } from "../../plugins/imagine/scripts/imagine.mjs";

// Deliberately NOT the "imagine-agy-" prefix the engine stages under — the cleanup test
// counts those, and sharing the prefix would count the test's own scratch dirs.
const dir = () => mkdtempSync(path.join(tmpdir(), "imagine-test-"));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JPEGBYTES")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("PNGBYTES")]);

// A fake agy. `handler` gets the spawn call and decides what the process does —
// including whether it writes the file, which is the only thing that counts.
// Runs that keep their staging on purpose (an unconfirmed kill, an unpublishable render)
// would otherwise pile up in /tmp across suite runs.
const stagesMade = [];
after(() => {
  for (const d of stagesMade) rmSync(d, { recursive: true, force: true });
});

function fakeAgy(handler) {
  const calls = [];
  const signals = [];
  let nextPid = 4200;
  const spawnImpl = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    stagesMade.push(path.dirname(stagedPath(args)));
    const child = new EventEmitter();
    child.pid = ++nextPid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let mode = {};
    child.kill = (sig) => signals.push({ pid: child.pid, sig, viaChild: true });
    spawnImpl.killImpl = (pid, sig) => {
      signals.push({ pid, sig });
      if (mode.killEmitsErrorSync) return child.emit("error", Object.assign(new Error("kill raced"), { code: "EPERM" }));
      // deaf: nothing kills it — the descendant-holds-the-pipes case, where `close`
      // never arrives however hard we signal.
      if (mode.deaf) return;
      if (!mode.ignoresTerm || sig === "SIGKILL") child.emit("close", null);
    };
    setImmediate(() => {
      mode = handler({ bin, args, opts }) ?? {};
      const { code = 0, stdout = "", stderr = "", error, hang = false } = mode;
      if (error) return child.emit("error", error);
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      if (!hang) child.emit("close", code);
    });
    return child;
  };
  spawnImpl.calls = calls;
  spawnImpl.signals = signals;
  spawnImpl.killImpl = () => {};
  return spawnImpl;
}

// Every timing test drives these instead of the 5s production clocks.
const FAST = { timeoutMs: 20, graceMs: 20, deadlineMs: 20 };
const withKill = (spawnImpl, extra = {}) => ({ spawnImpl, killImpl: (...a) => spawnImpl.killImpl(...a), ...extra });

// The path agy is told to write to — staging, not the caller's --out.
const stagedPath = (args) => args[1].match(/at exactly (\S+)\./)[1];

const succeeds = (bytes = JPEG) =>
  fakeAgy(({ args }) => {
    // Mirror the real tool: the path we asked for in the prompt is where the file lands.
    writeFileSync(stagedPath(args), bytes);
    return { stdout: JSON.stringify({ status: "SUCCESS", response: "done", conversation_id: "cid-1" }) };
  });

test("agy engine reports the file that actually landed on disk", async () => {
  const out = path.join(dir(), "image.jpg");
  const r = await generateWithAgy({ prompt: "a cat", out, spawnImpl: succeeds() });
  assert.equal(r.out, out);
  assert.equal(r.bytes, JPEG.length);
  assert.equal(r.model, "agy/generate_image");
  assert.equal(readFileSync(out).equals(JPEG), true);
});

test("a SUCCESS with no file is a failure — the agent's word is not the receipt", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(() => ({
    stdout: JSON.stringify({ status: "SUCCESS", response: "I have generated the image for you!", conversation_id: "cid-9" }),
  }));
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, spawnImpl }),
    (e) =>
      e instanceof ImageError &&
      /wrote no file/.test(e.message) &&
      // The claim is quoted back, so the user can see what agy thought it did...
      /I have generated the image for you!/.test(e.message) &&
      // ...and where its tool parks a render it forgot to move.
      /brain/.test(e.message),
  );
});

test("a non-zero exit names the code and relays what agy printed", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(() => ({ code: 1, stderr: "quota exhausted for this account" }));
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, spawnImpl }),
    (e) => e instanceof ImageError && /exited 1/.test(e.message) && /quota exhausted/.test(e.message),
  );
});

test("a missing agy binary says how to fix it rather than dying as ENOENT", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(() => ({ error: Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }) }));
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, spawnImpl }),
    (e) => e instanceof ImageError && /not installed/.test(e.message) && /AGY_BIN/.test(e.message),
  );
});

test("an empty file is not a render", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(({ args }) => {
    writeFileSync(stagedPath(args), "");
    return {};
  });
  await assert.rejects(() => generateWithAgy({ prompt: "a cat", out, spawnImpl }), (e) => e instanceof ImageError && /empty/.test(e.message));
});

test("the extension is corrected to match the bytes agy actually wrote", async () => {
  const out = path.join(dir(), "image.jpg");
  const r = await generateWithAgy({ prompt: "a cat", out, spawnImpl: succeeds(PNG) });
  assert.equal(r.out, out.replace(/\.jpg$/, ".png"));
  assert.equal(r.mimeType, "image/png");
  assert.equal(r.renamed, true);
  assert.equal(existsSync(out), false, "the .jpg name must not survive PNG bytes");
});

test("a destination that already exists is refused before agy is spawned", async () => {
  const out = path.join(dir(), "image.jpg");
  writeFileSync(out, "taken");
  const spawnImpl = fakeAgy(() => ({}));
  await assert.rejects(() => generateWithAgy({ prompt: "a cat", out, spawnImpl }), (e) => e instanceof ImageError && /already exists/.test(e.message));
  assert.equal(spawnImpl.calls.length, 0, "nothing may be spent on a destination we cannot write");
});

test("the prompt rides in the argv array, never through a shell", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = succeeds();
  // A prompt carrying quotes, a heredoc delimiter and a command substitution: all of
  // these are inert in an argv array and all of them are hazards in a command string.
  const prompt = 'poster with headline "RED BALLOON"\nEOF\n$(echo injected)';
  await generateWithAgy({ prompt, out, aspect: "16:9", spawnImpl });
  const { args, opts } = spawnImpl.calls[0];
  assert.equal(args[0], "-p");
  assert.ok(args[1].includes(prompt), "the prompt must reach agy verbatim");
  assert.match(args[1], /AspectRatio "16:9"/);
  assert.match(args[1], /at exactly \/\S+\.jpg\./, "an absolute path is what stops agy filing it under $HOME");
  assert.doesNotMatch(args[1], new RegExp(out.replace(/[.]/g, "\\.")), "agy renders into staging, never onto the caller's destination");
  assert.ok(args.includes("--output-format") && args.includes("json"));
  assert.ok(args.includes("--dangerously-skip-permissions"), "a headless run cannot answer a permission prompt");
  assert.equal(opts.cwd, path.dirname(stagedPath(args)), "a relative path from agy must land in staging, not in the caller's directory");
  assert.equal(opts.stdio[0], "ignore");
});

test("agyPrompt asks for only the path back — a long report is what times the run out", () => {
  const text = agyPrompt({ prompt: "a cat", aspect: "1:1", out: "/tmp/x.jpg" });
  assert.match(text, /Reply with only that path/);
});

test("the xAI-only knobs are rejected rather than silently dropped", () => {
  for (const flag of ["--model", "--resolution", "--quality"]) {
    assert.throws(
      () => parseArgs(["--engine", "agy", flag, "x", "a cat"]),
      (e) => e instanceof ImageError && e.message.includes(flag) && /xAI-only/.test(e.message),
      `${flag} must not be accepted with --engine agy`,
    );
  }
  // ...and the same flags stay legal on the engine that owns them.
  assert.equal(parseArgs(["--model", "x", "a cat"]).model, "x");
});

test("an unknown engine is a usage error, not a silent fallback to xAI", () => {
  assert.throws(() => parseArgs(["--engine", "dalle", "a cat"]), (e) => e instanceof ImageError && /unknown engine/.test(e.message));
  assert.equal(parseArgs(["a cat"]).engine, "grok", "the default engine stays grok");
});

test("--engine agy needs no xAI credential at all", async (t) => {
  // The point of this engine: a machine with no grok login and no XAI_API_KEY still renders.
  t.after(() => delete process.env.GROK_AUTH_FILE);
  process.env.GROK_AUTH_FILE = path.join(dir(), "no-such-auth.json");
  delete process.env.XAI_API_KEY;
  const out = path.join(dir(), "image.jpg");
  const promptFile = path.join(dir(), "prompt.txt");
  writeFileSync(promptFile, "a cat");
  const code = await main(["--engine", "agy", "--prompt-file", promptFile, "--out", out], { spawnImpl: succeeds() });
  assert.equal(code, 0);
  assert.equal(existsSync(out), true);
});

test("resolveAgyBin honours AGY_BIN and otherwise leaves the lookup to PATH", () => {
  assert.equal(resolveAgyBin({}), "agy");
  assert.equal(resolveAgyBin({ AGY_BIN: "  " }), "agy");
  assert.equal(resolveAgyBin({ AGY_BIN: "/opt/agy" }), "/opt/agy");
});

test("sniffMime reads the file's own header, not its name", () => {
  const d = dir();
  const jpg = path.join(d, "a.png");
  writeFileSync(jpg, JPEG);
  assert.equal(sniffMime(jpg), "image/jpeg");
  const junk = path.join(d, "b.jpg");
  writeFileSync(junk, "not an image");
  assert.equal(sniffMime(junk), undefined, "an unknown header must not be guessed into a rename");
});

test("a corrected extension can never land on top of an existing file", async () => {
  // The defect this pins: --out image.jpg + PNG bytes used to renameSync onto image.png,
  // a path reserveOut never checked. On POSIX that silently destroys it.
  const d = dir();
  const out = path.join(d, "image.jpg");
  const collision = path.join(d, "image.png");
  writeFileSync(collision, "SOMEONE ELSE'S WORK");
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, spawnImpl: succeeds(PNG) }),
    (e) => e instanceof ImageError && /already exists/.test(e.message) && /generated and billed/.test(e.message),
  );
  assert.equal(readFileSync(collision, "utf8"), "SOMEONE ELSE'S WORK", "the existing file must survive intact");
});

test("bytes that are not an image are a failed render, not a surprising one", async () => {
  // agy writing an error page, HTML, or prose to the path is the failure this engine has
  // to catch: reporting it as IMAGE_SAVED with exit 0 is the shape the plugin refuses.
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = succeeds(Buffer.from("<html>quota exceeded</html>"));
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, spawnImpl }),
    (e) => e instanceof ImageError && /not a JPEG or a PNG/.test(e.message),
  );
  assert.equal(existsSync(out), false, "nothing may be published from unrecognised bytes");
});

test("a timeout still honours the file on disk — the render may have finished mid-narration", async () => {
  // agy has been seen to render and then hang describing it. Rejecting on the timer would
  // throw away an image the user already paid for.
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(({ args }) => {
    writeFileSync(stagedPath(args), JPEG);
    return { hang: true };
  });
  const r = await generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl, FAST) });
  assert.equal(r.bytes, JPEG.length);
  assert.deepEqual(
    spawnImpl.signals.map((s) => s.sig),
    ["SIGTERM"],
    "the hung child is killed, not left running",
  );
  assert.ok(spawnImpl.signals[0].pid < 0, "the signal goes to the process GROUP, not just the leader");
});

test("a timeout with no file says so without claiming nothing was spent", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(() => ({ hang: true }));
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl, FAST) }),
    (e) =>
      e instanceof ImageError &&
      /did not finish within/.test(e.message) &&
      /may still have cost quota/.test(e.message) &&
      // The old message asserted "Nothing was saved", which it cannot know.
      !/Nothing was saved/.test(e.message),
  );
});

test("a child that ignores SIGTERM is escalated to SIGKILL", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(() => ({ hang: true, ignoresTerm: true }));
  await assert.rejects(() => generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl, FAST) }), (e) => e instanceof ImageError);
  assert.deepEqual(
    spawnImpl.signals.map((s) => s.sig),
    ["SIGTERM", "SIGKILL"],
  );
});

test("staging is cleaned up whichever way the run ends", async () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("imagine-agy-")).length;
  const out = path.join(dir(), "image.jpg");
  await generateWithAgy({ prompt: "a cat", out, spawnImpl: succeeds() });
  await assert.rejects(() => generateWithAgy({ prompt: "a cat", out: path.join(dir(), "x.jpg"), spawnImpl: fakeAgy(() => ({ code: 1 })) }));
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("imagine-agy-")).length;
  assert.equal(after, before, "no staging directory may outlive its run");
});

test("agy runs in its own process group — otherwise a group signal would hit us", async () => {
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = succeeds();
  await generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl) });
  assert.equal(spawnImpl.calls[0].opts.detached, true);
});

test("a tree that survives SIGKILL settles on our clock instead of hanging forever", async () => {
  // The measured case: a descendant holding the inherited pipes means `close` never
  // arrives, however hard the leader is signalled. Before this, the promise never settled.
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(() => ({ hang: true, deaf: true }));
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl, FAST) }),
    (e) => e instanceof ImageError && /did not exit even after SIGKILL/.test(e.message),
  );
  assert.deepEqual(
    spawnImpl.signals.map((s) => s.sig),
    ["SIGTERM", "SIGKILL"],
  );
});

test("staging is kept, not deleted, when the tree was never confirmed dead", async () => {
  // Deleting a directory a live renderer is still writing into destroys a paid render.
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(({ args }) => {
    writeFileSync(stagedPath(args), JPEG);
    return { hang: true, deaf: true };
  });
  const r = await generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl, FAST) });
  assert.equal(r.bytes, JPEG.length);
  assert.equal(existsSync(path.dirname(stagedPath(spawnImpl.calls[0].args))), true, "the staging dir must survive an unconfirmed kill");
});

test("a kill that raises synchronously does not leave a timer firing at a dead pid", async () => {
  // The escalation is armed BEFORE the signal. Armed after, a synchronous error would
  // settle the promise while leaving an unclearable timer holding the event loop open
  // for the whole grace period.
  const out = path.join(dir(), "image.jpg");
  const spawnImpl = fakeAgy(() => ({ hang: true, killEmitsErrorSync: true }));
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl, FAST) }),
    (e) => e instanceof ImageError && /could not run agy/.test(e.message),
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(
    spawnImpl.signals.map((s) => s.sig),
    ["SIGTERM"],
    "no SIGKILL may fire after the promise has already answered",
  );
});

test("a render that cannot be published is kept, not deleted", async () => {
  // A re-run costs quota and does not reproduce the image, so the bytes have to survive
  // the error path that reports the collision.
  const d = dir();
  const out = path.join(d, "image.jpg");
  writeFileSync(path.join(d, "image.png"), "TAKEN");
  const spawnImpl = succeeds(PNG);
  let staged;
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, ...withKill(spawnImpl) }),
    (e) => {
      staged = stagedPath(spawnImpl.calls[0].args);
      return e instanceof ImageError && e.message.includes(staged) && /will not reproduce/.test(e.message);
    },
  );
  assert.equal(existsSync(staged), true, "the billed render must outlive the error that reports it");
});

test("a staging directory that cannot be created fails as one line, not a stack", async (t) => {
  const prev = process.env.TMPDIR;
  t.after(() => {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  });
  // Resolve the destination BEFORE breaking TMPDIR — dir() stages under it too.
  const out = path.join(dir(), "image.jpg");
  process.env.TMPDIR = path.join(dir(), "no", "such", "place");
  await assert.rejects(
    () => generateWithAgy({ prompt: "a cat", out, spawnImpl: succeeds() }),
    (e) => e instanceof ImageError && /could not create a staging directory/.test(e.message) && /TMPDIR/.test(e.message),
  );
});
