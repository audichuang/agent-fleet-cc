#!/usr/bin/env node
// real-engine-smoke.mjs — Layer-2 E2E: drive the REAL installed engines
// (codex / agy / claude) through a live background job and assert the
// cross-engine `wait` exit-code contract. This is a MANUAL gate: it spends real
// model tokens (jobs are cancelled within ~seconds to keep that minimal) and
// needs the engines to be authed. It is intentionally NOT part of `npm test`.
//
// What it asserts, per ready engine:
//   - launch a real background job, cancel it, `wait` -> exit 2 (cancelled)   [all]
//   - `wait --timeout-ms 0` on a still-active job returns FAST (no 240s block) [codex]
//
// It probes each engine's binary first and skips the ones that aren't there
// (only ENOENT means missing — a binary that runs and exits non-zero still
// counts as present, since auth is not checked here). It isolates each run in a
// temp workspace and prunes the job records it creates. Exit 0 if every ready
// engine honors the contract, else exit 1.
//
// Zero-dependency ESM. Read ../SKILL.md "Gotchas" for why each odd bit exists
// (multi-line JSON parsing, no-pid seeding, watchdog/self-match cleanup traps).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .claude/skills/e2e-testing/scripts -> repo root is 4 levels up.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function run(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 60000,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

// codex/antigravity `task --json` prints MULTI-LINE pretty JSON; never take the
// last line — parse the whole payload.
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Mirrors cc's resolveDataRoot (plugins/cc/scripts/lib/adapter.mjs) — kept in
// step by hand; cc is the only engine here whose data root is not the default.
function ccDataRoot() {
  return process.env.CC_PLUGIN_DATA
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), ".claude", "plugins", "data", "cc");
}

function dataRoots() {
  const roots = new Set();
  roots.add(process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), ".claude/plugins/data/codex-agent-fleet"));
  roots.add(ccDataRoot());
  return [...roots];
}

// Readiness = the binary is on PATH. ENOENT is the only signal that it is
// missing; a non-zero exit means it ran, which is enough to try a real job
// against (auth failures surface as the job failing, which is the point).
function binaryPresent(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
  return r.error?.code !== "ENOENT";
}

// cc launches under a profile; any valid-looking one will do for a smoke.
function firstCcProfile() {
  try {
    return fs.readdirSync(path.join(ccDataRoot(), "profiles"))
      .filter((f) => f.endsWith(".json"))
      .sort()[0]?.slice(0, -".json".length) ?? null;
  } catch {
    return null;
  }
}

function pruneState(roots, wsBase) {
  for (const root of roots) {
    const stateDir = path.join(root, "state");
    try {
      for (const entry of fs.readdirSync(stateDir)) {
        if (entry.startsWith(wsBase)) {
          fs.rmSync(path.join(stateDir, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // state dir may not exist for this engine — fine.
    }
  }
}

const ENGINES = {
  codex: {
    script: path.join(REPO, "plugins/codex/scripts/codex-companion.mjs"),
    binary: "codex",
    launch: (ws) => ["task", "smoke: reply with the single word ok", "--background", "--json"],
    cancel: (ws, id) => ["cancel", id, "--cwd", ws, "--json"],
    waitFor: (ws, id, ms) => ["wait", id, "--cwd", ws, "--timeout-ms", String(ms), "--json"],
  },
  antigravity: {
    script: path.join(REPO, "plugins/antigravity/bin/antigravity.mjs"),
    binary: "agy",
    launch: (ws) => ["task", "smoke: reply with the single word ok", "--background", "--json"],
    cancel: (ws, id) => ["cancel", id, "--json"],
    waitFor: (ws, id, ms) => ["wait", id, "--timeout-ms", String(ms), "--json"],
  },
  cc: {
    script: path.join(REPO, "plugins/cc/scripts/cc-companion.mjs"),
    binary: "claude",
    needsProfile: true,
    launch: (ws, profile) => ["task", "smoke: reply with the single word ok", "--profile", profile, "--background", "--json"],
    cancel: (ws, id) => ["cancel", id, "--json"],
    // cc wait takes SECONDS, the others take ms.
    waitFor: (ws, id, ms) => ["wait", id, "--timeout-s", String(Math.max(1, Math.round(ms / 1000))), "--json"],
  },
};

function smokeEngine(name, cfg, roots) {
  if (!binaryPresent(cfg.binary)) return { name, skipped: `${cfg.binary} not on PATH` };

  let profile = null;
  if (cfg.needsProfile) {
    profile = firstCcProfile();
    if (!profile) return { name, skipped: "binary present but no profile to launch a real job" };
  }

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `real-${name}-`));
  const wsBase = path.basename(ws);
  const checks = [];
  try {
    const launchArgs = cfg.needsProfile ? cfg.launch(ws, profile) : cfg.launch(ws);
    const launched = run([cfg.script, ...launchArgs], { cwd: ws, timeout: 60000 });
    const obj = parseJson(launched.stdout);
    const id = obj?.jobId;
    if (!id) {
      return { name, fail: `launch produced no jobId: ${(launched.stderr || launched.stdout || "").trim().slice(0, 200)}` };
    }

    // codex: prove --timeout-ms 0 returns fast (the falsy-zero fix) before cancel.
    if (name === "codex") {
      const t0 = Date.now();
      const w0 = run([cfg.script, ...cfg.waitFor(ws, id, 0)], { cwd: ws, timeout: 20000 });
      const dt = Date.now() - t0;
      checks.push({
        label: "wait --timeout-ms 0 returns fast (no 240s default block)",
        pass: dt < 10000,
        info: `${dt}ms, exit=${w0.status}`,
      });
    }

    // Parity: cancel -> wait -> exit 2 (cancelled). Holds even if the model
    // call never really started, because the job record exists and is cancellable.
    run([cfg.script, ...cfg.cancel(ws, id)], { cwd: ws, timeout: 30000 });
    const w = run([cfg.script, ...cfg.waitFor(ws, id, 15000)], { cwd: ws, timeout: 30000 });
    const proj = parseJson(w.stdout);
    const jobStatus = proj?.status ?? proj?.job?.status ?? "?";
    checks.push({
      label: "cancelled job -> wait exits 2",
      pass: w.status === 2,
      info: `exit=${w.status}, status=${jobStatus}`,
    });

    return { name, checks };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    pruneState(roots, wsBase);
  }
}

function main() {
  const roots = dataRoots();

  console.log("# Real-engine E2E smoke (live codex / agy / claude)\n");
  let failed = 0;
  let ran = 0;
  for (const [name, cfg] of Object.entries(ENGINES)) {
    const r = smokeEngine(name, cfg, roots);
    if (r.skipped) {
      console.log(`- ${name}: SKIP — ${r.skipped}`);
      continue;
    }
    if (r.fail) {
      failed++;
      console.log(`- ${name}: FAIL — ${r.fail}`);
      continue;
    }
    ran++;
    for (const c of r.checks) {
      if (!c.pass) failed++;
      console.log(`- ${name}: ${c.pass ? "PASS" : "FAIL"} — ${c.label}  (${c.info})`);
    }
  }

  console.log(`\nEngines exercised: ${ran}. Contract violations: ${failed}.`);
  console.log("Watchdogs for the cancelled jobs self-terminate once they read the terminal state.");
  process.exit(failed > 0 ? 1 : 0);
}

main();
