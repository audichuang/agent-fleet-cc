// best-effort gate:若本機有 codex 的 plugin-creator validator + PyYAML,
// 就用官方 validator 驗 plugins/cc 的 .codex-plugin;否則 skip(CI/無 codex 環境)。
// 故意 NOT import "./helpers.mjs" —— 需要真實 HOME 才找得到 ~/.codex 的 validator;
// 本測試只跑外部 python validator,不碰 cc 的 env/dataRoot,無需 hermetic strip。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CC_PLUGIN = path.join(REPO_ROOT, "plugins/cc");
const VALIDATOR = path.join(
  os.homedir(),
  ".codex/skills/.system/plugin-creator/scripts/validate_plugin.py",
);

function pythonWithYaml() {
  for (const py of ["/usr/bin/python3", "python3"]) {
    const r = spawnSync(py, ["-c", "import yaml"], { encoding: "utf8" });
    if (r.status === 0) return py;
  }
  return null;
}

test("plugins/cc 通過 codex plugin-creator validator", (t) => {
  if (!fs.existsSync(VALIDATOR)) {
    t.skip("codex plugin-creator validator 不在本機(非 codex 環境/CI)");
    return;
  }
  const py = pythonWithYaml();
  if (!py) {
    t.skip("找不到帶 PyYAML 的 python3");
    return;
  }
  const res = spawnSync(py, [VALIDATOR, CC_PLUGIN], { encoding: "utf8" });
  assert.equal(
    res.status,
    0,
    `codex validator failed:\n${res.stdout}\n${res.stderr}`,
  );
  assert.match(res.stdout, /validation passed/i, res.stdout);
});
