// Black-box e2e: drives a copied fleet-status.mjs as a subprocess against a fake plugin tree.

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
