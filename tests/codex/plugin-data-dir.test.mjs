import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { derivePluginDataDir, resolveJobLogFile, saveState, writeJobFile } from "../../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

test("the data dir is derived from the install layout, whatever the plugins root is called", () => {
  const sep = path.sep;
  const at = (...parts) => ["", ...parts].join(sep);
  assert.equal(derivePluginDataDir(at("home", "u", ".claude", "plugins", "cache", "agent-fleet", "codex", "2.0.0")),
    at("home", "u", ".claude", "plugins", "data", "codex-agent-fleet"));
  // CLAUDE_CODE_PLUGIN_CACHE_DIR can relocate the root to a dir not named "plugins".
  assert.equal(derivePluginDataDir(at("srv", "cc-root", "cache", "agent-fleet", "codex", "2.0.0")),
    at("srv", "cc-root", "data", "codex-agent-fleet"));
  // The id is `<plugin>@<marketplace>` with anything outside [A-Za-z0-9_-] replaced by `-`.
  assert.equal(derivePluginDataDir(at("r", "cache", "my.market", "codex", "2.0.0")), at("r", "data", "codex-my-market"));
  assert.equal(derivePluginDataDir(PLUGIN_ROOT), null, "a repo checkout derives nothing");
  assert.equal(derivePluginDataDir(at("a", "b", "codex", "2.0.0")), null, "no cache/ level, no derivation");
});

// 2.0.0 removed the SessionStart hook, which was what exported CLAUDE_PLUGIN_DATA to Bash. A
// skill-driven call has no such variable, so without the derivation an upgraded install read
// the $TMPDIR fallback and every existing job vanished from status and result.
test("an installed companion finds existing jobs with CLAUDE_PLUGIN_DATA unset", () => {
  // realpath: on macOS the tmpdir is a /var -> /private/var symlink, and the companion only runs
  // main() when argv[1] equals its own resolved module path.
  const config = fs.realpathSync(makeTempDir());
  // A relocated plugins root (not named "plugins"), the case a name check would miss.
  const installed = path.join(config, "relocated-root", "cache", "agent-fleet", "codex", "9.9.9");
  fs.cpSync(PLUGIN_ROOT, installed, { recursive: true });
  const dataDir = path.join(config, "relocated-root", "data", "codex-agent-fleet");

  const workspace = makeTempDir();
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir; // seed exactly where the hook used to point
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
    process.env.CLAUDE_PLUGIN_DATA = saved;
  }

  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "S1" };
  delete env.CLAUDE_PLUGIN_DATA;
  const companion = path.join(installed, "scripts", "codex-companion.mjs");

  const status = run("node", [companion, "status", "--cwd", workspace], { cwd: workspace, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /task-kept/);

  const result = run("node", [companion, "result", "task-kept", "--cwd", workspace, "--json"], { cwd: workspace, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).job.id, "task-kept");
});
