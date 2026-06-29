import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { writeJobFile, saveState, resolveJobLogFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { appendLogLine } from "../../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { streamJobLog, handleAttach, makeUtf8LogReader } from "../../plugins/codex/scripts/codex-companion.mjs";

test("streamJobLog writes new chunks until terminal, then flushes the tail and exits", async () => {
  const out = [];
  const chunks = ["A\n", "B\n", "", "C-final\n"];
  const statuses = ["running", "running", "completed"];
  let ci = 0;
  let si = 0;
  const status = await streamJobLog({
    readChunk: () => chunks[ci++] ?? "",
    readStatus: () => statuses[si++] ?? "completed",
    sleep: async () => {},
    write: (s) => out.push(s),
    pollIntervalMs: 0,
    maxPolls: 100
  });
  assert.equal(status, "completed");
  assert.equal(out.join(""), "A\nB\nC-final\n");
});

test("streamJobLog exits immediately when the job is already terminal (after one flush)", async () => {
  const out = [];
  const chunks = ["done log\n", ""];
  let ci = 0;
  const status = await streamJobLog({
    readChunk: () => chunks[ci++] ?? "",
    readStatus: () => "failed",
    sleep: async () => {},
    write: (s) => out.push(s),
    pollIntervalMs: 0,
    maxPolls: 5
  });
  assert.equal(status, "failed");
  assert.equal(out.join(""), "done log\n");
});

test("streamJobLog is bounded by maxPolls so a never-terminal job cannot loop forever", async () => {
  let sleeps = 0;
  const status = await streamJobLog({
    readChunk: () => "",
    readStatus: () => "running",
    sleep: async () => {
      sleeps += 1;
    },
    write: () => {},
    pollIntervalMs: 0,
    maxPolls: 3
  });
  assert.equal(status, "running");
  assert.equal(sleeps, 2, "with maxPolls=3 the loop sleeps twice then stops on the 3rd poll");
});

test("streamJobLog gives up (returns null) after maxConsecutiveNullStatus unreadable status reads", async () => {
  // The per-job record was pruned / resolves to the wrong dir: status is null
  // forever. The tail must NOT loop indefinitely — it degrades to a clean stop.
  let polls = 0;
  const status = await streamJobLog({
    readChunk: () => "",
    readStatus: () => null,
    sleep: async () => {
      polls += 1;
    },
    write: () => {},
    pollIntervalMs: 0,
    maxConsecutiveNullStatus: 3,
    maxPolls: 100000 // not the bound under test
  });
  assert.equal(status, null, "an unreadable status must end the tail, not hang");
  assert.ok(polls <= 3, `must stop quickly on persistent null status; slept ${polls} times`);
});

test("streamJobLog resets the null-status run when a readable status reappears", async () => {
  const statuses = [null, null, "running", null, null, "completed"];
  let i = 0;
  const status = await streamJobLog({
    readChunk: () => "",
    readStatus: () => statuses[i++] ?? "completed",
    sleep: async () => {},
    write: () => {},
    pollIntervalMs: 0,
    maxConsecutiveNullStatus: 3, // 3 consecutive nulls would stop; the run never reaches 3
    maxPolls: 100
  });
  assert.equal(status, "completed", "a transient null must not abort a job that is still reporting");
});

test("handleAttach observes the terminal status of a cross-workspace job via its physical state dir", async () => {
  const stateRoot = path.join(process.env.CLAUDE_PLUGIN_DATA, "state");
  const physicalDir = path.join(stateRoot, "projF-1234567890abcdef"); // name != re-derived slug-hash
  const jobsDir = path.join(physicalDir, "jobs");
  const jobDir = path.join(jobsDir, "task-xross");
  fs.mkdirSync(jobDir, { recursive: true });
  const logFile = path.join(jobDir, "log");
  fs.writeFileSync(logFile, "[12:00:00] cross-workspace log line\n");
  const job = {
    id: "task-xross",
    workspaceRoot: "/home/user/projF", // re-derives to a DIFFERENT slug-hash than physicalDir
    status: "completed",
    phase: "done",
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z"
  };
  fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(job));

  const out = [];
  const status = await handleAttach(["task-xross", "--cwd", makeTempDir()], {
    write: (s) => out.push(s),
    sleep: async () => {},
    pollIntervalMs: 0,
    maxPolls: 5
  });
  assert.equal(status, "completed", "must read status from the job's physical state dir, not a re-derived path");
  assert.match(out.join(""), /cross-workspace log line/);
});

test("handleAttach tails a real job log from disk and exits when the job is terminal", async () => {
  const workspace = makeTempDir();
  const jobId = "task-attach-1";
  const logFile = resolveJobLogFile(workspace, jobId);
  appendLogLine(logFile, "first line");
  appendLogLine(logFile, "second line");
  const job = {
    id: jobId,
    workspaceRoot: workspace,
    sessionId: "S1",
    status: "completed",
    phase: "done",
    logFile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z"
  };
  writeJobFile(workspace, jobId, job);
  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs: [job] });

  const out = [];
  const status = await handleAttach([jobId, "--cwd", workspace], {
    write: (s) => out.push(s),
    sleep: async () => {},
    pollIntervalMs: 0,
    maxPolls: 5
  });
  assert.equal(status, "completed");
  assert.match(out.join(""), /first line/);
  assert.match(out.join(""), /second line/);
});

test("makeUtf8LogReader reassembles a multibyte char (é = C3 A9) split across two poll reads", async () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, "utf8-split.log");
  const reader = makeUtf8LogReader(logFile);

  // Write only the first byte of é (U+00E9 = 0xC3 0xA9 in UTF-8).
  fs.writeFileSync(logFile, Buffer.from([0xc3]));
  const first = reader.readChunk();
  assert.equal(first, "", "incomplete multibyte sequence should not emit a replacement char");
  assert.ok(!first.includes("�"), "no replacement char from first partial byte");

  fs.appendFileSync(logFile, Buffer.from([0xa9]));
  const second = reader.readChunk();
  assert.equal(second, "é", "second read must deliver the complete character");
  assert.ok(!second.includes("�"), "no replacement char after completing the sequence");

  const combined = first + second;
  assert.equal(combined, "é");
  assert.ok(!combined.includes("�"), "combined output must not contain a replacement char");
});
