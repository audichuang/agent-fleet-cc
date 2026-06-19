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

test("--only cc,codex canonical re-sorts to codex,cc", () => {
  const r = runDoctor(["--json", "--only", "cc,codex"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
  });
  assert.equal(r.exitCode, 0);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(doc.checkedEngines, ["codex", "cc"]);
  assert.deepEqual(Object.keys(doc.engines), ["codex", "cc"]);
  assert.ok(!("antigravity" in doc.engines), "antigravity must be absent");
});

test("raw quoted slash arguments are split in-process", () => {
  const r = runDoctor(["--json --only cc,codex"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout).checkedEngines, ["codex", "cc"]);
});

test("--raw-args-stdin reads safely quoted slash arguments from stdin", () => {
  const r = runDoctor(["--raw-args-stdin"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
    readStdinImpl: () => "--json --only cc,codex\n",
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout).checkedEngines, ["codex", "cc"]);
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
  assert.deepEqual(JSON.parse(r.stdout).checkedEngines, ["codex", "antigravity", "cc"]);
});

test("unknown engine under --json writes {error} to stdout and exits 2", () => {
  const r = runDoctor(["--json", "--only", "foo"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
  });
  assert.equal(r.exitCode, 2);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), {
    error: "unknown engine: foo; allowed: codex,antigravity,cc",
  });
});

test("raw quoted slash usage errors still honor --json", () => {
  const r = runDoctor(["--json --only foo"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
  });
  assert.equal(r.exitCode, 2);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), {
    error: "unknown engine: foo; allowed: codex,antigravity,cc",
  });
});

test("--raw-args-stdin usage errors still honor --json", () => {
  const r = runDoctor(["--raw-args-stdin"], {
    spawnSyncImpl: readySpawn,
    env: baseEnv(),
    readStdinImpl: () => "--json --only foo\n",
  });
  assert.equal(r.exitCode, 2);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), {
    error: "unknown engine: foo; allowed: codex,antigravity,cc",
  });
});

test("unknown engine without --json writes to stderr, stdout empty, exit 2", () => {
  const r = runDoctor(["--only", "foo"], { spawnSyncImpl: readySpawn, env: baseEnv() });
  assert.equal(r.exitCode, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unknown engine: foo; allowed: codex,antigravity,cc/);
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
// Task 6: checkCc — CC_CLAUDE_BIN override, cliRunnable
// ---------------------------------------------------------------------------

function onlyCc(spawnResult, env = {}) {
  const spawn = (bin, args, opts) => {
    onlyCc._lastBin = bin;
    return spawnResult;
  };
  return {
    doc: JSON.parse(
      runDoctor(["--json", "--only", "cc"], {
        spawnSyncImpl: spawn,
        env: { HOME: "/tmp/fleet-noexist-home", ...env },
      }).stdout,
    ),
    lastBin: () => onlyCc._lastBin,
  };
}

test("cc cli-missing (ENOENT) → cliRunnable false", () => {
  const { doc } = onlyCc({ error: { code: "ENOENT" }, status: null });
  const d = doc.engines.cc;
  assert.equal(d.status, "not-ready");
  assert.equal(d.reason, "cli-missing");
  assert.equal(d.cliRunnable, false);
  assert.equal(d.cliVersion, null);
  assert.equal(d.binaryName, "claude");
  assert.equal(d.authVerified, false);
  assert.equal(d.deepFixCommand, "/cc:setup");
  // §5.4 cc field shape must stay uniform even on the cli-missing leg
  // (no profile discovery happens, but the keys must be present).
  assert.equal(typeof d.dataRoot, "string");
  assert.ok(Array.isArray(d.profiles));
  assert.equal(d.validProfileCount, 0);
  assert.equal(d.firstValidProfile, null);
});

test("cc cli-version-failed (status 1) → cliRunnable false, cliVersion null", () => {
  const { doc } = onlyCc({ status: 1, stdout: "", stderr: "x" });
  const d = doc.engines.cc;
  assert.equal(d.reason, "cli-version-failed");
  assert.equal(d.cliRunnable, false);
  assert.equal(d.cliVersion, null);
});

test("cc honors CC_CLAUDE_BIN override for binaryName and spawn", () => {
  const { doc, lastBin } = onlyCc(
    { error: { code: "ENOENT" }, status: null },
    { CC_CLAUDE_BIN: "/opt/bin/claude" },
  );
  assert.equal(doc.engines.cc.binaryName, "/opt/bin/claude");
  assert.equal(lastBin(), "/opt/bin/claude");
});

// ---------------------------------------------------------------------------
// Task 7: cc profile discovery + validation + readiness gate
// ---------------------------------------------------------------------------

function ccWith(dataRoot, spawnResult = { status: 0, stdout: "claude 1.2.3\n", stderr: "" }) {
  return JSON.parse(
    runDoctor(["--json", "--only", "cc"], {
      spawnSyncImpl: () => spawnResult,
      env: { HOME: "/tmp/fleet-noexist-home", CC_PLUGIN_DATA: dataRoot },
    }).stdout,
  ).engines.cc;
}

test("PROFILE_NAME_RE rejects leading . _ - and spaces; accepts normal names", () => {
  assert.ok(PROFILE_NAME_RE.test("work"));
  assert.ok(PROFILE_NAME_RE.test("work.prod-1_x"));
  assert.ok(!PROFILE_NAME_RE.test(".hidden"));
  assert.ok(!PROFILE_NAME_RE.test("_foo"));
  assert.ok(!PROFILE_NAME_RE.test("-foo"));
  assert.ok(!PROFILE_NAME_RE.test("a b"));
});

test("cc ready: CLI ok + 1 valid profile (authVerified false)", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "work", { env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_MODEL: "m" } });
  const d = ccWith(dataRoot);
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

test("cc no-profiles: CLI ok, empty dir", () => {
  const dataRoot = makeDataRoot();
  const d = ccWith(dataRoot);
  assert.equal(d.status, "not-ready");
  assert.equal(d.reason, "no-profiles");
  assert.equal(d.validProfileCount, 0);
  assert.equal(d.firstValidProfile, null);
});

test("cc no-valid-profiles: nested-object env, ARRAY env, unparseable JSON", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "nested", { env: { X: {} } });
  writeProfile(dataRoot, "arr", { env: ["x"] }); // an ARRAY env is invalid
  writeProfile(dataRoot, "broken", "{ not json");
  const d = ccWith(dataRoot);
  assert.equal(d.status, "not-ready");
  assert.equal(d.reason, "no-valid-profiles");
  assert.equal(d.validProfileCount, 0);
  const byName = Object.fromEntries(d.profiles.map((p) => [p.name, p.error]));
  assert.equal(byName.nested, "non-scalar-env");
  assert.equal(byName.arr, "non-scalar-env"); // Array.isArray(env) rejected
  assert.equal(byName.broken, "unparseable-json");
});

test("cc invalid-name: leading-underscore basename skipped before parse", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "_foo", { env: { X: "ok" } }); // would be valid if parsed
  writeProfile(dataRoot, "good", { env: { X: "ok" } });
  const d = ccWith(dataRoot);
  assert.equal(d.status, "ready"); // "good" is valid
  assert.equal(d.validProfileCount, 1);
  assert.equal(d.firstValidProfile, "good");
  const bad = d.profiles.find((p) => p.name === "_foo");
  assert.equal(bad.error, "invalid-name");
});

test("cc firstValidProfile is basename-sorted", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "zeta", { env: { X: "ok" } });
  writeProfile(dataRoot, "alpha", { env: { X: "ok" } });
  const d = ccWith(dataRoot);
  assert.equal(d.firstValidProfile, "alpha");
  assert.equal(d.validProfileCount, 2);
});

test("cc scalar env values (string/number/boolean/null) are valid", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "scalars", { env: { S: "x", N: 1, B: true, Z: null } });
  const d = ccWith(dataRoot);
  assert.equal(d.status, "ready");
  assert.equal(d.validProfileCount, 1);
});

test("cc default dataRoot derives from env.HOME, not os.homedir()", () => {
  const fakeHome = makeDataRoot(); // any temp dir path
  const d = JSON.parse(
    runDoctor(["--json", "--only", "cc"], {
      spawnSyncImpl: () => ({ status: 0, stdout: "claude 1\n", stderr: "" }),
      env: { HOME: fakeHome }, // no CC_PLUGIN_DATA / CLAUDE_PLUGIN_DATA
    }).stdout,
  ).engines.cc;
  assert.equal(d.dataRoot, `${fakeHome}/.claude/plugins/data/cc`);
});

// ---------------------------------------------------------------------------
// Task 8: top-level assembly — allReady, --only map filtering, schema invariants
// ---------------------------------------------------------------------------

function allReadyDoc() {
  // codex (both probes) + antigravity probe ready; cc ready needs a valid profile.
  // antigravity resolves via the bare default; spawn returns status 0 so it is ready.
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "work", { env: { ANTHROPIC_AUTH_TOKEN: "t" } });
  return JSON.parse(
    runDoctor(["--json"], {
      spawnSyncImpl: () => ({ status: 0, stdout: "v 1.0\n", stderr: "" }),
      existsSyncImpl: () => false, // antigravity falls through to bare "agy", which spawns ok
      env: { HOME: "/tmp/fleet-noexist-home", CC_PLUGIN_DATA: dataRoot },
    }).stdout,
  );
}

function allNotReadyDoc() {
  // Every probe ENOENT (codex/antigravity binary-missing, cc cli-missing);
  // cc dataRoot empty. No engine is ready.
  const emptyRoot = makeDataRoot();
  return JSON.parse(
    runDoctor(["--json"], {
      spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
      existsSyncImpl: () => false,
      env: { HOME: "/tmp/fleet-noexist-home", CC_PLUGIN_DATA: emptyRoot },
    }).stdout,
  );
}

test("allReady is true only when every checked engine is ready", () => {
  const doc = allReadyDoc();
  assert.equal(doc.allReady, true);
  assert.deepEqual(doc.checkedEngines, ["codex", "antigravity", "cc"]);

  // Flip cc to not-ready by withholding profiles.
  const emptyRoot = makeDataRoot();
  const doc2 = JSON.parse(
    runDoctor(["--json"], {
      spawnSyncImpl: () => ({ status: 0, stdout: "v 1.0\n", stderr: "" }),
      existsSyncImpl: () => false,
      env: { HOME: "/tmp/fleet-noexist-home", CC_PLUGIN_DATA: emptyRoot },
    }).stdout,
  );
  assert.equal(doc2.allReady, false);
});

test("--only filters the engines map to exactly the checked keys (canonical insertion order)", () => {
  const doc = JSON.parse(
    runDoctor(["--json", "--only", "codex,cc"], {
      spawnSyncImpl: () => ({ status: 0, stdout: "v 1.0\n", stderr: "" }),
      env: { HOME: "/tmp/fleet-noexist-home", CC_PLUGIN_DATA: makeDataRoot() },
    }).stdout,
  );
  assert.deepEqual(doc.checkedEngines, ["codex", "cc"]);
  // unsorted: pins the canonical INSERTION order of the engines map keys.
  assert.deepEqual(Object.keys(doc.engines), ["codex", "cc"]);
  assert.ok(!("antigravity" in doc.engines));
});

function assertSchemaInvariants(doc) {
  assert.ok(!("schemaVersion" in doc));
  for (const name of doc.checkedEngines) {
    const e = doc.engines[name];
    assert.equal(e.engine, name);
    assert.equal(e.category, "core");
    assert.equal(typeof e.fixHint, "string");
    assert.ok(e.fixHint.length > 0);
    assert.ok(e.fixCommand === null || typeof e.fixCommand === "string");
    assert.equal(e.fixCommand, e.deepFixCommand);
    assert.ok(e.status === "ready" || e.status === "not-ready");
    // authVerified is ALWAYS present and ALWAYS false (never true, even when ready).
    assert.equal(e.authVerified, false);
    assert.equal(typeof e.summary, "string");
    assert.ok(e.summary.length > 0);
    if (e.status === "ready") {
      assert.equal(e.reason, null);
      assert.equal(e.deepFixCommand, null);
    } else {
      assert.notEqual(e.reason, null);
      assert.notEqual(e.deepFixCommand, null);
    }
    // Per-engine fields present on EVERY verdict (catches undefined regressions).
    if (name === "codex") assert.equal(typeof e.appServerAvailable, "boolean");
    if (name === "antigravity") {
      assert.equal(typeof e.binPath, "string");
      assert.equal(typeof e.resolvedFrom, "string");
    }
    if (name === "cc") assert.equal(typeof e.cliRunnable, "boolean");
  }
}

test("schema invariants hold for an all-ready doc (ready branch — authVerified still false)", () => {
  const doc = allReadyDoc();
  assert.equal(doc.allReady, true);
  assertSchemaInvariants(doc);
});

test("schema invariants hold for an all-not-ready doc (not-ready branch — proves 'iff' both ways)", () => {
  const doc = allNotReadyDoc();
  assert.equal(doc.allReady, false);
  // Every engine is not-ready, so the reason/deepFixCommand-non-null leg runs.
  for (const name of doc.checkedEngines) {
    assert.equal(doc.engines[name].status, "not-ready");
  }
  assertSchemaInvariants(doc);
});

test("exit code is 0 for a completed not-ready run", () => {
  const r = runDoctor(["--json", "--only", "codex"], {
    spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null }),
    env: { HOME: "/tmp/fleet-noexist-home" },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout).engines.codex.status, "not-ready");
});

// ---------------------------------------------------------------------------
// Task 9: human (non-json) output — per-engine readout + auth-not-verified caveat
// ---------------------------------------------------------------------------

test("human output: one line per engine, marks ready, routes not-ready, prints auth caveat", () => {
  const dataRoot = makeDataRoot();
  writeProfile(dataRoot, "work", { env: { ANTHROPIC_AUTH_TOKEN: "t" } });
  // codex ready (both probes status 0), antigravity missing, cc ready.
  const spawn = (bin) =>
    bin === "agy"
      ? { error: { code: "ENOENT" }, status: null }
      : { status: 0, stdout: `${bin} 1.0\n`, stderr: "" };
  const r = runDoctor([], {
    spawnSyncImpl: spawn,
    existsSyncImpl: () => false, // antigravity resolves to bare "agy" → ENOENT
    env: { HOME: "/tmp/fleet-noexist-home", CC_PLUGIN_DATA: dataRoot },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /codex/);
  assert.match(r.stdout, /antigravity/);
  assert.match(r.stdout, /cc/);
  // not-ready antigravity surfaces its deep-fix route.
  assert.match(r.stdout, /\/antigravity:setup/);
  // the auth-not-verified caveat must be present (ready != logged in).
  assert.match(r.stdout, /auth.*not.*(checked|verified)/i);
});

// ---------------------------------------------------------------------------
// Task 10: error-path guardrails — probe {error} never throws
// ---------------------------------------------------------------------------

test("a probe ENOENT never throws — classified as missing across all engines", () => {
  const spawn = () => ({ error: { code: "ENOENT" }, status: null });
  const r = runDoctor(["--json"], {
    spawnSyncImpl: spawn,
    existsSyncImpl: () => false,
    env: { HOME: "/tmp/fleet-noexist-home" },
  });
  assert.equal(r.exitCode, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.engines.codex.reason, "binary-missing");
  assert.equal(doc.engines.antigravity.reason, "binary-missing");
  assert.equal(doc.engines.cc.reason, "cli-missing");
  assert.equal(doc.allReady, false);
});

test("clause 2: a non-ENOENT error with null status → version-failed (binary launched), not missing", () => {
  // EACCES is not ENOENT, so clause 1 does not match → clause 2 (version-failed).
  const r = runDoctor(["--json", "--only", "codex"], {
    spawnSyncImpl: () => ({ error: { code: "EACCES" }, status: null }),
    env: { HOME: "/tmp/fleet-noexist-home" },
  });
  assert.equal(r.exitCode, 0);
  const c = JSON.parse(r.stdout).engines.codex;
  assert.equal(c.reason, "version-failed");
  assert.equal(c.onPath, true);
});

test("clause 2: error truthy WITH a non-null status + non-ENOENT code → version-failed", () => {
  // Pins probeBinary (Task 3) so a future refactor cannot flip error-with-status to missing.
  const r = runDoctor(["--json", "--only", "codex"], {
    spawnSyncImpl: () => ({ error: { code: "EACCES" }, status: 1, stdout: "", stderr: "" }),
    env: { HOME: "/tmp/fleet-noexist-home" },
  });
  assert.equal(r.exitCode, 0);
  const c = JSON.parse(r.stdout).engines.codex;
  assert.equal(c.reason, "version-failed");
  assert.equal(c.onPath, true);
});

test("usage error under --json is parseable JSON with an error key (not a crash)", () => {
  const r = runDoctor(["--json", "--only", "nope"], {
    spawnSyncImpl: () => ({ status: 0, stdout: "v\n" }),
    env: { HOME: "/tmp/fleet-noexist-home" },
  });
  assert.equal(r.exitCode, 2);
  const parsed = JSON.parse(r.stdout); // must not throw
  assert.ok(typeof parsed.error === "string" && parsed.error.length > 0);
  assert.ok(!("engines" in parsed));
});
