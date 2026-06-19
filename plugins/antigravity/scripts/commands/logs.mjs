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
import { StringDecoder } from "node:string_decoder";

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { buildSingleJobSnapshot } from "../lib/job-control.mjs";
import { sleep, POLL_MS, TERMINAL_STATUSES, parseTimeoutMs, waitForTerminal } from "../lib/poll.mjs";
import { readJobLog, resolveJobLogFile } from "../lib/state.mjs";
import { outputCommandResult } from "../lib/render.mjs";

const DEFAULT_FOLLOW_TIMEOUT_MS = 15 * 60 * 1000;

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
  const decoder = new StringDecoder("utf8");
  let { bytes, offset } = readFullLogBytes(snapshot.workspaceRoot, jobId);
  if (bytes.length) process.stdout.write(decoder.write(bytes));

  let timedOut = false;
  while (!TERMINAL_STATUSES.has(snapshot.job.status)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      timedOut = true;
      break;
    }
    await sleep(Math.min(POLL_MS, remainingMs));
    const appended = readAppendedBytes(snapshot.workspaceRoot, jobId, offset);
    offset = appended.offset;
    if (appended.bytes.length) process.stdout.write(decoder.write(appended.bytes));
    snapshot = buildSingleJobSnapshot(cwd, jobId);
  }

  if (!timedOut) {
    const appended = readAppendedBytes(snapshot.workspaceRoot, jobId, offset);
    if (appended.bytes.length) process.stdout.write(decoder.write(appended.bytes));
  }
  const tail = decoder.end();
  if (tail) process.stdout.write(tail);
  return { snapshot, timedOut };
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

function readFullLogBytes(workspaceRoot, jobId) {
  const filePath = resolveJobLogFile(workspaceRoot, jobId);
  try {
    const bytes = fs.readFileSync(filePath);
    return { bytes, offset: bytes.length };
  } catch {
    return { bytes: Buffer.alloc(0), offset: 0 };
  }
}

function readAppendedBytes(workspaceRoot, jobId, offset) {
  const filePath = resolveJobLogFile(workspaceRoot, jobId);
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
