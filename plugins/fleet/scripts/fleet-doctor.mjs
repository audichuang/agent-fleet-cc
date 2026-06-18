// fleet-doctor.mjs — deterministic, network-free readiness checks for the
// agent-fleet engines (codex, antigravity, delegate). Self-contained: it does
// NOT import sibling-plugin code and NEVER probes auth or makes a network call.
import { spawnSync } from "node:child_process";

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

// Per-engine checker — routes to the real recipe or stubs for future tasks.
export function checkEngine(engine, deps) {
  if (engine === "codex") return checkCodex(deps);
  // Other engines stubbed until their tasks.
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
