import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../../plugins/fleet/scripts/fleet-doctor.mjs";

// A spawn stub that returns "ready" for any binary, so arg-parsing tests
// are independent of per-engine logic. Returns exit 0 with a version line.
function readySpawn() {
  return { status: 0, stdout: "stub 1.0.0\n", stderr: "", error: undefined, signal: null };
}

function baseEnv(extra = {}) {
  return { HOME: "/tmp/fleet-noexist-home", ...extra };
}

test("--only delegate,codex canonical re-sorts to codex,delegate", () => {
  const r = runDoctor(["--json", "--only", "delegate,codex"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
  });
  assert.equal(r.exitCode, 0);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.checkedEngines, ["codex", "delegate"]);
  assert.deepEqual(Object.keys(doc.engines), ["codex", "delegate"]);
  assert.ok(!("antigravity" in doc.engines), "antigravity must be absent");
});

test("--only codex,codex dedupes to a single codex", () => {
  const r = runDoctor(["--json", "--only", "codex,codex"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
  });
  assert.deepEqual(JSON.parse(r.stdout).checkedEngines, ["codex"]);
});

test("no --only checks all three in canonical order", () => {
  const r = runDoctor(["--json"], { spawnSyncImpl: readySpawn, env: baseEnv() });
  assert.deepEqual(JSON.parse(r.stdout).checkedEngines, ["codex", "antigravity", "delegate"]);
});

test("unknown engine under --json writes {error} to stdout and exits 2", () => {
  const r = runDoctor(["--json", "--only", "foo"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
  });
  assert.equal(r.exitCode, 2);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), {
    error: "unknown engine: foo; allowed: codex,antigravity,delegate",
  });
});

test("unknown engine without --json writes to stderr, stdout empty, exit 2", () => {
  const r = runDoctor(["--only", "foo"], { spawnSyncImpl: readySpawn, env: baseEnv() });
  assert.equal(r.exitCode, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unknown engine: foo; allowed: codex,antigravity,delegate/);
});

test("empty --only is a usage error (exit 2)", () => {
  const r = runDoctor(["--json", "--only", ""], { spawnSyncImpl: readySpawn, env: baseEnv() });
  assert.equal(r.exitCode, 2);
  assert.match(JSON.parse(r.stdout).error, /--only requires/);
});

test("unknown flag is a usage error (exit 2)", () => {
  const r = runDoctor(["--json", "--bogus"], { spawnSyncImpl: readySpawn, env: baseEnv() });
  assert.equal(r.exitCode, 2);
  assert.match(JSON.parse(r.stdout).error, /unknown flag: --bogus/);
});
