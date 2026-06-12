// tests/shared/prune.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import {
  createJob,
  finalizeJob,
  pruneJobs,
  listJobs,
  jobDir,
} from "../../shared/lib/core/state-store.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-prune-"));

function mkTerminal(stateDir, ts) {
  const r = createJobRecord({ engine: "delegate", now: new Date(ts) });
  createJob(stateDir, r, "p");
  finalizeJob(stateDir, r.id, { status: "completed" });
  return r;
}

test("prune keeps newest terminal jobs up to max minus active", () => {
  const s = tmp();
  const old1 = mkTerminal(s, 1000);
  const old2 = mkTerminal(s, 2000);
  const keep = mkTerminal(s, 3000);
  const active = createJobRecord({ engine: "delegate", now: new Date(4000) });
  createJob(s, active, "p"); // queued — 不可被 prune
  pruneJobs(s, { max: 2 }); // 2 - 1 active = 保 1 個 terminal
  const ids = listJobs(s).map((j) => j.id).sort();
  assert.deepEqual(ids, [active.id, keep.id].sort());
  assert.equal(fs.existsSync(jobDir(s, old1.id)), false); // 整目錄消失
  assert.equal(fs.existsSync(jobDir(s, old2.id)), false);
});

test("prune never removes active jobs even when over max", () => {
  const s = tmp();
  const a = createJobRecord({ engine: "delegate" });
  createJob(s, a, "p");
  pruneJobs(s, { max: 0 });
  assert.equal(listJobs(s).length, 1);
});
