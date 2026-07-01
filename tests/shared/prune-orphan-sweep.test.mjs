// R4: a prune that crashes AFTER unlinking job.json but BEFORE rmSync(dir) leaves
// a "zombie" dir holding only terminal.lock. listJobs/readJob skip a dir with no
// job.json, so no recovery path ever reaps it — a slow disk leak unique to the
// directory-per-job layout. pruneJobs must sweep such lock-only dirs, WITHOUT
// touching an in-flight new job dir (createJob writes prompt.txt before job.json,
// and a finalize can only claim the lock once job.json exists — so a dir with a
// lock and no job.json can only be prune debris).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pruneJobs,
  jobDir,
  jobFilePath,
  lockFilePath,
} from "../../shared/lib/core/state-store.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-sweep-"));

test("pruneJobs reaps a lock-only zombie dir left by a crash between the job.json and terminal.lock unlinks", () => {
  const s = tmp();
  const id = "task-zombie";
  const dir = jobDir(s, id);
  fs.mkdirSync(dir, { recursive: true });
  // Complete terminal claim + leftover log, but job.json already unlinked.
  fs.writeFileSync(lockFilePath(s, id), JSON.stringify({ pid: 999999, status: "completed", at: "2026-01-01T00:00:00.000Z" }));
  fs.writeFileSync(path.join(dir, "log"), "leftover log\n");
  assert.equal(fs.existsSync(jobFilePath(s, id)), false, "precondition: no job.json");
  assert.equal(fs.existsSync(lockFilePath(s, id)), true, "precondition: lock present");

  pruneJobs(s);

  assert.equal(fs.existsSync(dir), false, "the lock-only zombie dir must be reaped");
});

test("pruneJobs leaves an in-flight new job dir alone (prompt.txt written, no job.json, NO lock)", () => {
  const s = tmp();
  const id = "task-inflight";
  const dir = jobDir(s, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prompt.txt"), "a prompt"); // createJob's pre-job.json window

  pruneJobs(s);

  assert.equal(fs.existsSync(dir), true, "an in-flight dir with no terminal.lock must NOT be swept");
});
