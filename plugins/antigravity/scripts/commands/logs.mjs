/**
 * /antigravity:logs — print or follow a persisted Antigravity job log.
 *
 * Runs on the shared runtime: the log file is `logFilePath(stateDir, jobId)`
 * and terminal detection reads the shared job record (`readJob`) with a
 * `reconcileDeadPids` sweep each poll — so a dead worker terminalizes the job
 * instead of the follow hanging to the timeout. The UTF-8-safe byte-tail
 * follow (a `StringDecoder` that reassembles multibyte characters split across
 * a poll boundary) is preserved verbatim.
 *
 * Positional: <job-id> (required).
 * Flags:
 *   --follow  poll appended log bytes until the job reaches terminal state
 *   --timeout-ms <ms>  override follow timeout (default 15m)
 *   --json    emit { engine, jobId, status, log }
 *   --cwd     override working directory
 */

import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { stateDirFor, projectJob } from "../lib/job-runtime.mjs";
import { readJob, logFilePath } from "../lib/shared/core/state-store.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import { TERMINAL_STATUSES } from "../lib/shared/core/job.mjs";
import { outputCommandResult } from "../lib/render.mjs";

const DEFAULT_FOLLOW_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Relocated from poll.mjs (deleted in Phase 6). Returns the default when the
// flag is absent; throws on a present-but-invalid value.
function parseTimeoutMs(value, defaultMs) {
  if (value === undefined) return defaultMs;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  return parsed;
}

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
      timeoutMs = parseTimeoutMs(options["timeout-ms"], DEFAULT_FOLLOW_TIMEOUT_MS);
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

  const stateDir = stateDirFor(cwd, process.env);
  reconcileDeadPids(stateDir);
  const initial = readJob(stateDir, reference);
  if (!initial) {
    process.stderr.write(
      `antigravity:logs — no job found for "${reference}". Run /antigravity:status to inspect known jobs.\n`,
    );
    return 1;
  }

  if (json) {
    const result = follow
      ? await followToTerminal(stateDir, reference, timeoutMs)
      : { job: initial, timedOut: false };
    const log = readFullLogText(stateDir, reference);
    outputCommandResult(
      buildLogPayload(projectJob(result.job), log, { timedOut: result.timedOut }),
      "",
      true,
    );
    return result.timedOut ? 10 : 0;
  }

  if (!follow) {
    process.stdout.write(readFullLogText(stateDir, reference));
    return 0;
  }

  try {
    const result = await followLog(stateDir, reference, timeoutMs);
    return result.timedOut ? 10 : 0;
  } catch (err) {
    process.stderr.write(`antigravity:logs — ${err?.message ?? err}\n`);
    return 1;
  }
}

// UTF-8-safe byte-tail follow (preserved verbatim): stream appended log bytes
// through a StringDecoder so a multibyte character split across a poll boundary
// is reassembled instead of emitting a replacement char. Terminal detection is
// readJob + reconcileDeadPids each poll so a dead worker terminalizes.
async function followLog(stateDir, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const decoder = new StringDecoder("utf8");
  let { bytes, offset } = readFullLogBytes(stateDir, jobId);
  if (bytes.length) process.stdout.write(decoder.write(bytes));

  let job = readJob(stateDir, jobId);
  let timedOut = false;
  while (!TERMINAL_STATUSES.has(job?.status)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      timedOut = true;
      break;
    }
    await sleep(Math.min(POLL_MS, remainingMs));
    const appended = readAppendedBytes(stateDir, jobId, offset);
    offset = appended.offset;
    if (appended.bytes.length) process.stdout.write(decoder.write(appended.bytes));
    reconcileDeadPids(stateDir);
    job = readJob(stateDir, jobId);
  }

  if (!timedOut) {
    const appended = readAppendedBytes(stateDir, jobId, offset);
    if (appended.bytes.length) process.stdout.write(decoder.write(appended.bytes));
  }
  const tail = decoder.end();
  if (tail) process.stdout.write(tail);
  return { job, timedOut };
}

// --json --follow: poll to terminal (or deadline) without streaming, then the
// caller reads the full log for the payload.
async function followToTerminal(stateDir, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let job = readJob(stateDir, jobId);
  while (!TERMINAL_STATUSES.has(job?.status)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { job, timedOut: true };
    await sleep(Math.min(POLL_MS, remainingMs));
    reconcileDeadPids(stateDir);
    job = readJob(stateDir, jobId);
  }
  return { job, timedOut: false };
}

function buildLogPayload(job, log, { timedOut = false } = {}) {
  if (!job) {
    return { engine: "antigravity", jobId: null, status: "missing", timedOut, log };
  }
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

function readFullLogText(stateDir, jobId) {
  try {
    return fs.readFileSync(logFilePath(stateDir, jobId), "utf8");
  } catch {
    return "";
  }
}

function readFullLogBytes(stateDir, jobId) {
  const filePath = logFilePath(stateDir, jobId);
  try {
    const bytes = fs.readFileSync(filePath);
    return { bytes, offset: bytes.length };
  } catch {
    return { bytes: Buffer.alloc(0), offset: 0 };
  }
}

function readAppendedBytes(stateDir, jobId, offset) {
  const filePath = logFilePath(stateDir, jobId);
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= offset) return { bytes: Buffer.alloc(0), offset: stat.size };

    fd = fs.openSync(filePath, "r");
    const length = stat.size - offset;
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, offset);
    return { bytes, offset: stat.size };
  } catch {
    return { bytes: Buffer.alloc(0), offset };
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

// Test seam: prove the streaming decoder reassembles characters split across chunks.
export function decodeStreamForTest(chunks) {
  const decoder = new StringDecoder("utf8");
  let out = "";
  for (const chunk of chunks) out += decoder.write(Buffer.from(chunk));
  return out + decoder.end();
}

export default run;

runAsMain(import.meta.url, run, "logs");
