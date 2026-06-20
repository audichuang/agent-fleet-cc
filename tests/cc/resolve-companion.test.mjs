import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCompanion, CompanionNotFoundError } from "../../plugins/cc/scripts/lib/resolve-companion.mjs";

// 在 tmp 下造一個假的 cc plugin 根:<root>/scripts/cc-companion.mjs + <root>/.codex-plugin/plugin.json
function makeCcRoot(root, { name = "cc" } = {}) {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "cc-companion.mjs"), "// fake\n");
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name, version: "0.4.0", skills: "./skills/" }),
  );
  return path.join(root, "scripts", "cc-companion.mjs");
}

test("CODEX_HOME 平鋪佈局(orca):.tmp/plugins/plugins/cc 命中", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-codexhome-"));
  const root = path.join(home, ".tmp", "plugins", "plugins", "cc");
  const want = makeCcRoot(root);
  const got = resolveCompanion({ env: { CODEX_HOME: home }, homedir: "/nonexistent" });
  assert.equal(got, want);
});

test("claude cache 佈局:cache/<mkt>/cc/<ver> 命中", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-home-"));
  const root = path.join(home, ".claude", "plugins", "cache", "mkt", "cc", "0.4.0");
  const want = makeCcRoot(root);
  const got = resolveCompanion({ env: {}, homedir: home });
  assert.equal(got, want);
});

test("~/.codex cache 主佈局:cache/<mkt>/cc/<ver> 命中", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-dotcodex-"));
  const root = path.join(home, ".codex", "plugins", "cache", "mkt", "cc", "0.4.0");
  const want = makeCcRoot(root);
  const got = resolveCompanion({ env: {}, homedir: home });
  assert.equal(got, want);
});

test("tier 優先:CODEX_HOME 命中(較舊)勝過 ~/.claude 命中(較新)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-tier-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "rc-tier-ch-"));
  const codexRoot = path.join(codexHome, ".tmp", "plugins", "plugins", "cc");
  const claudeRoot = path.join(home, ".claude", "plugins", "cache", "mkt", "cc", "0.4.0");
  const codexWant = makeCcRoot(codexRoot);
  makeCcRoot(claudeRoot);
  // 讓 claude 命中的 mtime 較新 —— tier 優先仍須回 CODEX_HOME(不是全域 mtime)
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(claudeRoot, future, future);
  const got = resolveCompanion({ env: { CODEX_HOME: codexHome }, homedir: home });
  assert.equal(got, codexWant, "tier 優先序必須勝過 mtime");
});

test("hash 版本目錄也命中(不靠 ^[0-9] 過濾)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-hash-"));
  const root = path.join(home, ".claude", "plugins", "cache", "mkt", "cc", "202e9242");
  const want = makeCcRoot(root);
  const got = resolveCompanion({ env: {}, homedir: home });
  assert.equal(got, want);
});

test("marker 驗證:同名目錄但 manifest name 不是 cc → 不命中 → throw", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-marker-"));
  const root = path.join(home, ".claude", "plugins", "cache", "mkt", "cc", "0.4.0");
  makeCcRoot(root, { name: "not-cc" });
  assert.throws(() => resolveCompanion({ env: {}, homedir: home }), CompanionNotFoundError);
});

test("全落空 → throw CompanionNotFoundError,訊息含掃過的根", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-empty-"));
  assert.throws(
    () => resolveCompanion({ env: {}, homedir: home }),
    (err) => err instanceof CompanionNotFoundError && Array.isArray(err.scanned),
  );
});

test("多命中按 mtime 取最新", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-mtime-"));
  const oldRoot = path.join(home, ".claude", "plugins", "cache", "mkt", "cc", "0.3.0");
  const newRoot = path.join(home, ".claude", "plugins", "cache", "mkt", "cc", "0.4.0");
  makeCcRoot(oldRoot);
  const newWant = makeCcRoot(newRoot);
  // 把 newRoot 的 mtime 設成更新
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(newRoot, future, future);
  const got = resolveCompanion({ env: {}, homedir: home });
  assert.equal(got, newWant);
});
