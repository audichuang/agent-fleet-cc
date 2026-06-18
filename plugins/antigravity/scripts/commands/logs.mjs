/**
 * /antigravity:logs — print or follow a persisted Antigravity job log.
 *
 * Positional: <job-id> (required).
 * Flags:
 *   --follow  poll appended log bytes until the job reaches terminal state
 *   --timeout-ms <ms>  override follow timeout (default 15m)
 *   --json    emit { engine, jobId, status, log }
 *   --cwd     override working directory
 */

import fs from "node:fs";

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { buildSingleJobSnapshot } from "../lib/job-control.mjs";
import { readJobLog, resolveJobLogFile } from "../lib/state.mjs";
import { outputCommandResult } from "../lib/render.mjs";

const POLL_MS = 1000;
const DEFAULT_FOLLOW_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["follow", "json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const follow = Boolean(options.follow);
  const json = Boolean(options.json);
  let timeoutMs = DEFAULT_FOLLOW_TIMEOUT_MS;
  try {
    if (follow || options["timeout-ms"] !== undefined) {
      timeoutMs = parseTimeoutMs(options["timeout-ms"]);
    }
  } catch (err) {
    process.stderr.write(`antigravity:logs — ${err?.message ?? err}\n`);
    return 1;
  }

  if (!reference) {
    process.stderr.write(
      "antigravity:logs — job id required. Run /antigravity:status to inspect known jobs.\n",
    );
    return 1;
  }

  let snapshot;
  try {
    snapshot = buildSingleJobSnapshot(cwd, reference);
  } catch (err) {
    process.stderr.write(`antigravity:logs — ${err?.message ?? err}\n`);
    return 1;
  }

  if (json) {
    const result = follow
      ? await waitForTerminal(cwd, snapshot.job.id, timeoutMs)
      : { snapshot, timedOut: false };
    const log = readJobLog(result.snapshot.workspaceRoot, result.snapshot.job.id);
    outputCommandResult(buildLogPayload(result.snapshot, log, { timedOut: result.timedOut }), "", true);
    return result.timedOut ? 10 : 0;
  }

  if (!follow) {
    process.stdout.write(readJobLog(snapshot.workspaceRoot, snapshot.job.id));
    return 0;
  }

  try {
    const result = await followLog(snapshot, cwd, timeoutMs);
    return result.timedOut ? 10 : 0;
  } catch (err) {
    process.stderr.write(`antigravity:logs — ${err?.message ?? err}\n`);
    return 1;
  }
}

async function followLog(initialSnapshot, cwd, timeoutMs) {
  let snapshot = initialSnapshot;
  const jobId = snapshot.job.id;
  const deadline = Date.now() + timeoutMs;
  let { text, offset } = readFullLog(snapshot.workspaceRoot, jobId);
  if (text) process.stdout.write(text);

  while (!TERMINAL_STATUSES.has(snapshot.job.status)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { snapshot, timedOut: true };
    }
    await sleep(Math.min(POLL_MS, remainingMs));
    const appended = readAppendedLog(snapshot.workspaceRoot, jobId, offset);
    offset = appended.offset;
    if (appended.text) process.stdout.write(appended.text);
    snapshot = buildSingleJobSnapshot(cwd, jobId);
  }

  const appended = readAppendedLog(snapshot.workspaceRoot, jobId, offset);
  if (appended.text) process.stdout.write(appended.text);
  return { snapshot, timedOut: false };
}

async function waitForTerminal(cwd, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  while (true) {
    snapshot = buildSingleJobSnapshot(cwd, jobId);
    if (TERMINAL_STATUSES.has(snapshot.job.status)) return { snapshot, timedOut: false };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { snapshot, timedOut: true };
    await sleep(Math.min(POLL_MS, remainingMs));
  }
}

function buildLogPayload(snapshot, log, { timedOut = false } = {}) {
  const job = snapshot.job;
  return {
    engine: "antigravity",
    jobId: job.id,
    status: job.status,
    phase: job.phase ?? null,
    title: job.title ?? null,
    summary: job.summary ?? null,
    errorMessage: job.errorMessage ?? null,
    completedAt: job.completedAt ?? null,
    timedOut,
    log,
  };
}

function parseTimeoutMs(value) {
  if (value === undefined) return DEFAULT_FOLLOW_TIMEOUT_MS;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  return parsed;
}

function readFullLog(workspaceRoot, jobId) {
  const filePath = resolveJobLogFile(workspaceRoot, jobId);
  try {
    const bytes = fs.readFileSync(filePath);
    return { text: bytes.toString("utf8"), offset: bytes.length };
  } catch {
    return { text: "", offset: 0 };
  }
}

function readAppendedLog(workspaceRoot, jobId, offset) {
  const filePath = resolveJobLogFile(workspaceRoot, jobId);
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return { text: "", offset: stat.size };

    fd = fs.openSync(filePath, "r");
    const length = stat.size - offset;
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, offset);
    return { text: bytes.toString("utf8"), offset: stat.size };
  } catch {
    return { text: "", offset };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default run;

runAsMain(import.meta.url, run, "logs");
