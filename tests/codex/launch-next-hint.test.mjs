import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "skills", "codex", "scripts", "codex-companion.mjs");

// Hosts that never loaded the skill drove background jobs from the launch output alone: they
// copied `signalFile` into `until [ -f … ]` loops and piped `result` into head/tail. The launch
// output now says how to follow the job instead, and no longer hands out the signal file.

function launch(args) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const launched = run("node", [SCRIPT, ...args], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(launched.status, 0, launched.stderr);
  return { repo, binDir, launched };
}

test("a background launch's JSON says how to follow the job, last, and names no signal file", () => {
  const { launched } = launch(["task", "--background", "--json", "investigate the failing test"]);
  const payload = JSON.parse(launched.stdout);

  assert.equal("signalFile" in payload, false);
  const keys = Object.keys(payload);
  assert.equal(keys[keys.length - 1], "next");
  assert.match(payload.next, new RegExp(`\`wait ${payload.jobId}\``));
  assert.match(payload.next, /exit 10 means it is still running/);
  assert.match(payload.next, new RegExp(`\`result ${payload.jobId} > <file>\` and read the whole file`));

  // A launch cut by `| tail -3` (seen in real sessions, which lost the jobId) still shows the id.
  const tail = launched.stdout.trimEnd().split("\n").slice(-3).join("\n");
  assert.match(tail, new RegExp(payload.jobId));
});

test("the plain-text launch line carries the same follow-up and keeps the dispatch sentinel", () => {
  const { launched } = launch(["task", "--background", "investigate the failing test"]);
  const id = launched.stdout.match(/started in the background as (\S+)\./)?.[1];
  assert.ok(id, launched.stdout);
  assert.match(launched.stdout, new RegExp(`Wait with \`wait ${id}\``));
  assert.doesNotMatch(launched.stdout, /Check `status/);
  assert.match(launched.stdout, new RegExp(`\\[\\[codex-task status=dispatched id=${id}\\]\\]`));
});

test("the follow-up works as written: wait and result by id alone, from another directory", () => {
  const { binDir, launched } = launch(["task", "--background", "--json", "investigate the failing test"]);
  const { jobId } = JSON.parse(launched.stdout);
  const elsewhere = makeTempDir();

  const waited = run("node", [SCRIPT, "wait", jobId, "--timeout-ms", "15000"], { cwd: elsewhere, env: buildEnv(binDir) });
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);

  const result = run("node", [SCRIPT, "result", jobId], { cwd: elsewhere, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
});
