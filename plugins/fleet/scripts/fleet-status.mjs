#!/usr/bin/env node
// fleet-status.mjs — read-only, non-TUI status board for installed engines.
// It shells out to each engine's own status command and normalizes the result.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { splitRawArgumentString, normalizeArgv, UsageError, resolveEngines, CANONICAL, isMainModule } from "./lib/cli-args.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running"]);

const ENGINE_COMMANDS = {
  codex: {
    script: ["..", "codex", "scripts", "codex-companion.mjs"],
    args: ["status", "--json"],
  },
  antigravity: {
    script: ["..", "antigravity", "scripts", "commands", "status.mjs"],
    args: ["--json"],
  },
  delegate: {
    script: ["..", "delegate", "scripts", "delegate-companion.mjs"],
    args: ["status", "--json"],
  },
};

function parseArgs(argv) {
  const parsed = { json: false, only: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--only") {
      parsed.only = readValue(argv, ++i, "--only");
    } else if (arg.startsWith("--only=")) {
      parsed.only = requiredInlineValue(arg, "--only");
    } else if (arg === "--cwd") {
      parsed.cwd = readValue(argv, ++i, "--cwd");
    } else if (arg.startsWith("--cwd=")) {
      parsed.cwd = requiredInlineValue(arg, "--cwd");
    } else {
      throw new UsageError(`unknown flag: ${arg}`);
    }
  }
  return parsed;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value === "") {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function requiredInlineValue(arg, flag) {
  const value = arg.slice(flag.length + 1);
  if (!value) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function pluginRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function engineScriptPath(pluginRoot, engine) {
  return path.resolve(pluginRoot, ...ENGINE_COMMANDS[engine].script);
}

function unavailableRow(engine, summary) {
  return {
    engine,
    available: false,
    active: 0,
    recent: 0,
    status: "unavailable",
    summary,
    actions: [`/${engine}:setup`],
  };
}

function normalizeStatus(engine, payload) {
  const { jobs, recognized } = extractJobs(payload);
  if (!recognized) {
    return {
      engine,
      available: true,
      active: 0,
      recent: 0,
      status: "unknown",
      summary: `${engine}: status JSON in an unrecognized shape; cannot tally jobs`,
      actions: [`/${engine}:status`],
    };
  }
  const activeJobs = jobs.filter((job) => ACTIVE_STATUSES.has(job?.status));
  const recentJobs = jobs.filter((job) => !ACTIVE_STATUSES.has(job?.status));
  const active = activeJobs.length;
  const recent = recentJobs.length;
  const latest = activeJobs[0] ?? recentJobs[0] ?? null;
  const status = active ? "active" : latest?.status ?? "idle";

  return {
    engine,
    available: true,
    active,
    recent,
    status,
    summary: summarizeRow(engine, active, recent, latest),
    actions: buildActions(engine, latest),
  };
}

function extractJobs(payload) {
  if (Array.isArray(payload)) return { jobs: payload, recognized: true };
  if (!payload || typeof payload !== "object") return { jobs: [], recognized: false };
  const hasKnownKeys =
    Array.isArray(payload.running) ||
    Array.isArray(payload.recent) ||
    Array.isArray(payload.jobs) ||
    payload.latestFinished;
  if (!hasKnownKeys) return { jobs: [], recognized: false };
  const jobs = [];
  if (Array.isArray(payload.running)) jobs.push(...payload.running);
  if (Array.isArray(payload.recent)) jobs.push(...payload.recent);
  if (Array.isArray(payload.jobs)) jobs.push(...payload.jobs);
  if (payload.latestFinished && !jobs.some((job) => job?.id === payload.latestFinished?.id)) {
    jobs.push(payload.latestFinished);
  }
  return { jobs, recognized: true };
}

function jobId(job) {
  return job?.jobId ?? job?.id ?? null;
}

function summarizeRow(engine, active, recent, latest) {
  if (!latest) return `${engine}: no known jobs`;
  const id = jobId(latest);
  if (active) return `${engine}: ${active} active job(s), latest ${id ?? "unknown"}`;
  return `${engine}: ${recent} recent job(s), latest ${id ?? "unknown"} ${latest.status ?? ""}`.trim();
}

function buildActions(engine, job) {
  const actions = [`/${engine}:status`];
  const id = jobId(job);
  if (!id) return actions;
  actions.push(`/${engine}:result ${id}`);
  actions.push(`/${engine}:wait ${id}`);
  if (engine === "codex") {
    actions.push(`/codex:logs ${id}`);
  } else if (engine === "delegate") {
    actions.push(`/delegate:logs ${id} --follow`);
  } else {
    actions.push(`/antigravity:logs ${id} --follow`);
  }
  return actions;
}

function runEngineStatus(engine, options) {
  const { pluginRoot, cwd, spawnSyncImpl, existsSyncImpl } = options;
  const script = engineScriptPath(pluginRoot, engine);
  if (!existsSyncImpl(script)) {
    return unavailableRow(engine, `status script missing: ${script}`);
  }

  const args = [script, ...ENGINE_COMMANDS[engine].args];
  const result = spawnSyncImpl(process.execPath, args, {
    cwd,
    encoding: "utf8",
    input: "",
    timeout: 10000,
  });
  if (result?.error) {
    return unavailableRow(engine, `status command failed: ${result.error.message ?? result.error.code ?? result.error}`);
  }
  if (!result || result.status !== 0) {
    const detail = firstLine(result?.stderr) || firstLine(result?.stdout) || `exit ${result?.status ?? "unknown"}`;
    return unavailableRow(engine, `status command exited non-zero: ${detail}`);
  }
  try {
    return normalizeStatus(engine, JSON.parse(result.stdout || "null"));
  } catch {
    return unavailableRow(engine, "status command returned invalid JSON");
  }
}

function firstLine(text) {
  if (typeof text !== "string") return "";
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function renderHuman(doc) {
  const lines = [
    "| Engine | Available | Active | Recent | Status | Summary | Actions |",
    "|---|---:|---:|---:|---|---|---|",
  ];
  for (const row of doc.rows) {
    lines.push(
      [
        row.engine,
        row.available ? "yes" : "no",
        String(row.active),
        String(row.recent),
        row.status,
        row.summary,
        row.actions.join("<br>"),
      ].map(escapeCell).join("|").replace(/^/, "|").replace(/$/, "|"),
    );
  }
  return lines.join("\n") + "\n";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}

export function runStatus(argv = [], deps = {}) {
  let parsed;
  let engines;
  const normalizedArgv = normalizeArgv(argv, deps);
  try {
    parsed = parseArgs(normalizedArgv);
    engines = resolveEngines(parsed.only);
  } catch (error) {
    if (error instanceof UsageError) {
      const wantJson = normalizedArgv.includes("--json");
      if (wantJson) {
        return { stdout: JSON.stringify({ error: error.message }), stderr: "", exitCode: 2 };
      }
      return { stdout: "", stderr: error.message + "\n", exitCode: 2 };
    }
    throw error;
  }

  const pluginRoot = deps.pluginRoot ?? pluginRootFromModule();
  const cwd = parsed.cwd ?? deps.cwd ?? process.cwd();
  const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
  const existsSyncImpl = deps.existsSyncImpl ?? fs.existsSync;
  const rows = engines.map((engine) =>
    runEngineStatus(engine, { pluginRoot, cwd, spawnSyncImpl, existsSyncImpl }),
  );
  const doc = {
    checkedEngines: engines,
    allAvailable: rows.every((row) => row.available),
    rows,
  };

  if (parsed.json) {
    return { stdout: JSON.stringify(doc), stderr: "", exitCode: 0 };
  }
  return { stdout: renderHuman(doc), stderr: "", exitCode: 0 };
}

function main() {
  const { stdout, stderr, exitCode } = runStatus(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}
