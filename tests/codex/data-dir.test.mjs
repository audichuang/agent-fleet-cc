import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { SKILL_VERSION } from "../../skills/codex/scripts/lib/app-server.mjs";
import { resolveDataDir, resolveJobLogFile, saveState, writeJobFile } from "../../skills/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_ROOT = path.join(ROOT, "skills", "codex");

test("the data dir is CODEX_COMPANION_DATA, else a fixed per-user dir", () => {
  const home = path.join(path.sep, "home", "u");
  assert.equal(resolveDataDir({ CODEX_COMPANION_DATA: "/x/y" }, home), "/x/y");
  assert.equal(resolveDataDir({}, home), path.join(home, ".local", "state", "codex-companion"));
});

// The retired Claude Code plugin kept jobs under ~/.claude/plugins/data/codex-<marketplace>/.
// A job launched by it (still running when the skill took over) must stay reachable by id.
test("a job written by the retired plugin is still found by id", () => {
  const home = fs.realpathSync(makeTempDir());
  const workspace = makeTempDir();
  const legacyData = path.join(home, ".claude", "plugins", "data", "codex-agent-fleet");

  const saved = process.env.CODEX_COMPANION_DATA;
  process.env.CODEX_COMPANION_DATA = legacyData; // seed where the plugin used to write
  try {
    const job = {
      id: "task-kept", workspaceRoot: workspace, sessionId: "S1", status: "completed", phase: "done",
      jobClass: "task", title: "Codex Task", logFile: resolveJobLogFile(workspace, "task-kept"),
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z", result: { rawOutput: "kept result" }
    };
    writeJobFile(workspace, job.id, job);
    saveState(workspace, { version: 1, config: { stopReviewGate: true }, jobs: [job] });
  } finally {
    process.env.CODEX_COMPANION_DATA = saved;
  }

  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: "S1" };
  delete env.CODEX_COMPANION_DATA;
  const companion = path.join(SKILL_ROOT, "scripts", "codex-companion.mjs");

  const result = run("node", [companion, "result", "task-kept", "--cwd", workspace, "--json"], { cwd: workspace, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.id, "task-kept");
});

test("the app-server clientInfo version is the skill's metadata.version", () => {
  const fm = fs.readFileSync(path.join(SKILL_ROOT, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/)[1];
  assert.equal(SKILL_VERSION, fm.match(/version:\s*"?([\d.]+)"?/)[1]);
});
