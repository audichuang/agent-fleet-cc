// tests/shared/state-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { readEvents } from "../../shared/lib/core/events.mjs";
import {
  jobDir,
  jobFilePath,
  promptFilePath,
  logFilePath,
  createJob,
  readJob,
  writeJob,
  listJobs,
} from "../../shared/lib/core/state-store.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-store-"));

test("createJob lays out per-job directory with 0600 artifacts", () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "delegate", title: "t" });
  createJob(stateDir, record, "do the thing");
  assert.equal(readJob(stateDir, record.id).title, "t");
  assert.equal(fs.readFileSync(promptFilePath(stateDir, record.id), "utf8"), "do the thing");
  const jobFileMode = fs.statSync(jobFilePath(stateDir, record.id)).mode & 0o777;
  assert.equal(jobFileMode, 0o600);
  const promptFileMode = fs.statSync(promptFilePath(stateDir, record.id)).mode & 0o777;
  assert.equal(promptFileMode, 0o600);
  const jobDirMode = fs.statSync(jobDir(stateDir, record.id)).mode & 0o777;
  assert.equal(jobDirMode, 0o700);
  const events = readEvents(jobDir(stateDir, record.id));
  assert.equal(events[0].type, "job-created");
  assert.equal(events[0].engine, "delegate");
});

test("writeJob stamps updatedAt atomically; readJob null on missing/corrupt", () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "delegate" });
  createJob(stateDir, record, "p");
  const before = readJob(stateDir, record.id).updatedAt;
  // Ensure clock advances strictly so updatedAt must be strictly greater
  const busyWaitUntilNewMs = () => {
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }
  };
  busyWaitUntilNewMs();
  writeJob(stateDir, { ...record, phase: "working" });
  const after = readJob(stateDir, record.id);
  assert.equal(after.phase, "working");
  assert.ok(after.updatedAt > before, `updatedAt must strictly advance: ${after.updatedAt} > ${before}`);
  assert.equal(readJob(stateDir, "nope"), null);
  fs.writeFileSync(jobFilePath(stateDir, record.id), "{broken");
  assert.equal(readJob(stateDir, record.id), null);
});

test("listJobs scans job dirs, skips corrupt, sorts newest first", () => {
  const stateDir = tmp();
  const a = createJobRecord({ engine: "delegate", now: new Date(1000) });
  const b = createJobRecord({ engine: "delegate", now: new Date(2000) });
  createJob(stateDir, a, "a");
  createJob(stateDir, b, "b");
  // junk-dir: no job.json at all — listJobs must skip
  fs.mkdirSync(path.join(stateDir, "jobs", "junk-dir"), { recursive: true });
  // corrupt-dir: job.json exists but contains invalid JSON — listJobs must skip
  const corruptDir = path.join(stateDir, "jobs", "corrupt-dir");
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, "job.json"), "{not valid json", { mode: 0o600 });
  const jobs = listJobs(stateDir);
  assert.deepEqual(jobs.map((j) => j.id), [b.id, a.id]);
  assert.equal(logFilePath(stateDir, a.id), path.join(stateDir, "jobs", a.id, "log"));
});
