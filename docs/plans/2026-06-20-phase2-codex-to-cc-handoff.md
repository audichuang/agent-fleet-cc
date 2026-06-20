# Phase 2 — codex→cc handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 cc 變成雙宿主 plugin —— codex 當 host 時,透過一個 `cc-handoff` skill 把使用者明確指派的子任務 handoff 給 headless claude(cc-companion),前景同步拿回結果。

**Architecture:** 在 `plugins/cc/` 新增 `.codex-plugin/plugin.json`(鏡像現有 `.claude-plugin`,加 `skills:"./skills/"`)、一個 `skills/cc-handoff/SKILL.md`(輕版操作說明)、一個可單元測的 `scripts/lib/resolve-companion.mjs`(用 `CODEX_HOME`/cache glob + manifest `name==="cc"` 定位 runtime,**不**靠寫死路徑或 plugin-root env)、以及一個 `bin/cc-companion` launcher(裝後進 PATH,當 resolver 主路徑)。既有 runtime `cc-companion.mjs` 本期零改動。

**Tech Stack:** 零依賴 pure ESM `.mjs`;測試只用 `node:test` + `node:assert/strict`,hermetic(每個測試檔第一行 `import "./helpers.mjs"`);bash launcher。

## Global Constraints

- Node >= 22.3。
- 新 script 一律零依賴、pure ESM `.mjs`。測試 hermetic:第一行 `import "./helpers.mjs"`(它 redirect HOME + strip `ANTHROPIC_*/CLAUDE_*/CLAUDECODE*/CC_*` + 設 `CC_PLUGIN_DATA` 到 temp)。
- **IRONCLAD**:絕不修改 `plugins/{codex,antigravity}/` 或 `tests/{codex,antigravity}/` 任何檔(讀來對照可以)。
- `plugins/cc/scripts/cc-companion.mjs` 與既有 `scripts/lib/*`、`commands/*.md` **本期零改動**。
- `plugins/cc/.claude-plugin/plugin.json` **僅** `version` 欄 `0.3.0`→`0.4.0`,其餘三欄不動。
- 一致性斷言**只針對 cc 條目**,不寫成對所有 plugin 的通用迴圈(否則拖 codex/antigravity 進約束,踩 IRONCLAD)。
- 每個 commit trailer:`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 從 `main` 開 feature 分支(例:`feat/phase2-codex-to-cc`),不直接 commit main。
- resolver / skill 設計依據 spec v2(`docs/specs/2026-06-20-phase2-codex-to-cc-handoff-design.md` 的 V-1~V-6):resolver 換錨、skill 必設 `CC_PLUGIN_DATA`、cwd 釘 `PROJECT_ROOT`、`--json` 失敗分類、delegated-write 用 `git status`、A2/Q-binpath 為實作後 smoke。

## File Structure

- **Create** `plugins/cc/.codex-plugin/plugin.json` — codex 宿主 manifest(name/version/description/author/license + `skills:"./skills/"`)。
- **Create** `plugins/cc/scripts/lib/resolve-companion.mjs` — 純函式,定位 cc-companion 絕對路徑,可注入 fs/env seam。
- **Create** `plugins/cc/bin/cc-companion` — bash launcher,resolve 自身位置後 exec 相鄰 `../scripts/cc-companion.mjs`(裝後進 PATH)。
- **Create** `plugins/cc/skills/cc-handoff/SKILL.md` — handoff skill(輕版操作手冊)。
- **Create** `tests/cc/resolve-companion.test.mjs` — resolver 單元測(fake-fs)。
- **Create** `tests/cc/codex-handoff.test.mjs` — `.codex-plugin` 一致性 + skill 存在/frontmatter + `CC_PLUGIN_DATA` 污染回歸 + launcher 整合。
- **Modify** `plugins/cc/.claude-plugin/plugin.json` — version `0.3.0`→`0.4.0`。
- **Modify** `.claude-plugin/marketplace.json` — cc 條目 version `0.4.0` + description 微調。
- **Modify** `tests/cc/plugin-structure.test.mjs` — 既有 "marketplace entry and plugin.json agree for cc" 測試加 `.codex-plugin` 三方一致性斷言。
- **Modify** `README.md` — 新增 "codex→cc handoff" 段(只加 cc 段,不動 codex/antigravity 段)。

---

### Task 1: 雙宿主 manifest + version 同步 + 一致性測試

**Files:**
- Create: `plugins/cc/.codex-plugin/plugin.json`
- Modify: `plugins/cc/.claude-plugin/plugin.json`(version 欄)
- Modify: `.claude-plugin/marketplace.json`(cc 條目 version + description)
- Modify: `tests/cc/plugin-structure.test.mjs`(既有 cc 一致性測試加 `.codex-plugin` 斷言)

**Interfaces:**
- Produces: `plugins/cc/.codex-plugin/plugin.json` 內 `name:"cc"`、`version:"0.4.0"`、`skills:"./skills/"` —— Task 2 的 resolver marker 驗證、Task 4 的 skill 發現都依賴 `name:"cc"` 與 `skills:"./skills/"`。

- [ ] **Step 1: 先改測試 —— 在 `tests/cc/plugin-structure.test.mjs` 既有 "marketplace entry and plugin.json agree for cc" 測試末尾,加 `.codex-plugin` 三方一致性斷言**

在該 `test(...)` 的最後一個 `assert.equal(entry.version, plugin.version);` 之後插入:

```javascript
  // Phase 2: cc 是雙宿主 plugin —— .codex-plugin 必須存在且三方 name/version 一致
  const codexManifest = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "plugins/cc/.codex-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(codexManifest.name, "cc", ".codex-plugin name must be cc");
  assert.equal(
    codexManifest.version,
    plugin.version,
    ".codex-plugin version must match .claude-plugin",
  );
  assert.equal(
    codexManifest.skills,
    "./skills/",
    ".codex-plugin must declare skills: ./skills/",
  );
```

- [ ] **Step 2: 跑測試確認 FAIL**

Run: `node --test tests/cc/plugin-structure.test.mjs`
Expected: FAIL — `ENOENT` 讀不到 `plugins/cc/.codex-plugin/plugin.json`(檔還沒建)。

- [ ] **Step 3: 建立 `plugins/cc/.codex-plugin/plugin.json`**

```json
{
  "name": "cc",
  "version": "0.4.0",
  "description": "Hand a subtask from a Codex host to a headless Claude Code (cc) worker, selected by profile (native Claude, a cheap endpoint, or any model)",
  "author": {
    "name": "audichuang"
  },
  "license": "MIT",
  "skills": "./skills/"
}
```

- [ ] **Step 4: bump `plugins/cc/.claude-plugin/plugin.json` 的 version(僅此欄)**

把 `"version": "0.3.0"` 改成 `"version": "0.4.0"`。最終內容:

```json
{
  "name": "cc",
  "version": "0.4.0",
  "description": "Run tasks on a headless Claude Code instance, selected by profile (native Claude, a cheap endpoint, or any model)"
}
```

- [ ] **Step 5: 同步 `.claude-plugin/marketplace.json` 的 cc 條目**

把 cc 條目改成(version → `0.4.0`,description 微調點出雙宿主):

```json
    {
      "name": "cc",
      "source": "./plugins/cc",
      "description": "Run tasks on a headless Claude Code instance, selected by profile — usable from Claude Code or a Codex host via handoff",
      "version": "0.4.0"
    }
```

- [ ] **Step 6: 跑測試確認 PASS**

Run: `node --test tests/cc/plugin-structure.test.mjs`
Expected: PASS（含既有測試 + 新的 `.codex-plugin` 斷言;`fleet-structure` 的 marketplace↔.claude-plugin version 一致也仍綠,因三方都已 0.4.0）。

- [ ] **Step 7: 跑 fleet 結構測試確認沒拖累 sibling**

Run: `node --test tests/fleet-structure.test.mjs`
Expected: PASS（marketplace cc 條目 version 0.4.0 與 `.claude-plugin` 0.4.0 一致）。

- [ ] **Step 8: Commit**

```bash
git add plugins/cc/.codex-plugin/plugin.json plugins/cc/.claude-plugin/plugin.json .claude-plugin/marketplace.json tests/cc/plugin-structure.test.mjs
git commit -m "feat(cc): add .codex-plugin manifest, bump to 0.4.0 (dual-host)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: resolver 純函式 + 單元測試

**Files:**
- Create: `plugins/cc/scripts/lib/resolve-companion.mjs`
- Create: `tests/cc/resolve-companion.test.mjs`

**Interfaces:**
- Produces:
  - `export function resolveCompanion({ env, homedir, existsSync, readdirSync, statSync, readFileSync }): string` — 回傳命中 cc 根下 `scripts/cc-companion.mjs` 的絕對路徑;全落空 throw `CompanionNotFoundError`。
  - `export class CompanionNotFoundError extends Error`(屬性 `scanned: string[]`)。
- Consumes: Task 1 的 `.codex-plugin/plugin.json`(`name:"cc"` 作為 marker)。

- [ ] **Step 1: 寫失敗測試 `tests/cc/resolve-companion.test.mjs`**

```javascript
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
```

- [ ] **Step 2: 跑測試確認 FAIL**

Run: `node --test tests/cc/resolve-companion.test.mjs`
Expected: FAIL — `Cannot find module .../resolve-companion.mjs`。

- [ ] **Step 3: 實作 `plugins/cc/scripts/lib/resolve-companion.mjs`**

```javascript
// plugins/cc/scripts/lib/resolve-companion.mjs
// 在 codex(或任何宿主)端定位 cc plugin 內的 cc-companion.mjs。
// 不靠寫死絕對路徑或 plugin-root env —— orca 環境兩者皆不可靠(spec v2 V-1)。
// 改用穩定錨:CODEX_HOME / 標準 cache 目錄下有界搜尋,並以相鄰
// .codex-plugin(或 .claude-plugin)plugin.json 的 name==="cc" 為 marker 驗證。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const MAX_DEPTH = 3; // base/<mkt>/cc/<ver> 最深三層

export class CompanionNotFoundError extends Error {
  constructor(scanned) {
    super(`cc-companion.mjs not found. scanned roots:\n${scanned.join("\n")}`);
    this.name = "CompanionNotFoundError";
    this.scanned = scanned;
  }
}

function cacheBases({ env, homedir }) {
  const bases = [];
  if (env.CODEX_HOME) {
    bases.push(path.join(env.CODEX_HOME, ".tmp", "plugins", "plugins"));
    bases.push(path.join(env.CODEX_HOME, "plugins", "cache"));
  }
  bases.push(path.join(homedir, ".codex", "plugins", "cache"));
  bases.push(path.join(homedir, ".claude", "plugins", "cache"));
  return bases;
}

// 若 dir 是合法 cc 根(dir/scripts/cc-companion.mjs 存在且相鄰 manifest name==="cc"),
// 回傳該 companion 絕對路徑,否則 null。
function companionAt(dir, { existsSync, readFileSync }) {
  const companion = path.join(dir, "scripts", "cc-companion.mjs");
  if (!existsSync(companion)) return null;
  for (const mani of [".codex-plugin", ".claude-plugin"]) {
    const mpath = path.join(dir, mani, "plugin.json");
    if (!existsSync(mpath)) continue;
    try {
      const j = JSON.parse(readFileSync(mpath, "utf8"));
      if (j && j.name === "cc") return companion;
    } catch {
      /* 壞 json,當作沒這個 marker */
    }
  }
  return null;
}

export function resolveCompanion({
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const scanned = [];
  const hits = []; // { companion, root }

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || !existsSync(dir)) return;
    const hit = companionAt(dir, { existsSync, readFileSync });
    if (hit) {
      hits.push({ companion: hit, root: dir });
      return; // 命中即 plugin 根,不再往下
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };

  // tier 優先(spec v2 V-1):依序試每個 base,第一個有命中的 tier 勝;
  // 只在同 tier 內按 root mtime 取最新。不做全域 mtime 排序(否則較新的
  // ~/.claude 安裝會蓋過 $CODEX_HOME 的 codex-host 安裝)。
  for (const base of cacheBases({ env, homedir })) {
    scanned.push(base);
    const before = hits.length;
    walk(base, 0);
    const fresh = hits.slice(before);
    if (fresh.length) {
      fresh.sort((a, b) => statSync(b.root).mtimeMs - statSync(a.root).mtimeMs);
      return fresh[0].companion;
    }
  }
  throw new CompanionNotFoundError(scanned);
}
```

> **Tier 順序**:`cacheBases` 回傳的順序即 tier 優先序 —— `$CODEX_HOME/.tmp/plugins/plugins` → `$CODEX_HOME/plugins/cache` → `~/.codex/plugins/cache` → `~/.claude/plugins/cache`。第一個有命中的 base 立即回傳,後面的 base 連掃都不掃。

- [ ] **Step 4: 跑測試確認 PASS**

Run: `node --test tests/cc/resolve-companion.test.mjs`
Expected: PASS（全部 6 個 test 綠）。

- [ ] **Step 5: prove-non-vacuity —— 暫時讓 marker 永遠通過,確認 marker 測試會紅**

暫時把 `companionAt` 裡 `if (j && j.name === "cc")` 改成 `if (j)`,跑 `node --test tests/cc/resolve-companion.test.mjs`,確認 "marker 驗證" 那條 FAIL。**改回**後再繼續。

- [ ] **Step 6: Commit**

```bash
git add plugins/cc/scripts/lib/resolve-companion.mjs tests/cc/resolve-companion.test.mjs
git commit -m "feat(cc): add resolve-companion (CODEX_HOME/cache glob + name marker)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: bin/cc-companion launcher + 整合測試

**Files:**
- Create: `plugins/cc/bin/cc-companion`
- Modify: `tests/cc/codex-handoff.test.mjs`(本 task 建立此檔的第一段)

**Interfaces:**
- Produces: `plugins/cc/bin/cc-companion` —— 可執行 bash launcher,resolve 自身真實路徑後 `exec node <plugin>/scripts/cc-companion.mjs "$@"`。裝後進 PATH,作為 skill 的 resolver 主路徑(spec v2 V-1)。

- [ ] **Step 1: 寫失敗測試（建立 `tests/cc/codex-handoff.test.mjs`,先放 launcher 段）**

```javascript
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
```

- [ ] **Step 2: 跑測試確認 FAIL**

Run: `node --test tests/cc/codex-handoff.test.mjs`
Expected: FAIL — `bin/cc-companion missing`。

- [ ] **Step 3: 建立 `plugins/cc/bin/cc-companion`**

```bash
#!/usr/bin/env bash
# cc launcher — 裝後進 PATH。resolve 自身真實位置(跟隨 symlink),
# 再 exec 相鄰的 ../scripts/cc-companion.mjs。skill 的 resolver 主路徑。
set -euo pipefail
src="${BASH_SOURCE[0]}"
while [ -h "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  [[ "$src" != /* ]] && src="$dir/$src"
done
here="$(cd -P "$(dirname "$src")" && pwd)"
exec node "$here/../scripts/cc-companion.mjs" "$@"
```

- [ ] **Step 4: 設可執行權限**

Run: `chmod +x plugins/cc/bin/cc-companion`

- [ ] **Step 5: 跑測試確認 PASS**

Run: `node --test tests/cc/codex-handoff.test.mjs`
Expected: PASS（launcher 存在 + 無參數 forward 印出 `usage: cc-companion`）。

- [ ] **Step 6: Commit**

```bash
git add plugins/cc/bin/cc-companion tests/cc/codex-handoff.test.mjs
git commit -m "feat(cc): add bin/cc-companion launcher (PATH entry for handoff)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: cc-handoff skill + 存在性/frontmatter 測試

**Files:**
- Create: `plugins/cc/skills/cc-handoff/SKILL.md`
- Modify: `tests/cc/codex-handoff.test.mjs`(加 skill 段)

**Interfaces:**
- Consumes: Task 1 `.codex-plugin` 的 `skills:"./skills/"`;Task 3 launcher(`cc-companion` 進 PATH,skill 主路徑)。
- **skill 的 inline fallback bash 是 Task 2 resolver contract 的「shell mirror」**(同一套 tier 順序 `$CODEX_HOME`→`~/.codex`→`~/.claude`、`-maxdepth 5`、`name==="cc"` marker)—— 刻意**不**呼叫 `resolve-companion.mjs`(避免「import 前要先知道 plugin root」的 bootstrap 循環),而是用同規則的最小 shell 版。fallback 的 cache 佈局必須與 Task 2 的測試案例**一一對齊**(Task 2 測試 = 真值,skill bash 照它寫;改一邊要同步另一邊)。
- Produces: `skills/cc-handoff/SKILL.md`(frontmatter `name: cc-handoff`)。

- [ ] **Step 1: 寫失敗測試（append 到 `tests/cc/codex-handoff.test.mjs`）**

```javascript
const SKILL = path.join(REPO_ROOT, "plugins/cc/skills/cc-handoff/SKILL.md");

test("cc-handoff skill 存在、frontmatter 正確、含關鍵操作指令", () => {
  assert.ok(fs.existsSync(SKILL), "cc-handoff/SKILL.md missing");
  const text = fs.readFileSync(SKILL, "utf8");
  assert.ok(text.startsWith("---"), "missing frontmatter");
  const fm = text.slice(3, text.indexOf("---", 3));
  assert.match(fm, /name:\s*cc-handoff/, "name must be cc-handoff");
  assert.match(fm, /description:/, "missing description");
  // description 三要素關鍵字(spec §2 Q3 判據)
  assert.match(fm, /claude/i, "description must mention claude");
  assert.match(fm, /hand|delegate/i, "description must mention hand/delegate");
  assert.match(fm, /subtask|task/i, "description must mention subtask/task");
  // body 必含 spec v2 釘死的操作:CC_PLUGIN_DATA、PROJECT_ROOT、git status、--json、不自動外包
  assert.match(text, /CC_PLUGIN_DATA/, "body must set CC_PLUGIN_DATA (V-2)");
  assert.match(text, /git rev-parse --show-toplevel/, "body must pin PROJECT_ROOT (V-3)");
  assert.match(text, /git status --porcelain/, "body must list changed files (V-5)");
  assert.match(text, /--json/, "body must use --json");
  assert.match(text, /明確指派|explicit/i, "body must state explicit-assignment-only");
});
```

- [ ] **Step 2: 跑測試確認 FAIL**

Run: `node --test tests/cc/codex-handoff.test.mjs`
Expected: FAIL — `cc-handoff/SKILL.md missing`。

- [ ] **Step 3: 建立 `plugins/cc/skills/cc-handoff/SKILL.md`**

````markdown
---
name: cc-handoff
description: Hand a subtask FROM a Codex host TO a headless Claude Code (cc) worker and return the result. Use ONLY when the user explicitly assigns a subtask to Claude ("hand this to Claude", "run this with cc", "交給 Claude 跑") — never as automatic offloading.
---

# cc-handoff — 把子任務交給 Claude Code worker

當使用者在 prompt 裡**明確指派**某段工作給 Claude（例如「這部分交給 Claude 跑」）時,用本流程把它 handoff 給 headless Claude Code（cc),前景同步拿回結果再繼續。**非明確指派時不要自行外包。**

## 步驟

### 0. 定位 cc-companion（主路徑:PATH;退路:搜尋）

先試 PATH 的 launcher:

```bash
if command -v cc-companion >/dev/null 2>&1; then
  CC=(cc-companion)                 # PATH launcher(主路徑)— bash array,安全帶空白路徑
else
  # 退路:tier 優先,在已知 cache 根下依序找 cc plugin(cc-companion.mjs + 相鄰 .codex-plugin name=cc)。
  # 第一個命中的 base 勝。-maxdepth 5:cache/<mkt>/cc/<ver>/scripts/cc-companion.mjs 從 base 起是第 5 層
  # (orca 的 $CODEX_HOME/.tmp/plugins/plugins/cc/scripts/… 是第 3 層,5 也涵蓋)。
  CC=()
  for base in "${CODEX_HOME:-/nonexistent}/.tmp/plugins/plugins" "${CODEX_HOME:-/nonexistent}/plugins/cache" \
              "$HOME/.codex/plugins/cache" "$HOME/.claude/plugins/cache"; do
    [ -d "$base" ] || continue
    while IFS= read -r f; do
      root="$(dirname "$(dirname "$f")")"
      if grep -q '"name"[[:space:]]*:[[:space:]]*"cc"' "$root/.codex-plugin/plugin.json" 2>/dev/null \
         || grep -q '"name"[[:space:]]*:[[:space:]]*"cc"' "$root/.claude-plugin/plugin.json" 2>/dev/null; then
        CC=(node "$f"); break
      fi
    done < <(find "$base" -maxdepth 5 -type f -name cc-companion.mjs 2>/dev/null)
    [ ${#CC[@]} -gt 0 ] && break
  done
  [ ${#CC[@]} -gt 0 ] || { echo "cc plugin 未安裝或 cc-companion 不在預期路徑"; exit 1; }
fi
```

### 1. 釘住工作目錄與環境（V-2 / V-3）

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
# 必設 CC_PLUGIN_DATA —— 否則被 codex 環境的 CLAUDE_PLUGIN_DATA 拖走,profile 找不到
export CC_PLUGIN_DATA="${CC_PLUGIN_DATA:-$HOME/.claude/plugins/data/cc}"
```

### 2. 備妥 prompt（temp file,絕對路徑）

把交給 Claude 的子任務寫成**完整、自足**的指令(檔案、約束、完成定義都講清楚),寫進 temp file:

```bash
TMP="$(mktemp /tmp/cc-handoff.XXXXXX.md)"
cat > "$TMP" <<'EOF'
[完整子任務指令]
EOF
```

### 3. 記錄改檔前狀態（V-5 delegated-write)

```bash
BEFORE="$(cd "$PROJECT_ROOT" && git status --porcelain --untracked-files=all 2>/dev/null)"
```

### 4. 同步 spawn（在專案根 cwd,傳絕對 prompt 路徑）

```bash
OUT="$(cd "$PROJECT_ROOT" && "${CC[@]}" task --prompt-file "$TMP" --json 2>/tmp/cc-handoff.err)"
RC=$?
```

- 預設權限可寫（`bypassPermissions`）。只有使用者要求「不要用 bypass 權限」時,在 `task` 後加 `--read-only`（語意:改用 claude 預設權限模式,**非**保證禁寫)。
- 不帶 `--profile`(單一 profile auto-select)。本流程**不**用背景模式。

### 5. 讀回結果（先解析 JSON,失敗再分類；V-4）

- `$OUT` 應是**單行 JSON**;先 `JSON.parse`,取 `status`/`resultText`/`error`/`errorKind`。
- 若 `$OUT` 不是合法 JSON:
  - stdout 開頭是 `cc: ...` → **前置 Profile/Usage error**(根本沒跑 claude)。指引使用者跑 `"${CC[@]}" setup`(自動建 native profile)或設 `CC_DEFAULT_PROFILE`,**可安全重試**。
  - `/tmp/cc-handoff.err` 有 stack → **runtime crash**:回報錯誤,**不**重跑。
- 若 `status == "completed"`:把 `resultText` 帶回繼續。
- 否則(已執行但非 completed):回報 `error`/`errorKind`,**不要**換 profile 重跑(失敗 job 可能已有 side effect)。

### 6. 回報改了哪些檔（V-5)

```bash
AFTER="$(cd "$PROJECT_ROOT" && git status --porcelain --untracked-files=all 2>/dev/null)"
```

比對 `$BEFORE` 與 `$AFTER`,把 claude 改動/新增的檔列給使用者(cc 預設可寫、無二次確認)。非 git workspace 則明說「無法可靠列舉改了哪些檔」,並提醒使用者:此 handoff 預設可寫,若要唯讀請加 `--read-only`。

### 7. 清理

```bash
rm -f "$TMP" /tmp/cc-handoff.err
```

> 本 skill 只寫「每個動作怎麼用」,不含「如何替 claude 組 prompt」的方法論(claude 不像 GPT-5.5 需要官方 prompting guide)。profile 怎麼建是 `setup` 的事 —— 找不到 / 0 profile 時指引使用者跑 `"${CC[@]}" setup`,**不**引用 `/cc:setup`(codex 宿主沒有 slash command)。
````

- [ ] **Step 4: 跑測試確認 PASS**

Run: `node --test tests/cc/codex-handoff.test.mjs`
Expected: PASS（skill 存在 + frontmatter + 6 個 body 關鍵指令斷言全綠）。

- [ ] **Step 5: Commit**

```bash
git add plugins/cc/skills/cc-handoff/SKILL.md tests/cc/codex-handoff.test.mjs
git commit -m "feat(cc): add cc-handoff skill (explicit codex→cc handoff, light ops)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: CC_PLUGIN_DATA 污染回歸測試（hermetic subprocess,坐實 V-2/#2）

**Files:**
- Modify: `tests/cc/codex-handoff.test.mjs`(加 `import os` + COMPANION/FAKE_CLAUDE 常數 + 污染回歸 subprocess 測試)

**Interfaces:**
- Consumes: 既有 `cc-companion.mjs` 的 task 路徑、`resolveDataRoot` 優先序(`CC_PLUGIN_DATA → CLAUDE_PLUGIN_DATA → default`)、fake-claude shim 模式(同 `tests/cc/e2e-cli.test.mjs`)。

> **codex review #4**:純函式 `resolveDataRoot(env)` 測試是 vacuous(只重述優先序)。改成**真實 subprocess**:在「`CC_PLUGIN_DATA` + 被污染的 `CLAUDE_PLUGIN_DATA` 同時存在」下實跑 `cc-companion task`,斷言 job/state 落在 `CC_PLUGIN_DATA`、污染目錄沒被碰。

- [ ] **Step 1: 在 `tests/cc/codex-handoff.test.mjs` 頂部補 `os` import 與常數**

確認頂部 import 含 `os`(Task 3 建檔時只 import fs/path/spawnSync/fileURLToPath);若無則加 `import os from "node:os";`。並在 `const LAUNCHER = ...` 之後加:

```javascript
const COMPANION = path.join(REPO_ROOT, "plugins/cc/scripts/cc-companion.mjs");
const FAKE_CLAUDE = path.join(REPO_ROOT, "tests/cc/fake-claude.mjs");
```

- [ ] **Step 2: 寫測試（append 到 `tests/cc/codex-handoff.test.mjs`）**

```javascript
test("污染回歸:同時有 CC_PLUGIN_DATA 與被污染的 CLAUDE_PLUGIN_DATA 時,job/state 落 CC_PLUGIN_DATA（V-2/#2）", () => {
  const want = fs.mkdtempSync(path.join(os.tmpdir(), "cc-want-"));   // cc 真正的 dataRoot
  const wrong = fs.mkdtempSync(path.join(os.tmpdir(), "cc-wrong-")); // codex 環境注入的 CLAUDE_PLUGIN_DATA
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ws-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cc-bin-"));
  const shim = path.join(bin, "claude");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`,
    { mode: 0o755 },
  );
  // 單一 profile 放在 want → auto-select
  fs.mkdirSync(path.join(want, "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(want, "profiles", "native.json"),
    JSON.stringify({ env: { FAKE_CLAUDE_MODE: "success" } }),
  );
  const prompt = path.join(ws, "task.md");
  fs.writeFileSync(prompt, "do the thing");

  const res = spawnSync(
    process.execPath,
    [COMPANION, "task", "--prompt-file", prompt, "--json"],
    {
      cwd: ws,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CC_PLUGIN_DATA: want,        // cc 的 dataRoot
        CLAUDE_PLUGIN_DATA: wrong,   // 模擬 orca codex 污染
        CC_CLAUDE_BIN: shim,
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `no JSON in stdout: ${res.stdout}\n${res.stderr}`);
  const j = JSON.parse(line);
  assert.equal(j.status, "completed", `${res.stdout}\n${res.stderr}`);
  // 坐實:state 落在 want(CC_PLUGIN_DATA),wrong 完全沒被用
  assert.ok(fs.existsSync(path.join(want, "state")), "state must live under CC_PLUGIN_DATA");
  assert.ok(
    !fs.existsSync(path.join(wrong, "state")),
    "CLAUDE_PLUGIN_DATA must NOT be used when CC_PLUGIN_DATA is set",
  );

  for (const d of [want, wrong, ws, bin]) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
```

- [ ] **Step 3: 跑測試確認 PASS**

Run: `node --test tests/cc/codex-handoff.test.mjs`
Expected: PASS — status completed、`want/state` 存在、`wrong/state` 不存在。

- [ ] **Step 4: prove-non-vacuity**

暫時把測試的 `CC_PLUGIN_DATA: want,` 那行移除(只留 `CLAUDE_PLUGIN_DATA: wrong`),跑測試,確認 `want/state 存在` 斷言 FAIL(state 跑到 wrong)。**改回**後再繼續 —— 證明測試真的綁住「CC_PLUGIN_DATA 必須勝出」,非 vacuous。

- [ ] **Step 5: Commit**

```bash
git add tests/cc/codex-handoff.test.mjs
git commit -m "test(cc): hermetic subprocess regression for CLAUDE_PLUGIN_DATA pollution (V-2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: README 段 + 全測試綠 + 實作後 smoke 清單

**Files:**
- Modify: `README.md`(新增 codex→cc 段,只加 cc 段)

**Interfaces:**
- Consumes: 全部前面 task 的交付物。

- [ ] **Step 1: 在 `README.md` 找到 cc plugin 既有段落,於其後新增「codex→cc handoff」子段（不得編輯 codex/antigravity 段)**

新增內容:

```markdown
### codex → cc handoff (Phase 2)

`cc` 是雙宿主 plugin:除了在 Claude Code 用 `/cc:*`,也能在 **Codex 當 host** 時把明確指派的子任務交給 headless Claude。

**安裝到 codex(使用者操作)**：將本 repo 註冊為 codex marketplace 後 `codex plugin add cc@<marketplace>`，確認 `~/.codex/config.toml` 出現 `[plugins."cc@<marketplace>"] enabled = true`。

**用法**：在給 codex 的 prompt 裡明確指派，例如「這段翻譯交給 Claude 跑」。codex 會載入 `cc-handoff` skill → 定位 `cc-companion`（PATH launcher 或搜尋）→ 設 `CC_PLUGIN_DATA` → 在專案根以 `cc-companion task --prompt-file <abs> --json` 前景同步跑 → 回報結果與「claude 改了哪些檔」。

**注意**：handoff 預設可寫(`bypassPermissions`)；要唯讀加 `--read-only`。codex 端需先有 cc profile（`cc-companion setup` 會自動建 native）。
```

- [ ] **Step 2: 跑完整測試鏈確認全綠**

Run: `npm test`
Expected: PASS（structure + shared + cc + antigravity + codex + fleet + e2e）。若 `tests/codex/runtime.test.mjs` 偶發失敗,重跑一次確認（AGENTS.md Gotchas)。

- [ ] **Step 3: 確認 sync-shared 無漂移（本期沒動 shared/lib,應無變更）**

Run: `npm run sync-shared && git status --short`
Expected: 無 `plugins/cc/scripts/lib/shared/` 變更（本期未動 shared）。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document codex→cc handoff (Phase 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: 實作後 real-engine smoke 清單（手動閘,非 hermetic;坐實 A2 / Q-binpath）**

在真 codex（orca）上實跑,逐項記錄為事實:
1. `codex plugin add cc@<marketplace>` 後 `codex plugin list` 顯示 cc `installed, enabled`,記下真實 PATH。
2. **Q-binpath**：在 codex 工具 shell 裡 `command -v cc-companion` —— 有 → 主路徑成立;無 → 退路 inline 搜尋,記錄實際走哪條。
3. **A2（gate）**：給 codex 一個明確指派 prompt（「把 X 交給 Claude 跑」),觀察 codex 是否**自動觸發** `cc-handoff` skill。**自動觸發 → A2 達成;未自動觸發 = smoke gate FAIL = Phase 2 本期不算達成（not ready),不可 ship**(對齊 spec v2 V-6)。README 手動 fallback 只是失敗後的後續紀錄,**不是**接受條件,也不做 installer。
4. 子任務跑完:`--json` 的 `status == "completed"`、`exitCode == 0`、resultText 帶回。
5. 守衛放行:codex 未被 `CLAUDE_CC_ACTIVE` 擋（無 recursion guard 訊息)。
6. dataRoot:確認 cc 的 job/profile 落在 `CC_PLUGIN_DATA`,**未**被 codex 的 `CLAUDE_PLUGIN_DATA` 拖走。

---

## Self-Review

**1. Spec coverage（spec v2 V-1~V-6 + 設計細節 → task 對應）：**
- V-1 resolver 換錨 → Task 2(resolver 模組)+ Task 3(bin launcher 主路徑)+ Task 4 skill step 0(PATH + inline 退路）。✓
- V-2 CC_PLUGIN_DATA 必設 → Task 4 skill step 1 + Task 5 回歸測試。✓
- V-3 PROJECT_ROOT cwd → Task 4 skill step 1/4。✓
- V-4 --json 失敗分類 → Task 4 skill step 5。✓
- V-5 delegated-write git status → Task 4 skill step 3/6。✓
- V-6 A2 smoke gate + Q-binpath → Task 6 step 5 smoke 清單。✓
- 雙宿主 manifest（§1）→ Task 1。✓ 一致性斷言只限 cc（IRONCLAD）→ Task 1 step 1。✓
- version 三處同步（§6）→ Task 1 step 4/5。✓ README（§6）→ Task 6。✓

**2. Placeholder scan：** skill body 的 `[完整子任務指令]` 是 heredoc 範本佔位,屬「使用者填入內容」非 plan 漏寫;其餘步驟皆含實際 code/命令。無 TBD/TODO。✓

**3. Type/名稱一致性：** `resolveCompanion` / `CompanionNotFoundError`（Task 2 定義,Task 4 skill 退路邏輯對應）、`resolveDataRoot`（既有,Task 5 引用)、skill name `cc-handoff`（Task 1 manifest skills 指向、Task 4 frontmatter、測試斷言)三處一致。✓ launcher 路徑 `plugins/cc/bin/cc-companion`(Task 3 create、skill PATH 主路徑)一致。✓
