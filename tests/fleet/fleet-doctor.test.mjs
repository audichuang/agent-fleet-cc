import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../../plugins/fleet/scripts/fleet-doctor.mjs";
import { writeProfile, makeDataRoot } from "./helpers.mjs";
import { PROFILE_NAME_RE } from "../../plugins/fleet/scripts/fleet-doctor.mjs";

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

// ---------------------------------------------------------------------------
// Task 5: checkAntigravity — inline resolveAgyBin + existsSync seam
// ---------------------------------------------------------------------------

// Drives an antigravity-only run with stubbed existence + spawn. `exists` is a
// Set of paths that "exist"; `spawnByBin` maps the resolved binPath → spawn result.
function onlyAgy({ env = {}, exists = [], spawnByBin = {}, defaultSpawn } = {}) {
  const existsSet = new Set(exists);
  let spawnedBin = null;
  const spawn = (bin) => {
    spawnedBin = bin;
    return spawnByBin[bin] ?? defaultSpawn ?? { status: 0, stdout: "agy 1.0\n", stderr: "" };
  };
  const doc = JSON.parse(
    runDoctor(["--json", "--only", "antigravity"], {
      spawnSyncImpl: spawn,
      existsSyncImpl: (p) => existsSet.has(p),
      env: { HOME: "/home/u", ...env },
    }).stdout,
  );
  return { a: doc.engines.antigravity, spawnedBin: () => spawnedBin };
}

test("antigravity resolves via AGY_BIN", () => {
  const { a, spawnedBin } = onlyAgy({
    env: { AGY_BIN: "/opt/agy", PATH: "/usr/bin" },
    exists: ["/opt/agy"],
    spawnByBin: { "/opt/agy": { status: 0, stdout: "agy 2.3.0\n", stderr: "" } },
  });
  assert.equal(a.status, "ready");
  assert.equal(a.binPath, "/opt/agy");
  assert.equal(a.resolvedFrom, "AGY_BIN");
  assert.equal(a.binaryName, "agy");
  assert.equal(a.onPath, true);
  assert.equal(a.version, "agy 2.3.0");
  assert.equal(a.authVerified, false);
  assert.equal(a.installUrl, "https://antigravity.google/download");
  assert.equal(spawnedBin(), "/opt/agy");
});

test("antigravity resolves via PATH (first existing dir wins)", () => {
  const { a } = onlyAgy({
    env: { PATH: "/a:/b" }, // no AGY_BIN
    exists: ["/b/agy"], // /a/agy does not exist
    spawnByBin: { "/b/agy": { status: 0, stdout: "agy 1.1\n", stderr: "" } },
  });
  assert.equal(a.status, "ready");
  assert.equal(a.binPath, "/b/agy");
  assert.equal(a.resolvedFrom, "PATH");
});

test("antigravity PATH empty-segment safety — leading/trailing/double colon is skipped", () => {
  // A bare-'agy' match via an empty segment would be join('', 'agy') === 'agy'.
  // The .filter(Boolean) must skip empty segments so we never test existsSync('agy').
  const seenExistsArgs = [];
  const doc = JSON.parse(
    runDoctor(["--json", "--only", "antigravity"], {
      spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
      existsSyncImpl: (p) => {
        seenExistsArgs.push(p);
        return false;
      },
      env: { HOME: "/home/u", PATH: ":/x::/y" },
    }).stdout,
  );
  assert.ok(!seenExistsArgs.includes("agy"), "must not probe a bare 'agy' from an empty PATH segment");
  assert.equal(doc.engines.antigravity.resolvedFrom, "default");
});

test("antigravity resolves via HOME ~/.local/bin/agy fallback", () => {
  const { a } = onlyAgy({
    env: { HOME: "/home/u", PATH: "/a" }, // no AGY_BIN, no agy on PATH
    exists: ["/home/u/.local/bin/agy"],
    spawnByBin: { "/home/u/.local/bin/agy": { status: 0, stdout: "agy 1.4\n", stderr: "" } },
  });
  assert.equal(a.status, "ready");
  assert.equal(a.binPath, "/home/u/.local/bin/agy");
  assert.equal(a.resolvedFrom, "home-fallback");
});

test("antigravity AGY_BIN that does not exist falls through (not AGY_BIN)", () => {
  const { a } = onlyAgy({
    env: { AGY_BIN: "/opt/agy", PATH: "/a" },
    exists: ["/a/agy"], // AGY_BIN path NOT in exists; /a/agy is
    spawnByBin: { "/a/agy": { status: 0, stdout: "agy 1.0\n", stderr: "" } },
  });
  assert.equal(a.resolvedFrom, "PATH");
  assert.equal(a.binPath, "/a/agy");
});

test("antigravity empty/unset AGY_BIN never calls existsSync('')", () => {
  const seenExistsArgs = [];
  const doc = JSON.parse(
    runDoctor(["--json", "--only", "antigravity"], {
      spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
      existsSyncImpl: (p) => {
        seenExistsArgs.push(p);
        return false;
      },
      env: { HOME: "/home/u", AGY_BIN: "", PATH: "/a" },
    }).stdout,
  );
  assert.ok(!seenExistsArgs.includes(""), "must not call existsSync('') for empty AGY_BIN");
  assert.equal(doc.engines.antigravity.resolvedFrom, "default");
});

test("antigravity binary-missing when none — default + ENOENT carries installUrl", () => {
  const { a } = onlyAgy({
    env: { HOME: "/home/u", PATH: "/a:/b" },
    exists: [], // nothing exists anywhere
    defaultSpawn: { error: { code: "ENOENT" }, status: null },
  });
  assert.equal(a.status, "not-ready");
  assert.equal(a.reason, "binary-missing");
  assert.equal(a.binPath, "agy");
  assert.equal(a.resolvedFrom, "default");
  assert.equal(a.onPath, false);
  assert.equal(a.version, null);
  assert.equal(a.installUrl, "https://antigravity.google/download");
  assert.equal(a.deepFixCommand, "/antigravity:setup");
  assert.equal(a.authVerified, false);
});

test("antigravity version-failed: resolved path launched but --version failed", () => {
  const { a } = onlyAgy({
    env: { PATH: "/a" },
    exists: ["/a/agy"],
    spawnByBin: { "/a/agy": { status: 7, stdout: "", stderr: "x" } },
  });
  assert.equal(a.status, "not-ready");
  assert.equal(a.reason, "version-failed");
  assert.equal(a.onPath, true);
  assert.equal(a.binPath, "/a/agy");
  assert.equal(a.resolvedFrom, "PATH");
  assert.equal(a.version, null);
  assert.equal(a.deepFixCommand, "/antigravity:setup");
});

test("antigravity version-failed: resolved real path but spawn ENOENT (NOT binary-missing)", () => {
  // existsSync resolved /a/agy, but the spawn ENOENTs. Because a real path was
  // resolved (resolvedFrom !== "default"), this is version-failed, NOT binary-missing.
  const { a } = onlyAgy({
    env: { PATH: "/a" },
    exists: ["/a/agy"],
    spawnByBin: { "/a/agy": { error: { code: "ENOENT" }, status: null } },
  });
  assert.equal(a.status, "not-ready");
  assert.equal(a.reason, "version-failed");
  assert.equal(a.resolvedFrom, "PATH");
  assert.equal(a.onPath, true);
  assert.equal(a.binPath, "/a/agy");
  assert.equal(a.deepFixCommand, "/antigravity:setup");
});

// ---------------------------------------------------------------------------
// Task 6: checkDelegate — DELEGATE_CLAUDE_BIN override, cliRunnable
// ---------------------------------------------------------------------------

function onlyDelegate(spawnResult, env = {}) {
  const spawn = (bin, args, opts) => {
    onlyDelegate._lastBin = bin;
    return spawnResult;
  };
  return {
    doc: JSON.parse(
      runDoctor(["--json", "--only", "delegate"], {
        spawnSyncImpl: spawn,
        env: { HOME: "/tmp/fleet-noexist-home", ...env },
      }).stdout,
    ),
    lastBin: () => onlyDelegate._lastBin,
  };
}

test("delegate cli-missing (ENOENT) → cliRunnable false", () => {
  const { doc } = onlyDelegate({ error: { code: "ENOENT" }, status: null });
  const d = doc.engines.delegate;
  assert.equal(d.status, "not-ready");
  assert.equal(d.reason, "cli-missing");
  assert.equal(d.cliRunnable, false);
  assert.equal(d.cliVersion, null);
  assert.equal(d.binaryName, "claude");
  assert.equal(d.authVerified, false);
  assert.equal(d.deepFixCommand, "/delegate:setup");
  // §5.4 delegate field shape must stay uniform even on the cli-missing leg
  // (no profile discovery happens, but the keys must be present).
  assert.equal(typeof d.dataRoot, "string");
  assert.ok(Array.isArray(d.profiles));
  assert.equal(d.validProfileCount, 0);
  assert.equal(d.firstValidProfile, null);
});

test("delegate cli-version-failed (status 1) → cliRunnable false, cliVersion null", () => {
  const { doc } = onlyDelegate({ status: 1, stdout: "", stderr: "x" });
  const d = doc.engines.delegate;
  assert.equal(d.reason, "cli-version-failed");
  assert.equal(d.cliRunnable, false);
  assert.equal(d.cliVersion, null);
});

test("delegate honors DELEGATE_CLAUDE_BIN override for binaryName and spawn", () => {
  const { doc, lastBin } = onlyDelegate(
    { error: { code: "ENOENT" }, status: null },
    { DELEGATE_CLAUDE_BIN: "/opt/bin/claude" },
  );
  assert.equal(doc.engines.delegate.binaryName, "/opt/bin/claude");
  assert.equal(lastBin(), "/opt/bin/claude");
});

// ---------------------------------------------------------------------------
// Task 7: delegate profile discovery + validation + readiness gate
// ---------------------------------------------------------------------------

function delegateWith(dataRoot, spawnResult = { status: 0, stdout: "claude 1.2.3\n", stderr: "" }) {
  return JSON.parse(
    runDoctor(["--json", "--only", "delegate"], {
      spawnSyncImpl: () => spawnResult,
      env: { HOME: "/tmp/fleet-noexist-home", DELEGATE_PLUGIN_DATA: dataRoot },
    }).stdout,
  ).engines.delegate;
}

test("PROFILE_NAME_RE rejects leading . _ - and spaces; accepts normal names", () => {
  assert.ok(PROFILE_NAME_RE.test("work"));
  assert.ok(PROFILE_NAME_RE.test("work.prod-1_x"));
  assert.ok(!PROFILE_NAME_RE.test(".hidden"));
  assert.ok(!PROFILE_NAME_RE.test("_foo"));
  assert.ok(!PROFILE_NAME_RE.test("-foo"));
  assert.ok(!PROFILE_NAME_RE.test("a b"));
});

test("delegate ready: CLI ok + 1 valid profile (authVerified false)", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "work", { env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_MODEL: "m" } });
  const d = delegateWith(dataRoot);
  assert.equal(d.status, "ready");
  assert.equal(d.reason, null);
  assert.equal(d.cliRunnable, true);
  assert.equal(d.cliVersion, "claude 1.2.3");
  assert.equal(d.validProfileCount, 1);
  assert.equal(d.firstValidProfile, "work");
  assert.deepEqual(d.profiles, []);
  assert.equal(d.deepFixCommand, null);
  assert.equal(d.authVerified, false);
});

test("delegate no-profiles: CLI ok, empty dir", () => {
  const dataRoot = makeDataRoot();
  const d = delegateWith(dataRoot);
  assert.equal(d.status, "not-ready");
  assert.equal(d.reason, "no-profiles");
  assert.equal(d.validProfileCount, 0);
  assert.equal(d.firstValidProfile, null);
});

test("delegate no-valid-profiles: nested-object env, ARRAY env, unparseable JSON", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "nested", { env: { X: {} } });
  writeProfile(dataRoot, "arr", { env: ["x"] }); // an ARRAY env is invalid
  writeProfile(dataRoot, "broken", "{ not json");
  const d = delegateWith(dataRoot);
  assert.equal(d.status, "not-ready");
  assert.equal(d.reason, "no-valid-profiles");
  assert.equal(d.validProfileCount, 0);
  const byName = Object.fromEntries(d.profiles.map((p) => [p.name, p.error]));
  assert.equal(byName.nested, "non-scalar-env");
  assert.equal(byName.arr, "non-scalar-env"); // Array.isArray(env) rejected
  assert.equal(byName.broken, "unparseable-json");
});

test("delegate invalid-name: leading-underscore basename skipped before parse", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "_foo", { env: { X: "ok" } }); // would be valid if parsed
  writeProfile(dataRoot, "good", { env: { X: "ok" } });
  const d = delegateWith(dataRoot);
  assert.equal(d.status, "ready"); // "good" is valid
  assert.equal(d.validProfileCount, 1);
  assert.equal(d.firstValidProfile, "good");
  const bad = d.profiles.find((p) => p.name === "_foo");
  assert.equal(bad.error, "invalid-name");
});

test("delegate firstValidProfile is basename-sorted", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "zeta", { env: { X: "ok" } });
  writeProfile(dataRoot, "alpha", { env: { X: "ok" } });
  const d = delegateWith(dataRoot);
  assert.equal(d.firstValidProfile, "alpha");
  assert.equal(d.validProfileCount, 2);
});

test("delegate scalar env values (string/number/boolean/null) are valid", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "scalars", { env: { S: "x", N: 1, B: true, Z: null } });
  const d = delegateWith(dataRoot);
  assert.equal(d.status, "ready");
  assert.equal(d.validProfileCount, 1);
});

test("delegate default dataRoot derives from env.HOME, not os.homedir()", () => {
  const fakeHome = makeDataRoot(); // any temp dir path
  const d = JSON.parse(
    runDoctor(["--json", "--only", "delegate"], {
      spawnSyncImpl: () => ({ status: 0, stdout: "claude 1\n", stderr: "" }),
      env: { HOME: fakeHome }, // no DELEGATE_PLUGIN_DATA / CLAUDE_PLUGIN_DATA
    }).stdout,
  ).engines.delegate;
  assert.equal(d.dataRoot, `${fakeHome}/.claude/plugins/data/delegate`);
});
