// R4 (codex side): codex's saveState does a TARGETED per-job delete (unlink
// job.json/log/done.json/terminal.lock then rmSync the dir). A crash between the
// job.json unlink and the rmSync leaves a lock-only zombie dir that codex's
// directory-scan readers (listJobs) skip forever. saveState must sweep such
// orphan-lock dirs, without disturbing an in-flight new job dir (no lock).
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobLogFile, saveState } from "../../plugins/codex/scripts/lib/state.mjs";

const EMPTY_STATE = { version: 1, config: { stopReviewGate: false }, jobs: [] };

test("R4: codex saveState reaps a lock-only zombie dir (crash between job.json unlink and rmSync)", () => {
  const workspace = makeTempDir();
  const id = "task-codex-zombie";
  const dir = path.dirname(resolveJobLogFile(workspace, id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "terminal.lock"), JSON.stringify({ pid: 999999, status: "completed", at: "2026-01-01T00:00:00.000Z" }));
  fs.writeFileSync(path.join(dir, "log"), "leftover\n");
  // job.json absent — the zombie.

  saveState(workspace, EMPTY_STATE);

  assert.equal(fs.existsSync(dir), false, "saveState must reap the lock-only zombie dir");
});

test("R4: codex saveState leaves an in-flight new job dir alone (no terminal.lock)", () => {
  const workspace = makeTempDir();
  const id = "task-codex-inflight";
  const dir = path.dirname(resolveJobLogFile(workspace, id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "prompt.txt"), "a prompt");

  saveState(workspace, EMPTY_STATE);

  assert.equal(fs.existsSync(dir), true, "an in-flight dir with no lock must NOT be swept");
});
