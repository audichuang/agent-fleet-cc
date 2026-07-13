// Black-box e2e: drives the real fleet CLIs as subprocesses.
//  - fleet-status.mjs against a fake plugin tree (it resolves sibling scripts).
//  - fleet-doctor.mjs directly (it probes binaries, not siblings) — this is the
//    exact executable /fleet:setup Step 2 runs, so it is the setup flow's e2e.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REAL_SCRIPT = path.join(ROOT, "plugins/fleet/scripts/fleet-status.mjs");
const REAL_CLI_ARGS = path.join(ROOT, "plugins/fleet/scripts/lib/cli-args.mjs");
const REAL_DOCTOR = path.join(ROOT, "plugins/fleet/scripts/fleet-doctor.mjs");

function ws() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-"));
}

function writeFakeScript(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const source = [
    "process.argv;",
    `console.log(JSON.stringify(${JSON.stringify(payload)}));`,
    "",
  ].join("\n");
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

function fakeTree(payloads) {
  const root = ws();
  const fleetScript = path.join(root, "fleet/scripts/fleet-status.mjs");
  fs.mkdirSync(path.dirname(fleetScript), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, fleetScript);
  fs.mkdirSync(path.join(root, "fleet/scripts/lib"), { recursive: true });
  fs.copyFileSync(REAL_CLI_ARGS, path.join(root, "fleet/scripts/lib/cli-args.mjs"));
  writeFakeScript(path.join(root, "codex/scripts/codex-companion.mjs"), payloads.codex ?? []);
  writeFakeScript(path.join(root, "antigravity/scripts/commands/status.mjs"), payloads.antigravity ?? []);
  writeFakeScript(path.join(root, "cc/scripts/cc-companion.mjs"), payloads.cc ?? []);
  return { root, fleetScript };
}

function runFleet(payloads, args) {
  const { root, fleetScript } = fakeTree(payloads);
  return spawnSync(process.execPath, [fleetScript, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
}

test("e2e: unrecognized engine status JSON is rendered as unknown, not idle", () => {
  const res = runFleet(
    {
      codex: { unexpected: true },
    },
    ["--only", "codex", "--json"],
  );
  assert.equal(res.status, 0, res.stderr);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.rows.length, 1);
  assert.equal(doc.rows[0].engine, "codex");
  assert.equal(doc.rows[0].status, "unknown");
  assert.notEqual(doc.rows[0].status, "idle");
});

test("e2e: running codex job offers logs action without redundant attach action", () => {
  const res = runFleet(
    {
      codex: { running: [{ id: "codex-1", status: "running" }], recent: [] },
    },
    ["--only", "codex", "--json"],
  );
  assert.equal(res.status, 0, res.stderr);
  const doc = JSON.parse(res.stdout);
  const row = doc.rows.find((r) => r.engine === "codex");
  assert.ok(row.actions.includes("/codex:logs codex-1"), "logs action present");
  assert.ok(!row.actions.includes("/codex:attach codex-1"), "attach is redundant with logs");
});

// --- setup flow e2e: the real fleet-doctor subprocess /fleet:setup Step 2 runs ---
// fleet-doctor probes binaries (not sibling scripts), so it runs from its real
// location. A fake engine binary makes a --version probe report "ready" without
// a live CLI; GROK_BIN lets us point checkGrok at (or away from) it hermetically.

function fakeBinary(dir, name, versionLine) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "${versionLine}"\n`, { encoding: "utf8", mode: 0o755 });
  return p;
}

function runDoctor(args, env = {}) {
  return spawnSync(process.execPath, [REAL_DOCTOR, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...env },
  });
}

test("e2e (setup): fleet-doctor over the full setup engine set includes a grok verdict", () => {
  // /fleet:setup Step 2 runs exactly: fleet-doctor --json --only <chosen engines>.
  const res = runDoctor(["--json", "--only", "codex,antigravity,cc,grok"], { HOME: ws() });
  assert.equal(res.status, 0, res.stderr);
  const doc = JSON.parse(res.stdout);
  assert.deepEqual(doc.checkedEngines, ["codex", "antigravity", "cc", "grok"]);
  const grok = doc.engines.grok;
  assert.equal(grok.engine, "grok");
  assert.ok(grok.status === "ready" || grok.status === "not-ready", "grok has a real verdict, not a stub");
  assert.notEqual(grok.summary, "stub");
  assert.equal(grok.authVerified, false);
});

test("e2e (setup): a real grok binary (via GROK_BIN) reports grok ready", () => {
  const dir = ws();
  const grokBin = fakeBinary(dir, "grok", "grok 4.5.0");
  const res = runDoctor(["--json", "--only", "grok"], { HOME: dir, GROK_BIN: grokBin });
  assert.equal(res.status, 0, res.stderr);
  const grok = JSON.parse(res.stdout).engines.grok;
  assert.equal(grok.status, "ready");
  assert.equal(grok.version, "grok 4.5.0");
  assert.equal(grok.deepFixCommand, null);
});

test("e2e (setup): missing grok binary → not-ready, routes /grok:setup", () => {
  const dir = ws();
  const res = runDoctor(["--json", "--only", "grok"], {
    HOME: dir,
    GROK_BIN: path.join(dir, "no-such-grok"),
  });
  assert.equal(res.status, 0, res.stderr);
  const grok = JSON.parse(res.stdout).engines.grok;
  assert.equal(grok.status, "not-ready");
  assert.equal(grok.reason, "binary-missing");
  assert.equal(grok.deepFixCommand, "/grok:setup");
});
