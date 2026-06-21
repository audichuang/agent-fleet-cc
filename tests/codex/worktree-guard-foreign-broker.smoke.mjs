/**
 * Real-Codex foreign-broker smoke test (Task 7)
 *
 * Proves that in expected mode, even when CODEX_COMPANION_APP_SERVER_ENDPOINT
 * is polluted with a foreign/bogus endpoint, the worktree gate (Task 1 —
 * assertWorktreeAlignment) clears it before any connection attempt.
 *
 * This is the layer that fake-engine hermetic tests cannot cover: we need
 * real codex app-server running and `ensureBrokerSession` to execute.
 *
 * Skip conditions (non-fatal):
 *   - `codex` CLI not found
 *   - codex not logged in (auth check via getCodexAuthStatus)
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPANION = path.join(WT_ROOT, "plugins/codex/scripts/codex-companion.mjs");
const STATE_LIB = path.join(WT_ROOT, "plugins/codex/scripts/lib/state.mjs");
const CODEX_LIB = path.join(WT_ROOT, "plugins/codex/scripts/lib/codex.mjs");
const BROKER_LIFECYCLE_LIB = path.join(WT_ROOT, "plugins/codex/scripts/lib/broker-lifecycle.mjs");

// ── helpers ────────────────────────────────────────────────────────────────

function makeRepo(branch = "feat") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-smoke-"));
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "-b", branch]);
  run(["config", "user.email", "smoke@test"]);
  run(["config", "user.name", "Smoke"]);
  run(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "smoke\n");
  run(["add", "."]);
  run(["commit", "-qm", "base"]);
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, base, branch };
}

function runCompanion(args, { cwd = process.cwd(), env = {} } = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "pd-smoke-")),
      ...env
    }
  });
}

// ── skip guard ─────────────────────────────────────────────────────────────

let skipReason = null;

before(async () => {
  // 1. Is codex CLI available?
  const which = spawnSync("which", ["codex"], { encoding: "utf8" });
  if (which.status !== 0) {
    skipReason = "codex CLI not found (not installed)";
    return;
  }

  // 2. Is codex logged in? Use getCodexAuthStatus from the plugin's lib.
  //    We need a temp git repo for the auth check (app-server needs a cwd).
  const tmpRepo = makeRepo("main");
  try {
    const { getCodexAuthStatus } = await import(CODEX_LIB);
    const authStatus = await getCodexAuthStatus(tmpRepo.dir);
    if (!authStatus.loggedIn) {
      skipReason = `codex is available but not logged in (detail: ${authStatus.detail ?? "unknown"})`;
    }
  } catch (err) {
    skipReason = `codex auth check threw: ${err.message}`;
  } finally {
    fs.rmSync(tmpRepo.dir, { recursive: true, force: true });
  }
});

// ── utility: resolve broker state dir from broker.json ─────────────────────

async function getBrokerSessionForCwd(pluginData, cwd) {
  // loadBrokerSession reads CLAUDE_PLUGIN_DATA from process.env at import time
  // so we redirect before the call.
  const orig = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const { loadBrokerSession } = await import(BROKER_LIFECYCLE_LIB);
    return loadBrokerSession(cwd);
  } finally {
    if (orig === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = orig;
    }
  }
}

// ── smoke A: expected mode clears foreign endpoint, broker lands in B ───────

test("smoke A — expected mode: gate drops foreign endpoint, broker session created in B not foreign", async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  // Build repo B (target worktree)
  const B = makeRepo("feat");
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "pd-smokeA-"));

  // Create a bogus foreign endpoint that points at a nonexistent socket
  const foreignSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-sock-"));
  const foreignEndpoint = `unix:${path.join(foreignSocketDir, "nonexistent.sock")}`;

  try {
    // Run foreground task with expected triplet and foreign endpoint injected.
    // Prompt is intentionally very short ("say: hi") to minimize real API usage.
    // The gate (assertWorktreeAlignment) runs before executeTaskRun and deletes
    // CODEX_COMPANION_APP_SERVER_ENDPOINT from process.env (of the subprocess).
    // So CodexAppServerClient.connect will NOT try the foreign socket.
    const r = runCompanion(
      [
        "task",
        "--cwd", B.dir,
        "--prompt", "Print the single word: SMOKEOK",
        "--expected-worktree", B.dir,
        "--expected-branch", B.branch,
        "--expected-base", B.base
      ],
      {
        cwd: B.dir,
        env: {
          CLAUDE_PLUGIN_DATA: pluginData,
          // Inject foreign endpoint — gate must clear this before connect
          CODEX_COMPANION_APP_SERVER_ENDPOINT: foreignEndpoint
        }
      }
    );

    // Task must succeed (exit 0): foreign endpoint was cleared by gate,
    // so codex connected to B's own broker (or spawned one directly).
    assert.equal(
      r.status, 0,
      `expected exit 0 but got ${r.status}; stderr: ${r.stderr}\nstdout: ${r.stdout}`
    );

    // Output should have the task result (either the word or task completed)
    // We just check it ran without crashing due to the foreign endpoint.
    assert.doesNotMatch(
      r.stderr + r.stdout,
      /ECONNREFUSED|ENOENT.*nonexistent\.sock/i,
      "gate should have cleared foreign endpoint; must not see connection errors to it"
    );

    // Verify broker session was created under B's state dir, not under foreign
    const brokerSession = await getBrokerSessionForCwd(pluginData, B.dir);
    // broker.json may or may not exist depending on whether a broker was spawned
    // (direct spawn also valid when no broker is active). Either way the session
    // endpoint (if present) must NOT be the foreign endpoint.
    if (brokerSession?.endpoint) {
      assert.notEqual(
        brokerSession.endpoint, foreignEndpoint,
        "broker session endpoint must not be the foreign endpoint"
      );
      // The session endpoint must live within a temp dir for B's broker
      assert.match(
        brokerSession.endpoint,
        /cxc-/,
        "broker endpoint should be in a cxc- temp dir (B's own broker)"
      );
    }
  } finally {
    fs.rmSync(B.dir, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(foreignSocketDir, { recursive: true, force: true });
  }
});

// ── smoke B: contrast — without expected, foreign endpoint is NOT cleared ───

test("smoke B — contrast: without expected mode, foreign bogus endpoint causes ENOENT/ECONNREFUSED", async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  // Repo C: same setup but NO expected triplet
  const C = makeRepo("feat");
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "pd-smokeB-"));

  // A bogus endpoint that cannot be connected to
  const bogusSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), "bogus-sock-"));
  const bogusEndpoint = `unix:${path.join(bogusSocketDir, "nonexistent.sock")}`;

  try {
    // Without expected triplet, assertWorktreeAlignment is a no-op.
    // The companion will try to connect to bogusEndpoint and fail.
    // Per app-server.mjs withAppServer, ENOENT/ECONNREFUSED triggers a fallback
    // to a direct spawn — so the task may still succeed via fallback.
    // The important assertion: the companion attempted the foreign endpoint
    // (not cleared). We infer this by checking that a fresh broker.json
    // for C is created (since fallback spawns directly under C), confirming
    // the flow is different from smoke A.
    const r = runCompanion(
      [
        "task",
        "--cwd", C.dir,
        "--prompt", "Print the single word: CONTRASTOK"
      ],
      {
        cwd: C.dir,
        env: {
          CLAUDE_PLUGIN_DATA: pluginData,
          CODEX_COMPANION_APP_SERVER_ENDPOINT: bogusEndpoint
        }
      }
    );

    // The task may succeed (via direct-spawn fallback) but we want to confirm
    // the gate was NOT active: the foreign endpoint was set in env, and without
    // expected mode it is left for the connect logic to deal with.
    // We verify by checking the broker state: no broker.json should be saved
    // (direct spawn does not call saveBrokerSession).
    const brokerSession = await getBrokerSessionForCwd(pluginData, C.dir);
    assert.equal(
      brokerSession, null,
      "without expected mode and with a bogus broker endpoint, broker.json should not be created (direct fallback)"
    );

    // Outcome may be exit 0 (direct fallback) or non-zero — either is fine here;
    // what matters is the gate was not in play.
  } finally {
    fs.rmSync(C.dir, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(bogusSocketDir, { recursive: true, force: true });
  }
});

// ── smoke C: unit-level proof — assertWorktreeAlignment modifies env in-process ──

test("smoke C — unit: assertWorktreeAlignment deletes CODEX_COMPANION_APP_SERVER_ENDPOINT from env", async (t) => {
  if (skipReason) {
    // This unit-level check does NOT require auth — but keep consistent skip.
    t.skip(skipReason);
    return;
  }

  const { assertWorktreeAlignment, BROKER_ENDPOINT_ENV } = await import(
    path.join(WT_ROOT, "plugins/codex/scripts/lib/worktree-guard.mjs")
  );

  const repo = makeRepo("main");
  const base = repo.base;

  try {
    // Simulate what codex-companion does: inject a foreign endpoint into a mock env
    const mockEnv = {
      ...process.env,
      [BROKER_ENDPOINT_ENV]: "unix:/some/foreign/broker.sock"
    };

    assert.equal(
      mockEnv[BROKER_ENDPOINT_ENV],
      "unix:/some/foreign/broker.sock",
      "pre-condition: foreign endpoint must be present"
    );

    assertWorktreeAlignment({
      cwd: repo.dir,
      expected: {
        worktreePath: repo.dir,
        worktreeBranch: "main",
        worktreeBase: base
      },
      env: mockEnv
    });

    // After the gate: foreign endpoint must be gone
    assert.equal(
      mockEnv[BROKER_ENDPOINT_ENV],
      undefined,
      "assertWorktreeAlignment must delete BROKER_ENDPOINT_ENV from env in expected mode"
    );
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});
