import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { saveBrokerSession } from "../../skills/codex/scripts/lib/broker-lifecycle.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV } from "../../skills/codex/scripts/lib/app-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "skills", "codex", "scripts", "codex-companion.mjs");

// A broker that died leaves broker.json behind. setup used to connect to it, get ENOENT on
// the vanished socket, and report a logged-out account: hindsight, 2026-10-20, printed
// "auth: connect ENOENT …/broker.sock" and "Run !codex login" while the login was fine,
// and an hour later the same setup said "direct startup" with the login active.
function deadPid() {
  const child = spawnSync("true");
  return child.pid;
}

function setupWith(session) {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  saveBrokerSession(workspace, session);
  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: workspace, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("setup ignores a recorded broker whose pid is dead", () => {
  const gone = path.join(makeTempDir(), "gone");
  const payload = setupWith({ endpoint: `unix:${path.join(gone, "broker.sock")}`, pid: deadPid(), sessionDir: gone });
  assert.equal(payload.auth.loggedIn, true, payload.auth.detail);
  assert.equal(payload.sessionRuntime.mode, "direct", "a dead broker is not a shared session");
  assert.equal(payload.ready, true);
});

test("setup checks auth directly when the recorded broker socket is gone", () => {
  // No pid recorded, so death cannot be proven up front; the failed connect has to fall back.
  const gone = path.join(makeTempDir(), "gone");
  const payload = setupWith({ endpoint: `unix:${path.join(gone, "broker.sock")}` });
  assert.equal(payload.auth.loggedIn, true, payload.auth.detail);
  assert.doesNotMatch(JSON.stringify(payload.nextSteps ?? []), /codex login/);
});

// The other half of the same false logout: a LIVE broker busy streaming another job answers
// `initialize` itself and refuses every later request with -32001. Setup read that refusal
// as a logged-out account; a read-only query should go to a direct app-server instead.
test("setup checks auth directly while the shared broker is busy", async () => {
  const net = await import("node:net");
  const sockDir = makeTempDir();
  const sock = path.join(sockDir, "busy.sock");
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === undefined) continue;
        const reply = message.method === "initialize"
          ? { id: message.id, result: { userAgent: "busy-broker" } }
          : { id: message.id, error: { code: BROKER_BUSY_RPC_CODE, message: "Shared Codex broker is busy." } };
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  try {
    const workspace = makeTempDir();
    const binDir = makeTempDir();
    installFakeCodex(binDir);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, "setup", "--json"], {
        cwd: workspace,
        env: { ...buildEnv(binDir), [BROKER_ENDPOINT_ENV]: `unix:${sock}` }
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", (status) => resolve({ status, stdout }));
    });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.auth.loggedIn, true, payload.auth.detail);
    assert.doesNotMatch(JSON.stringify(payload.nextSteps ?? []), /codex login/);
  } finally {
    server.close();
  }
});
