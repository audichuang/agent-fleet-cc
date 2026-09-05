import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

function commitInitial(repo) {
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

// `sandbox-mode.test.mjs` covers `resolveSandboxMode` — a pure function. Nothing covered
// what the plugin actually PUTS ON THE WIRE, and the two are joined only by
// `buildThreadParams` / `buildResumeParams`, which are not exported and so cannot be
// called from a test at all.
//
// That left the load-bearing invariant of this fork unguarded. `resolveSandboxMode`
// ignores its own argument on purpose: these hosts cannot start Codex's bwrap sandbox,
// so every thread must go out as `danger-full-access` with `approvalPolicy: "never"` or
// even a read-only turn aborts. A tidy-up that looks entirely reasonable in review —
// `sandbox: options.sandbox ?? "danger-full-access"`, "respect the caller" — keeps the
// whole suite green while breaking every real run, because the fake fixture used to
// discard both fields and answer with a hardcoded `readOnly` reply that contradicts
// what it was sent. Trusting that reply teaches a test nothing.
//
// So these assert on the params the fixture RECEIVED, recorded verbatim at
// `thread/start` and `thread/resume`. Proven to bite: changing either builder in
// `codex.mjs` to honour a caller-supplied value reddens this file and nothing else.

function runTask(behavior, args) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", ...args], { cwd: repo, env: buildEnv(binDir) });
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  return { result, state };
}

test("thread/start goes out with full access and no approval gate", () => {
  const { state } = runTask("review-ok", ["do the thing"]);

  const started = state.threads.filter((thread) => thread.wireStart);
  assert.ok(started.length >= 1, "the run must have opened at least one thread");

  for (const thread of started) {
    assert.equal(
      thread.wireStart.sandbox,
      "danger-full-access",
      "these hosts cannot start bwrap; anything narrower aborts the turn on a real engine"
    );
    assert.equal(thread.wireStart.approvalPolicy, "never");
  }
});

// `--write` is job metadata and grants no isolation — omitting it must not quietly
// become a read-only run, because a read-only run is exactly what dies here. Four prose
// surfaces once said otherwise at the same time; this is the executable version of that
// correction.
test("omitting --write does not narrow the sandbox on the wire", () => {
  const withWrite = runTask("review-ok", ["--write", "do the thing"]);
  const withoutWrite = runTask("review-ok", ["do the thing"]);

  const sandboxOf = ({ state }) => state.threads.find((thread) => thread.wireStart)?.wireStart?.sandbox;

  assert.equal(sandboxOf(withWrite), "danger-full-access");
  assert.equal(
    sandboxOf(withoutWrite),
    "danger-full-access",
    "omitting --write marks the job non-editing; it must not change the thread's isolation"
  );
});

test("thread/resume carries the same isolation as thread/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  initGitRepo(repo);
  commitInitial(repo);
  const env = buildEnv(binDir);

  run("node", [SCRIPT, "task", "first"], { cwd: repo, env });
  run("node", [SCRIPT, "task", "--resume-last", "second"], { cwd: repo, env });

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  const resumed = state.threads.filter((thread) => thread.wireResume);
  assert.ok(
    resumed.length >= 1,
    "the resume run must have gone through thread/resume — without that this test proves nothing"
  );

  for (const thread of resumed) {
    assert.equal(thread.wireResume.sandbox, "danger-full-access");
    assert.equal(thread.wireResume.approvalPolicy, "never");
  }
});
