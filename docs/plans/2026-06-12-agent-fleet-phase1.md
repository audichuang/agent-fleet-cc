# agent-fleet-cc 第一階段（搬遷並存）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立新 repo `agent-fleet-cc`（marketplace `agent-fleet`），把 codex / antigravity / delegate 三個 plugin 原樣搬入並存，單一 `npm test` 全綠，零 plugin 行為改變。

**Architecture:** 多 plugin marketplace monorepo（仿 claude-plugins-official）。各 plugin 子目錄 = 安裝 payload（安裝只快取子目錄）；測試集中在 `tests/<plugin>/`（不進安裝 payload）。本階段不抽共享 lib — 那是第二階段。

**Tech Stack:** Node ≥22.3（antigravity 測試需 `mock.module`）、`node --test`、git、gh CLI。

**Spec:** `docs/superpowers/specs/2026-06-12-agent-fleet-merge-design.md`（已核准）

**來源 repo（同機）：**
- `/home/audichuang/research/codex-plugin-cc`（plugin 在 `plugins/codex/`，測試 import `"../plugins/codex/...`，套件 script `node --test tests/*.test.mjs`）
- `/home/audichuang/research/antigravity-plugin`（plugin 在 repo 根目錄，測試 import `'../scripts/...`，需 `--experimental-test-module-mocks`）
- `/home/audichuang/research/delegate-plugin-cc`（plugin 在 `plugins/delegate/`，測試 import `"../plugins/delegate/...`，90 個測試）

**前置需求（開工前確認）：**
- `node --version` ≥ 22.3
- `gh auth status` 已登入（Task 6/7 用）
- `codex --version` 可用（test:codex 與 build:codex 需要）
- 三個來源 repo 工作樹乾淨（`git status` clean）— 搬遷用 `git archive HEAD`，只搬 git 追蹤的內容（例：codex 的 `plugins/codex/.generated/` 是 gitignored，本來就不在安裝 payload，不搬）

**明文裁定（執行時不要重新發明）：**
1. 搬遷一律用 `git -C <src> archive HEAD <path> | tar -x`，不用 `cp -r`（避免帶進 gitignored/untracked 檔案）。
2. codex 的 `scripts/bump-version.mjs` 與 `tests/bump-version.test.mjs` **不搬**：它假設單 plugin repo（同步 package.json/marketplace/plugin 三處版號），monorepo 版本策略屬第二階段。版號暫時手動改。
3. antigravity 的 repo 層級檔案**留在舊 repo**：`tests/`（搬到 tests/antigravity）、`.github/`、`CONTRIBUTING.md`、`SECURITY.md`、`CLAUDE.md`（描述舊版面）、`.gitignore`（併入根 .gitignore）、`.claude-plugin/marketplace.json`（新 repo 用根 marketplace，留著會混淆）。其餘全進 `plugins/antigravity/`（含 README/CHANGELOG/LICENSE/SKILL.md/plugin.json/package.json/bin/.agents/.codex-plugin — 與舊安裝 payload 一致）。
4. codex repo 根目錄的 `CLAUDE.md` 同樣留在舊 repo（描述舊版面）。
5. 各 plugin 版號不變（codex 1.0.18 / antigravity 0.2.0 / delegate 0.1.0）。

---

### Task 1: 新 repo 骨架 + marketplace 結構測試

**Files:**
- Create: `/home/audichuang/research/agent-fleet-cc/`（git init）
- Create: `package.json`、`.gitignore`、`.claude-plugin/marketplace.json`
- Test: `tests/fleet-structure.test.mjs`

- [ ] **Step 1: 建 repo**

```bash
mkdir -p /home/audichuang/research/agent-fleet-cc
cd /home/audichuang/research/agent-fleet-cc
git init -b main
```

- [ ] **Step 2: 寫 package.json**

```json
{
  "name": "agent-fleet-cc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "One marketplace for delegation plugins: codex, antigravity (agy), delegate (cheap-model Claude Code)",
  "engines": { "node": ">=22.3" },
  "scripts": {
    "test": "npm run test:structure",
    "test:structure": "node --test tests/fleet-structure.test.mjs"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "typescript": "^6.0.2"
  }
}
```

（devDependencies 給 Task 4 的 `build:codex` 用；現在就放，讓 Step 7 的 lockfile 一次到位。）

- [ ] **Step 3: 寫 .gitignore**（三個來源 .gitignore 的合併精選）

```
node_modules/
*.log
.DS_Store
.env
.env.*
coverage/
*.tgz
.tmp/
.cache/
.antigravitycli/
.codegraph/
*.tsbuildinfo
output/
plugins/codex/.generated/
```

- [ ] **Step 4: 寫失敗測試 `tests/fleet-structure.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("marketplace is agent-fleet and every entry is consistent", () => {
  const marketplace = readJson(path.join(ROOT, ".claude-plugin/marketplace.json"));
  assert.equal(marketplace.name, "agent-fleet");
  for (const entry of marketplace.plugins) {
    const dir = path.join(ROOT, entry.source);
    assert.ok(fs.existsSync(dir), `${entry.name}: source dir missing`);
    const plugin = readJson(path.join(dir, ".claude-plugin/plugin.json"));
    assert.equal(plugin.name, entry.name, `${entry.name}: name mismatch`);
    assert.equal(plugin.version, entry.version, `${entry.name}: version mismatch`);
  }
});
```

- [ ] **Step 5: 跑測試確認失敗**

Run: `npm run test:structure`
Expected: FAIL（`ENOENT .claude-plugin/marketplace.json`）

- [ ] **Step 6: 寫 `.claude-plugin/marketplace.json`（先空 plugins，逐 task 加）**

```json
{
  "name": "agent-fleet",
  "owner": { "name": "audichuang" },
  "metadata": {
    "description": "One marketplace for AI-agent delegation plugins: Codex, Antigravity (agy), and cheap-model Claude Code delegation.",
    "version": "0.1.0"
  },
  "plugins": []
}
```

- [ ] **Step 7: 跑測試確認通過 + 產 lockfile**

Run: `npm run test:structure`
Expected: PASS（1 test）
Run: `npm install`
Expected: 產生 `package-lock.json`（CI 的 `npm ci` 需要）

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore .claude-plugin/ tests/
git commit -m "feat: agent-fleet marketplace skeleton with structure test"
```

---

### Task 2: 搬入 delegate

**Files:**
- Create: `plugins/delegate/`（自 delegate-plugin-cc 原樣）
- Create: `tests/delegate/`（13 個檔案，import 路徑改深一層）
- Modify: `tests/delegate/plugin-structure.test.mjs`（manifest 斷言改用根 marketplace、解除與 package.json 版號的耦合）
- Modify: `package.json`、`.claude-plugin/marketplace.json`

- [ ] **Step 1: 用 git archive 搬 plugin 與測試**

```bash
cd /home/audichuang/research/agent-fleet-cc
git -C /home/audichuang/research/delegate-plugin-cc archive HEAD plugins/delegate | tar -x
mkdir -p /tmp/fleet-mv && git -C /home/audichuang/research/delegate-plugin-cc archive HEAD tests | tar -x -C /tmp/fleet-mv
mv /tmp/fleet-mv/tests tests/delegate && rm -rf /tmp/fleet-mv
```

- [ ] **Step 2: 改寫測試 import 深度**

```bash
sed -i 's|"\.\./plugins/delegate/|"../../plugins/delegate/|g' tests/delegate/*.mjs
```

- [ ] **Step 3: 全文重寫 `tests/delegate/plugin-structure.test.mjs`**

```js
import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMMANDS = ["task", "execute-plan", "status", "result", "cancel", "setup"];

test("every command md exists, has frontmatter, forwards to the companion", () => {
  for (const name of COMMANDS) {
    const file = path.join(REPO_ROOT, "plugins/delegate/commands", `${name}.md`);
    assert.ok(fs.existsSync(file), `${name}.md missing`);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith("---"), `${name}.md missing frontmatter`);
    assert.match(text, /description:/);
    assert.match(text, /delegate-companion\.mjs/);
  }
});

test("marketplace entry and plugin.json agree for delegate", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".claude-plugin/marketplace.json"), "utf8"),
  );
  const entry = marketplace.plugins.find((p) => p.name === "delegate");
  assert.ok(entry, "delegate missing from marketplace");
  assert.equal(entry.source, "./plugins/delegate");
  const plugin = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "plugins/delegate/.claude-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(plugin.name, "delegate");
  assert.equal(entry.version, plugin.version);
});
```

（原版斷言 `plugin.version === pkg.version` — monorepo 根 package.json 不再對應單一 plugin 版號，故解耦。）

- [ ] **Step 4: marketplace.json 加 delegate entry**

`plugins` 陣列改為：

```json
  "plugins": [
    {
      "name": "delegate",
      "source": "./plugins/delegate",
      "description": "Delegate execution tasks to cheap-model headless Claude Code via settings profiles",
      "version": "0.1.0"
    }
  ]
```

- [ ] **Step 5: package.json 接上 delegate 測試**

`scripts` 改為：

```json
  "scripts": {
    "test": "npm run test:structure && npm run test:delegate",
    "test:structure": "node --test tests/fleet-structure.test.mjs",
    "test:delegate": "node --test tests/delegate/*.test.mjs"
  }
```

- [ ] **Step 6: 驗證**

Run: `grep -rn '"\.\./plugins/delegate' tests/delegate/ | wc -l`
Expected: `0`（全部已改成 `../../`）
Run: `diff -r /home/audichuang/research/delegate-plugin-cc/plugins/delegate plugins/delegate`
Expected: 無輸出（plugin payload 逐 byte 相同 = 零行為改變）
Run: `npm test`
Expected: PASS — structure 1 + delegate 90，fail 0

- [ ] **Step 7: Commit**

```bash
git add plugins/delegate tests/delegate package.json .claude-plugin/marketplace.json
git commit -m "feat: import delegate plugin verbatim from delegate-plugin-cc (90 tests green)"
```

---

### Task 3: 搬入 antigravity

**Files:**
- Create: `plugins/antigravity/`（自 antigravity-plugin 根目錄，扣除裁定 3 的留下清單）
- Create: `tests/antigravity/`（27 個測試檔，import 路徑重寫）
- Modify: `tests/antigravity/bin.test.mjs:19`（REPO_ROOT 指向）
- Modify: `package.json`、`.claude-plugin/marketplace.json`

- [ ] **Step 1: git archive 搬入後修剪**

```bash
cd /home/audichuang/research/agent-fleet-cc
mkdir -p plugins/antigravity
git -C /home/audichuang/research/antigravity-plugin archive HEAD | tar -x -C plugins/antigravity
mv plugins/antigravity/tests tests/antigravity
rm -rf plugins/antigravity/.github
rm -f plugins/antigravity/CONTRIBUTING.md plugins/antigravity/SECURITY.md \
      plugins/antigravity/CLAUDE.md plugins/antigravity/.gitignore \
      plugins/antigravity/.claude-plugin/marketplace.json
```

（`.claude-plugin/plugin.json` 保留 — 那是安裝必需的 manifest；移除的是舊 marketplace 定義。）

- [ ] **Step 2: 改寫測試路徑**

```bash
sed -i "s|'\.\./scripts|'../../plugins/antigravity/scripts|g" tests/antigravity/*.test.mjs
```

`tests/antigravity/bin.test.mjs` 第 19 行：

```js
// 舊
const REPO_ROOT = path.resolve(__dirname, '..');
// 新（指向 plugin 根，bin/ 在那裡）
const REPO_ROOT = path.resolve(__dirname, '../../plugins/antigravity');
```

- [ ] **Step 3: 殘留路徑掃描**

Run: `grep -rn "'\.\./" tests/antigravity/*.test.mjs | grep -v "'\.\./\.\./plugins/antigravity" | grep -v "'\.\./fixtures\|'\./" || echo CLEAN`
Expected: `CLEAN`（若有殘留，逐筆改成 `'../../plugins/antigravity/...` 後重跑本步驟）

- [ ] **Step 4: marketplace entry + 測試 script**

marketplace `plugins` 陣列**前面**插入（維持 codex/antigravity/delegate 之外的順序不重要，但本計畫統一加在 delegate 前）：

```json
    {
      "name": "antigravity",
      "source": "./plugins/antigravity",
      "description": "Use Google Antigravity (agy) from Claude Code to review code, delegate tasks, generate images, and hand off work — with a liveness watchdog and cross-process-safe job state.",
      "version": "0.2.0",
      "author": { "name": "audichuang" }
    },
```

package.json `scripts`：

```json
    "test": "npm run test:structure && npm run test:delegate && npm run test:antigravity",
    "test:antigravity": "node --test --experimental-test-module-mocks tests/antigravity/*.test.mjs",
```

- [ ] **Step 5: 驗證**

Run: `for d in commands scripts bin agents .agents .codex-plugin docs; do diff -r /home/audichuang/research/antigravity-plugin/$d plugins/antigravity/$d; done; for f in README.md CHANGELOG.md LICENSE SKILL.md plugin.json package.json; do diff /home/audichuang/research/antigravity-plugin/$f plugins/antigravity/$f; done`
Expected: 無輸出（搬入的內容逐 byte 相同；若某目錄不存在於來源，該行報 No such file 屬預期，跳過）
Run: `npm test`
Expected: PASS — structure + delegate 90 + antigravity 全數，fail 0

- [ ] **Step 6: Commit**

```bash
git add plugins/antigravity tests/antigravity package.json .claude-plugin/marketplace.json
git commit -m "feat: import antigravity plugin verbatim (multi-host files kept; repo-meta left behind)"
```

---

### Task 4: 搬入 codex + 完整性斷言

**Files:**
- Modify: `tests/fleet-structure.test.mjs`（加「恰好三個 plugin」斷言 — 先紅）
- Create: `plugins/codex/`、`tests/codex/`（不含 bump-version）
- Create: `tsconfig.app-server.json`（自 codex repo 根）
- Modify: `package.json`、`.claude-plugin/marketplace.json`

- [ ] **Step 1: 寫失敗斷言** — `tests/fleet-structure.test.mjs` 末尾加：

```js
test("marketplace lists exactly the three engine plugins", () => {
  const marketplace = readJson(path.join(ROOT, ".claude-plugin/marketplace.json"));
  assert.deepEqual(
    marketplace.plugins.map((p) => p.name).sort(),
    ["antigravity", "codex", "delegate"],
  );
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:structure`
Expected: FAIL（目前只有 antigravity、delegate 兩個）

- [ ] **Step 3: git archive 搬入**

```bash
cd /home/audichuang/research/agent-fleet-cc
git -C /home/audichuang/research/codex-plugin-cc archive HEAD plugins/codex | tar -x
mkdir -p /tmp/fleet-mv && git -C /home/audichuang/research/codex-plugin-cc archive HEAD tests tsconfig.app-server.json | tar -x -C /tmp/fleet-mv
mv /tmp/fleet-mv/tests tests/codex
mv /tmp/fleet-mv/tsconfig.app-server.json .
rm -rf /tmp/fleet-mv
rm tests/codex/bump-version.test.mjs   # 裁定 2：版本工具不搬
```

- [ ] **Step 4: 改寫測試路徑**

```bash
sed -i 's|"\.\./plugins/codex/|"../../plugins/codex/|g' tests/codex/*.mjs
```

Run: `grep -rn '"\.\./plugins/codex' tests/codex/ | wc -l`
Expected: `0`

- [ ] **Step 5: marketplace entry + scripts**

marketplace `plugins` 陣列最前面插入：

```json
    {
      "name": "codex",
      "source": "./plugins/codex",
      "description": "Use Codex from Claude Code to review code or delegate tasks.",
      "version": "1.0.18",
      "author": { "name": "OpenAI" }
    },
```

package.json `scripts`（最終形）：

```json
  "scripts": {
    "test": "npm run test:structure && npm run test:delegate && npm run test:antigravity && npm run test:codex",
    "test:structure": "node --test tests/fleet-structure.test.mjs",
    "test:delegate": "node --test tests/delegate/*.test.mjs",
    "test:antigravity": "node --test --experimental-test-module-mocks tests/antigravity/*.test.mjs",
    "test:codex": "node --test tests/codex/*.test.mjs",
    "prebuild:codex": "mkdir -p plugins/codex/.generated/app-server-types && codex app-server generate-ts --out plugins/codex/.generated/app-server-types",
    "build:codex": "tsc -p tsconfig.app-server.json"
  }
```

（檢查 `tsconfig.app-server.json` 內的路徑都是 `plugins/codex/...` 相對 repo 根 — 版面未變，應原樣可用；若有 `tests/` 引用改成 `tests/codex/`。）

- [ ] **Step 6: 驗證**

Run: `diff -r -x .generated /home/audichuang/research/codex-plugin-cc/plugins/codex plugins/codex`
Expected: 無輸出
Run: `npm test`
Expected: PASS — 四段全綠（structure 2、delegate 90、antigravity 全數、codex 全數），fail 0
Run: `npm run build:codex`
Expected: 成功（需本機 codex CLI；產出 `plugins/codex/.generated/`，已被 gitignore）

- [ ] **Step 7: Commit**

```bash
git add tests/fleet-structure.test.mjs plugins/codex tests/codex tsconfig.app-server.json package.json .claude-plugin/marketplace.json
git commit -m "feat: import codex plugin verbatim (bump-version tooling left behind; suite green)"
```

---

### Task 5: README、CI、文件

**Files:**
- Create: `README.md`、`.github/workflows/ci.yml`
- Create: `docs/specs/2026-06-12-agent-fleet-merge-design.md`（自 delegate repo 複製）

- [ ] **Step 1: 寫 README.md**

```markdown
# agent-fleet — one marketplace for AI-agent delegation plugins

Three Claude Code plugins, one marketplace:

| Plugin | Commands | What it delegates to |
|---|---|---|
| `codex` | `/codex:*` (review, adversarial-review, rescue, execute-plan, handoff, status, result, attach, cancel, setup) | OpenAI Codex (app-server) |
| `antigravity` | `/antigravity:*` (review, adversarial-review, rescue, task, image, handoff, status, result, cancel, setup) | Google Antigravity CLI (`agy`) |
| `delegate` | `/delegate:*` (task, execute-plan, status, result, cancel, setup) | Cheap-model headless Claude Code via settings profiles |

## Install

```bash
/plugin marketplace add audichuang/agent-fleet-cc
/plugin install codex@agent-fleet
/plugin install antigravity@agent-fleet
/plugin install delegate@agent-fleet
/reload-plugins
```

Install only the ones you use. Per-plugin requirements (codex CLI login, agy OAuth,
Anthropic-compatible endpoint profiles) are documented in each plugin's directory
under `plugins/<name>/`.

## Migrating from the standalone repos

This repo supersedes `audichuang/codex-plugin-cc` and `audichuang/antigravity-plugin`
(both archived) plus the local-only delegate plugin. Command prefixes are unchanged.

1. Uninstall the old plugins and remove the old marketplaces
   (`openai-codex`, `antigravity`, `claude-delegate`) — prefixes would collide.
2. Add this marketplace and install (commands above).
3. Done. Job state and profiles live under `~/.claude/plugins/data/<plugin>/`,
   keyed by plugin name — they survive unchanged (your `profiles/*.json` included).

## Development

```bash
npm test                 # structure + all three hermetic suites (Node >= 22.3)
npm run test:codex       # one suite at a time
npm run build:codex      # typecheck codex app-server glue (needs codex CLI)
```

Layout: `plugins/<name>/` is the exact install payload; `tests/<name>/` mirrors each
source repo's hermetic suite (fake binaries, redirected `CLAUDE_PLUGIN_DATA`, no
real network). Roadmap (shared job-runtime base, fleet status) lives in
`docs/specs/2026-06-12-agent-fleet-merge-design.md`.
```

- [ ] **Step 2: 寫 `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Install Codex CLI (codex suite + typecheck prereq)
        run: npm install -g @openai/codex
      - run: npm test
      - run: npm run build:codex
```

（Node 矩陣先單押 22；antigravity 舊 CI 驗過 22/24，codex 舊 CI 只驗過 22 — 等三套合流穩定後再擴。）

- [ ] **Step 3: 複製 spec**

```bash
mkdir -p docs/specs
cp /home/audichuang/research/delegate-plugin-cc/docs/superpowers/specs/2026-06-12-agent-fleet-merge-design.md docs/specs/
```

- [ ] **Step 4: Commit**

```bash
git add README.md .github docs
git commit -m "docs: README with install + migration; CI workflow; founding design spec"
```

---

### Task 6: 推上 GitHub + 實裝冒煙

- [ ] **Step 1: 建遠端並推送**

```bash
cd /home/audichuang/research/agent-fleet-cc
gh repo create audichuang/agent-fleet-cc --public --source=. --push \
  --description "One marketplace for AI-agent delegation plugins: codex, antigravity (agy), cheap-model Claude Code delegate"
```

Expected: repo 建立、main 推上去。
Run: `gh run watch --exit-status`（或稍候 `gh run list --limit 1`）
Expected: CI 綠。

- [ ] **Step 2: 腳本化冒煙 — delegate 真實 job（驗證搬遷後 companion 可用 + 既有 profile 原地存活）**

```bash
env DELEGATE_PLUGIN_DATA="$HOME/.claude/plugins/data/delegate" \
  node plugins/delegate/scripts/delegate-companion.mjs setup
# Expected: ✓ claude CLI、✓ profile deepseek

env DELEGATE_PLUGIN_DATA="$HOME/.claude/plugins/data/delegate" \
  node plugins/delegate/scripts/delegate-companion.mjs task \
  "Reply with exactly one word: PONG" --profile deepseek --background
# Expected: 回 job id；接著用 status / result <job-id> 取回 PONG
```

- [ ] **Step 3: 手動冒煙（需使用者在 Claude Code 介面操作 — 向使用者列出此清單後暫停）**

1. 先移除舊的：uninstall `codex@openai-codex`、`antigravity@antigravity`、`delegate@claude-delegate`，再 remove 三個舊 marketplace（前綴會撞名）。
2. `/plugin marketplace add audichuang/agent-fleet-cc`
3. `/plugin install codex@agent-fleet` + `antigravity@agent-fleet` + `delegate@agent-fleet`，`/reload-plugins`
4. 各跑一個無害指令確認佈線：`/codex:status`、`/antigravity:status`、`/delegate:status`
5. 各跑一個小真實 job（spec §11 完成定義）：`/codex:rescue 說 PONG`、`/antigravity:task say PONG`、`/delegate:task "Reply PONG" --profile deepseek --background`

---

### Task 7: 舊 repo 收尾（⚠️ 對外動作 — 執行前向使用者確認一次）

**事實（已驗證）：** `delegate-plugin-cc` 沒有 remote、GitHub 上不存在（從未發佈）— 它只做本機橫幅 commit，無 push/archive。push/archive 只適用 `codex-plugin-cc`（推 `fork` remote）與 `antigravity-plugin`（推 `origin`）。

- [ ] **Step 1: 三個舊 repo README 頂部加遷移橫幅**

對 `codex-plugin-cc`、`antigravity-plugin`、`delegate-plugin-cc` 各自，在 `README.md` 第一個標題後插入：

```markdown
> [!IMPORTANT]
> **Merged into [audichuang/agent-fleet-cc](https://github.com/audichuang/agent-fleet-cc)** (marketplace `agent-fleet`); this repo is archived.
> Migrate: uninstall this plugin and remove this marketplace, then
> `/plugin marketplace add audichuang/agent-fleet-cc` and install `<plugin>@agent-fleet`.
> Job state and profiles under `~/.claude/plugins/data/<plugin>/` survive unchanged.
```

（`<plugin>` 分別代入 codex / antigravity / delegate。）

```bash
cd /home/audichuang/research/delegate-plugin-cc   # 本機 only，無 push
git add README.md && git commit -m "docs: merged into agent-fleet-cc (local-only repo, no archive needed)"
cd /home/audichuang/research/antigravity-plugin
git add README.md && git commit -m "docs: archived — merged into agent-fleet-cc" && git push origin
cd /home/audichuang/research/codex-plugin-cc
git add README.md && git commit -m "docs: archived — merged into agent-fleet-cc" && git push fork HEAD:main
```

- [ ] **Step 2: Archive 兩個已發佈的 repo（可逆 — GitHub 可 unarchive）**

```bash
gh repo archive audichuang/antigravity-plugin --yes
gh repo archive audichuang/codex-plugin-cc --yes
```

Expected: 兩個 repo 顯示 archived；本機 clone 不受影響（第二階段還要從它們 cherry-pick 歷史脈絡時照常可讀）。

---

## 完成定義（對照 spec §11 第一階段）

- [ ] 新 repo 三 plugin 並存，`npm test` 全綠（structure 2 + delegate 90 + antigravity 全數 + codex 全數）
- [ ] `diff -r` 驗證各 plugin payload 與來源逐 byte 相同（扣除明文裁定的留下清單）
- [ ] 從 `agent-fleet` marketplace 實裝三個 plugin，各跑一個真實 job 成功
- [ ] CI 綠
- [ ] 三個舊 repo 加遷移橫幅；兩個已發佈的（codex、antigravity）archive，delegate 為本機 repo 僅留橫幅
