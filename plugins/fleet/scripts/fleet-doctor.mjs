// fleet-doctor.mjs — deterministic, network-free readiness checks for the
// agent-fleet engines (codex, antigravity, delegate). Self-contained: it does
// NOT import sibling-plugin code and NEVER probes auth or makes a network call.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CANONICAL = ["codex", "antigravity", "delegate"];

class UsageError extends Error {}

// Parse argv into { json, only }. Throws UsageError on bad input.
function parseArgs(argv) {
  let json = false;
  let only = null; // null => all engines
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--only") {
      const csv = argv[++i];
      if (csv === undefined || csv === "") {
        throw new UsageError("--only requires a comma-separated engine list");
      }
      only = csv;
    } else if (arg.startsWith("--only=")) {
      const csv = arg.slice("--only=".length);
      if (csv === "") {
        throw new UsageError("--only requires a comma-separated engine list");
      }
      only = csv;
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }
  return { json, only };
}

// Resolve the engines to check: canonical order, deduped, filtered by --only.
function resolveEngines(only) {
  if (only === null) return [...CANONICAL];
  const requested = only.split(",").map((s) => s.trim());
  for (const name of requested) {
    if (!CANONICAL.includes(name)) {
      throw new UsageError(
        `unknown engine: ${name}; allowed: ${CANONICAL.join(",")}`,
      );
    }
  }
  // Canonical re-sort + dedup: walk CANONICAL, keep those that were requested.
  return CANONICAL.filter((name) => requested.includes(name));
}

// Uniform binary probe + ORDERED detection rule (spec §5.3).
// Evaluate clauses top-to-bottom; first match wins:
//   1. r.error && r.error.code === "ENOENT"                 → not found ("missing")
//   2. r.error (any code incl ETIMEDOUT) || r.signal
//      || r.status !== 0                                    → found, "version-failed"
//   3. r.status === 0                                       → ok, version = first line
// Only ENOENT means missing; a timeout/any-other-error/signal/non-zero is
// present-but-failed. `args` is parameterized so the codex secondary probe
// (["app-server","--help"]) reuses this exact rule.
export function probeBinary(binary, deps = {}, args = ["--version"]) {
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const r = spawnSyncImpl(binary, args, {
    encoding: "utf8",
    timeout: 5000,
    input: "",
  });
  // Clause 1: ENOENT (and only ENOENT) means the binary was not found.
  if (r && r.error && r.error.code === "ENOENT") {
    return { ok: false, found: false, reason: "missing", version: null };
  }
  // Clause 2: any other error (incl ETIMEDOUT), any signal, or non-zero status
  // means the binary launched but the probe failed.
  if ((r && r.error) || (r && r.signal) || !r || r.status !== 0) {
    return { ok: false, found: true, reason: "version-failed", version: null };
  }
  // Clause 3: status === 0 → ok.
  return { ok: true, found: true, reason: null, version: firstNonEmptyLine(r.stdout) };
}

function firstNonEmptyLine(stdout) {
  if (typeof stdout !== "string") return null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line) return line;
  }
  return null;
}

function checkCodex(deps) {
  const version = probeBinary("codex", deps); // ["--version"]
  // binary-missing / version-failed: skip the app-server probe entirely.
  if (!version.ok) {
    const reason = version.found ? "version-failed" : "binary-missing";
    const summary = version.found
      ? "codex found but 'codex --version' failed"
      : "codex not found on PATH — install the OpenAI Codex CLI";
    return {
      engine: "codex",
      status: "not-ready",
      authVerified: false,
      reason,
      summary,
      deepFixCommand: "/codex:setup",
      binaryName: "codex",
      onPath: version.found,
      appServerAvailable: false,
      version: null,
    };
  }
  // --version ok → run the second local probe.
  const appServer = probeBinary("codex", deps, ["app-server", "--help"]);
  if (appServer.ok) {
    return {
      engine: "codex",
      status: "ready",
      authVerified: false,
      reason: null,
      summary: `codex CLI ready (${version.version}) — auth not checked, run /codex:setup to log in`,
      deepFixCommand: null,
      binaryName: "codex",
      onPath: true,
      appServerAvailable: true,
      version: version.version,
    };
  }
  // --version ok but app-server probe failed (any non-zero / error / signal).
  return {
    engine: "codex",
    status: "not-ready",
    authVerified: false,
    reason: "app-server-failed",
    summary: `codex --version ok but 'codex app-server --help' failed — codex isn't fully ready`,
    deepFixCommand: "/codex:setup",
    binaryName: "codex",
    onPath: true,
    appServerAvailable: false,
    version: version.version,
  };
}

const ANTIGRAVITY_INSTALL_URL = "https://antigravity.google/download";

// Re-implements the antigravity engine's resolveAgyBin order INLINE (no import
// of plugins/antigravity/.../agent-runtime.mjs). Order, first match wins:
//   1. env.AGY_BIN (only when truthy AND existsSync) → "AGY_BIN"
//   2. first 'agy' in (env.PATH || env.Path).split(':').filter(Boolean) → "PATH"
//   3. <env.HOME>/.local/bin/agy if it exists → "home-fallback"
//   4. bare "agy" → "default"
export function resolveAgyBin(env = {}, existsSyncImpl = fs.existsSync) {
  if (env.AGY_BIN && existsSyncImpl(env.AGY_BIN)) {
    return { binPath: env.AGY_BIN, resolvedFrom: "AGY_BIN" };
  }
  const dirs = (env.PATH || env.Path || "").split(":").filter(Boolean);
  for (const d of dirs) {
    const candidate = path.join(d, "agy");
    if (existsSyncImpl(candidate)) {
      return { binPath: candidate, resolvedFrom: "PATH" };
    }
  }
  if (env.HOME) {
    const home = path.join(env.HOME, ".local", "bin", "agy");
    if (existsSyncImpl(home)) {
      return { binPath: home, resolvedFrom: "home-fallback" };
    }
  }
  return { binPath: "agy", resolvedFrom: "default" };
}

function checkAntigravity(deps) {
  const env = deps.env ?? process.env;
  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
  const { binPath, resolvedFrom } = resolveAgyBin(env, existsSyncImpl);
  const probe = probeBinary(binPath, deps);
  if (probe.ok) {
    return {
      engine: "antigravity",
      status: "ready",
      authVerified: false,
      reason: null,
      summary: `agy CLI ready (${probe.version}) — auth not checked, run /antigravity:setup to authorize`,
      deepFixCommand: null,
      binaryName: "agy",
      binPath,
      resolvedFrom,
      onPath: true,
      version: probe.version,
      installUrl: ANTIGRAVITY_INSTALL_URL,
    };
  }
  // binary-missing ONLY when nothing was resolved on disk (resolvedFrom "default")
  // AND the bare spawn ENOENT'd. A resolved real path (AGY_BIN/PATH/home-fallback)
  // that fails to launch is version-failed, not missing — existsSync already proved
  // the file was there, so the gap is "present but broken," matching §5.3's rule.
  const missing = resolvedFrom === "default" && !probe.found;
  const reason = missing ? "binary-missing" : "version-failed";
  const summary = missing
    ? `agy not found — install from ${ANTIGRAVITY_INSTALL_URL}`
    : `agy found (${binPath}) but '${binPath} --version' failed`;
  return {
    engine: "antigravity",
    status: "not-ready",
    authVerified: false,
    reason,
    summary,
    deepFixCommand: "/antigravity:setup",
    binaryName: "agy",
    binPath,
    resolvedFrom,
    onPath: !missing,
    version: null,
    installUrl: ANTIGRAVITY_INSTALL_URL,
  };
}

// Mirrors plugins/delegate/scripts/lib/profiles.mjs PROFILE_NAME_RE — re-declared
// inline so fleet-doctor stays self-contained (no sibling-plugin import).
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// A top-level `env`, if present, must be a PLAIN object whose every value is a
// scalar (string|number|boolean|null). An ARRAY env is invalid (Array.isArray
// rejected); so is any nested object/array value.
function envIsScalarOnly(parsed) {
  if (!parsed || parsed.env === undefined || parsed.env === null) return true;
  if (typeof parsed.env !== "object" || Array.isArray(parsed.env)) return false;
  for (const value of Object.values(parsed.env)) {
    if (value !== null && typeof value === "object") return false; // object or array value
  }
  return true;
}

// Enumerate <dataRoot>/profiles/*.json. Returns invalid entries (name+error)
// and the sorted names of valid profiles. Validation order per spec §5.3:
//   1) basename regex (skip before parse), 2) JSON parse, 3) env scalar-only.
function discoverProfiles(dataRoot) {
  const dir = path.join(dataRoot, "profiles");
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { invalid: [], validNames: [] };
  }
  const names = entries
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();

  const invalid = [];
  const validNames = [];
  for (const name of names) {
    if (!PROFILE_NAME_RE.test(name)) {
      invalid.push({ name, error: "invalid-name" });
      continue; // skip before parse
    }
    const file = path.join(dir, `${name}.json`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      invalid.push({ name, error: "unparseable-json" });
      continue;
    }
    if (!envIsScalarOnly(parsed)) {
      invalid.push({ name, error: "non-scalar-env" });
      continue;
    }
    validNames.push(name);
  }
  return { invalid, validNames };
}

function resolveDataRoot(env) {
  if (env.DELEGATE_PLUGIN_DATA) return env.DELEGATE_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  const home = env.HOME ?? process.env.HOME ?? "";
  return path.join(home, ".claude", "plugins", "data", "delegate");
}

function checkDelegate(deps) {
  const env = deps.env ?? process.env;
  const binaryName = env.DELEGATE_CLAUDE_BIN ?? "claude";
  const probe = probeBinary(binaryName, deps);
  const cliRunnable = probe.ok;
  const cliVersion = probe.ok ? probe.version : null;

  if (!cliRunnable) {
    const reason = probe.found ? "cli-version-failed" : "cli-missing";
    const summary = probe.found
      ? `${binaryName} found but '--version' failed`
      : `${binaryName} CLI not found — delegate needs the claude CLI`;
    return {
      engine: "delegate",
      status: "not-ready",
      authVerified: false,
      reason,
      summary,
      deepFixCommand: "/delegate:setup",
      binaryName,
      cliRunnable: false,
      cliVersion: null,
      dataRoot: resolveDataRoot(env),
      profiles: [],
      validProfileCount: 0,
      firstValidProfile: null,
    };
  }

  // CLI ok — discover + validate local profiles (no network).
  const dataRoot = resolveDataRoot(env);
  const { invalid, validNames } = discoverProfiles(dataRoot);
  const validProfileCount = validNames.length;
  const firstValidProfile = validProfileCount ? validNames[0] : null;
  const anyFiles = invalid.length + validProfileCount > 0;

  if (validProfileCount >= 1) {
    return {
      engine: "delegate",
      status: "ready",
      authVerified: false,
      reason: null,
      summary: `delegate ready (${binaryName} ${cliVersion}, ${validProfileCount} valid profile(s)) — token not checked`,
      deepFixCommand: null,
      binaryName,
      cliRunnable: true,
      cliVersion,
      dataRoot,
      profiles: invalid,
      validProfileCount,
      firstValidProfile,
    };
  }

  const reason = anyFiles ? "no-valid-profiles" : "no-profiles";
  const summary = anyFiles
    ? "claude CLI ready but no valid profiles (fix the listed file(s))"
    : `claude CLI ready but no profiles found in ${path.join(dataRoot, "profiles")}`;
  return {
    engine: "delegate",
    status: "not-ready",
    authVerified: false,
    reason,
    summary,
    deepFixCommand: "/delegate:setup",
    binaryName,
    cliRunnable: true,
    cliVersion,
    dataRoot,
    profiles: invalid,
    validProfileCount,
    firstValidProfile: null,
  };
}

// Per-engine checker — routes to the real recipe or stubs for future tasks.
export function checkEngine(engine, deps) {
  if (engine === "codex") return checkCodex(deps);
  if (engine === "antigravity") return checkAntigravity(deps);
  if (engine === "delegate") return checkDelegate(deps);
  return {
    engine,
    status: "not-ready",
    authVerified: false,
    reason: null,
    summary: "stub",
    deepFixCommand: null,
  };
}

export function runDoctor(argv = [], deps = {}) {
  let parsed;
  let engines;
  try {
    parsed = parseArgs(argv);
    engines = resolveEngines(parsed.only);
  } catch (err) {
    if (err instanceof UsageError) {
      const wantJson = argv.includes("--json");
      if (wantJson) {
        return { stdout: JSON.stringify({ error: err.message }), stderr: "", exitCode: 2 };
      }
      return { stdout: "", stderr: err.message + "\n", exitCode: 2 };
    }
    throw err;
  }

  const enginesMap = {};
  for (const engine of engines) {
    enginesMap[engine] = checkEngine(engine, deps);
  }
  const allReady = engines.every((e) => enginesMap[e].status === "ready");
  const doc = { checkedEngines: engines, allReady, engines: enginesMap };

  if (parsed.json) {
    return { stdout: JSON.stringify(doc), stderr: "", exitCode: 0 };
  }
  // Human output is implemented in a later task; emit a placeholder for now.
  return { stdout: "", stderr: "", exitCode: 0 };
}

function main() {
  const { stdout, stderr, exitCode } = runDoctor(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
