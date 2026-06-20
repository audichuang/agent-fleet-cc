import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = path.join(REPO_ROOT, "plugins/cc/bin/cc-companion");

test("bin/cc-companion 存在、可執行、有 shebang、forward 到 cc-companion.mjs", () => {
  assert.ok(fs.existsSync(LAUNCHER), "bin/cc-companion missing");
  const text = fs.readFileSync(LAUNCHER, "utf8");
  assert.match(text, /^#!.*\b(bash|sh)\b/, "missing shebang");
  assert.match(text, /scripts\/cc-companion\.mjs/, "must exec the runtime");
  const mode = fs.statSync(LAUNCHER).mode;
  assert.ok(mode & 0o111, "launcher must be executable");
});

test("bin/cc-companion 無參數時 forward 到 runtime 並 exit 0（印 usage）", () => {
  const res = spawnSync(LAUNCHER, [], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: cc-companion/, "should print companion usage");
});

test("透過 symlink 入口呼叫 launcher 仍能 resolve 到 runtime（PATH 安裝多為 symlink）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symlink-"));
  const link = path.join(dir, "cc-companion");
  fs.symlinkSync(LAUNCHER, link);
  const res = spawnSync(link, [], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: cc-companion/, "symlinked launcher must resolve runtime");
  fs.rmSync(dir, { recursive: true, force: true });
});
