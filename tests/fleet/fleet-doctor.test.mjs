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

import { probeBinary } from "../../plugins/fleet/scripts/fleet-doctor.mjs";

function spawnReturning(result) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return result;
  };
  fn.calls = calls;
  return fn;
}

test("probeBinary: status 0 → ok, found, version is first non-empty trimmed line", () => {
  const spawn = spawnReturning({ status: 0, stdout: "\n  codex-cli 0.42.1 \n\n", stderr: "" });
  const r = probeBinary("codex", { spawnSyncImpl: spawn });
  assert.deepEqual(r, { ok: true, found: true, reason: null, version: "codex-cli 0.42.1" });
  assert.deepEqual(spawn.calls[0].args, ["--version"]);
  assert.equal(spawn.calls[0].opts.timeout, 5000);
  assert.equal(spawn.calls[0].opts.input, "");
  assert.equal(spawn.calls[0].opts.encoding, "utf8");
});

test("probeBinary: args are passed through (app-server probe shape)", () => {
  const spawn = spawnReturning({ status: 0, stdout: "usage...\n", stderr: "" });
  const r = probeBinary("codex", { spawnSyncImpl: spawn }, ["app-server", "--help"]);
  assert.equal(r.ok, true);
  assert.deepEqual(spawn.calls[0].args, ["app-server", "--help"]);
});

test("probeBinary clause 1: ENOENT → not found, reason missing, version null", () => {
  const spawn = spawnReturning({ error: { code: "ENOENT" }, status: null });
  const r = probeBinary("codex", { spawnSyncImpl: spawn });
  assert.deepEqual(r, { ok: false, found: false, reason: "missing", version: null });
});

test("probeBinary clause 2: ETIMEDOUT (Node timeout shape) → found but version-failed (NOT missing)", () => {
  // Measured Node spawnSync timeout shape.
  const spawn = spawnReturning({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } });
  const r = probeBinary("codex", { spawnSyncImpl: spawn });
  assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
});

test("probeBinary clause 2: a non-ENOENT error with null status → found but version-failed", () => {
  const spawn = spawnReturning({ error: { code: "EACCES" }, status: null });
  const r = probeBinary("codex", { spawnSyncImpl: spawn });
  assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
});

test("probeBinary clause 2: signal set → found but version-failed", () => {
  const spawn = spawnReturning({ status: null, signal: "SIGKILL" });
  const r = probeBinary("codex", { spawnSyncImpl: spawn });
  assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
});

test("probeBinary clause 2: status 1 (no error) → found but version-failed", () => {
  const spawn = spawnReturning({ status: 1, stdout: "boom", stderr: "" });
  const r = probeBinary("codex", { spawnSyncImpl: spawn });
  assert.deepEqual(r, { ok: false, found: true, reason: "version-failed", version: null });
});

// ---------------------------------------------------------------------------
// Task 4: checkCodex — two probes (version + app-server)
// ---------------------------------------------------------------------------

// Drives a codex-only run with separate results for the two probes.
// versionResult answers ["--version"]; appServerResult answers ["app-server","--help"].
// Returns { doc, appServerSpawned } so tests can assert the probe was/ wasn't run.
function onlyCodexTwoProbe(versionResult, appServerResult) {
  let appServerSpawned = false;
  const spawn = (bin, args) => {
    if (Array.isArray(args) && args[0] === "app-server") {
      appServerSpawned = true;
      return appServerResult ?? { status: 0, stdout: "usage\n", stderr: "" };
    }
    return versionResult;
  };
  const doc = JSON.parse(
    runDoctor(["--json", "--only", "codex"], {
      spawnSyncImpl: spawn,
      env: { HOME: "/tmp/fleet-noexist-home" },
    }).stdout,
  );
  return { doc, appServerSpawned: () => appServerSpawned };
}

test("codex ready requires BOTH probes exit 0", () => {
  const { doc, appServerSpawned } = onlyCodexTwoProbe(
    { status: 0, stdout: "codex-cli 0.42.1\n", stderr: "" },
    { status: 0, stdout: "usage\n", stderr: "" },
  );
  const c = doc.engines.codex;
  assert.equal(c.engine, "codex");
  assert.equal(c.status, "ready");
  assert.equal(c.reason, null);
  assert.equal(c.binaryName, "codex");
  assert.equal(c.onPath, true);
  assert.equal(c.appServerAvailable, true);
  assert.equal(c.version, "codex-cli 0.42.1");
  assert.equal(c.authVerified, false);
  assert.equal(c.deepFixCommand, null);
  assert.ok(c.summary.length > 0);
  assert.equal(appServerSpawned(), true);
});

test("codex binary-missing → app-server probe SKIPPED", () => {
  const { doc, appServerSpawned } = onlyCodexTwoProbe({ error: { code: "ENOENT" }, status: null });
  const c = doc.engines.codex;
  assert.equal(c.status, "not-ready");
  assert.equal(c.reason, "binary-missing");
  assert.equal(c.onPath, false);
  assert.equal(c.appServerAvailable, false);
  assert.equal(c.version, null);
  assert.equal(c.authVerified, false);
  assert.equal(c.deepFixCommand, "/codex:setup");
  assert.equal(appServerSpawned(), false, "app-server probe must be skipped when binary-missing");
});

test("codex version-failed (status 1) → app-server probe SKIPPED", () => {
  const { doc, appServerSpawned } = onlyCodexTwoProbe({ status: 1, stdout: "", stderr: "boom" });
  const c = doc.engines.codex;
  assert.equal(c.status, "not-ready");
  assert.equal(c.reason, "version-failed");
  assert.equal(c.onPath, true);
  assert.equal(c.appServerAvailable, false);
  assert.equal(c.version, null);
  assert.equal(c.deepFixCommand, "/codex:setup");
  assert.equal(appServerSpawned(), false, "app-server probe must be skipped when version-failed");
});

test("codex version-failed (timeout shape) → app-server probe SKIPPED", () => {
  const { doc, appServerSpawned } = onlyCodexTwoProbe({
    status: null,
    signal: "SIGTERM",
    error: { code: "ETIMEDOUT" },
  });
  assert.equal(doc.engines.codex.reason, "version-failed");
  assert.equal(doc.engines.codex.onPath, true);
  assert.equal(doc.engines.codex.appServerAvailable, false);
  assert.equal(appServerSpawned(), false);
});

test("codex app-server-failed: --version ok but app-server --help status 1", () => {
  const { doc, appServerSpawned } = onlyCodexTwoProbe(
    { status: 0, stdout: "codex-cli 0.42.1\n", stderr: "" },
    { status: 1, stdout: "", stderr: "x" },
  );
  const c = doc.engines.codex;
  assert.equal(c.status, "not-ready");
  assert.equal(c.reason, "app-server-failed");
  assert.equal(c.onPath, true);
  assert.equal(c.appServerAvailable, false);
  assert.equal(c.version, "codex-cli 0.42.1"); // version populated (--version succeeded)
  assert.equal(c.authVerified, false);
  assert.equal(c.deepFixCommand, "/codex:setup");
  assert.equal(appServerSpawned(), true);
});

test("codex app-server-failed on ETIMEDOUT and ENOENT of the app-server probe", () => {
  for (const appResult of [
    { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } },
    { error: { code: "ENOENT" }, status: null },
  ]) {
    const { doc } = onlyCodexTwoProbe(
      { status: 0, stdout: "codex-cli 0.42.1\n", stderr: "" },
      appResult,
    );
    const c = doc.engines.codex;
    assert.equal(c.status, "not-ready");
    assert.equal(c.reason, "app-server-failed");
    assert.equal(c.appServerAvailable, false);
    assert.equal(c.version, "codex-cli 0.42.1");
  }
});
