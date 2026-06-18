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

// Per-engine checker — stubbed for now; real recipes added in later tasks.
export function checkEngine(engine, deps) {
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
