// R3: the reconcile lock-repair branch re-reads job.json then writeJob()s the
// repaired record. writeJob → writeJsonAtomic mkdir's the dir recursively, so if a
// concurrent prune deleted the dir between the fresh-read and the write, the write
// RESURRECTS a dir prune meant to evict (cross-process TOCTOU). The fix: lock-repair
// must write with ensureDir:false, so a vanished dir makes the write fail cleanly
// instead of recreating it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import {
  createJob,
  readJob,
  writeJob,
  jobDir,
  lockFilePath,
} from "../../shared/lib/core/state-store.mjs";
import { reconcileDeadPids } from "../../shared/lib/core/reconcile.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-norez-"));

// R3a — the core unit: writeJob({ensureDir:false}) must NOT recreate a pruned dir.
test("writeJob with ensureDir:false fails cleanly instead of resurrecting a deleted job dir", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  fs.rmSync(jobDir(s, j.id), { recursive: true, force: true }); // simulate prune

  assert.throws(
    () => writeJob(s, { ...j, status: "failed" }, { ensureDir: false }),
    "a write into a vanished dir must throw, not silently recreate it"
  );
  assert.equal(fs.existsSync(jobDir(s, j.id)), false, "must not recreate the pruned dir");
});

// R3b — integration: lock-repair must not resurrect a dir pruned AFTER its fresh-read.
test("reconcile lock-repair does not resurrect a job whose dir is pruned after the fresh-read", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  // active record + orphan COMPLETE claim by a dead claimer → lock-repair branch fires
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  fs.writeFileSync(
    lockFilePath(s, j.id),
    JSON.stringify({ pid: 88888, status: "failed", at: "2026-01-01T00:00:00.000Z" })
  );

  reconcileDeadPids(s, {
    isAlive: () => false, // claimer dead → orphan → enters lock-repair
    _hooks: {
      // a concurrent prune deletes the whole dir AFTER the fresh-read, BEFORE the write
      afterFreshRead: (id) => fs.rmSync(jobDir(s, id), { recursive: true, force: true }),
    },
  });

  assert.equal(fs.existsSync(jobDir(s, j.id)), false, "lock-repair must not recreate a dir pruned mid-repair");
});
