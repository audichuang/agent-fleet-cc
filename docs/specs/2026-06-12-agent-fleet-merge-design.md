# agent-fleet-cc 設計規格 — 三個委派 plugin 合併為單一 marketplace monorepo

日期：2026-06-12
狀態：設計已逐段核准（brainstorming session），待使用者審閱本文件
參考：codex-plugin-cc、antigravity-plugin、delegate-plugin-cc（三個來源 repo，皆在 `~/research/`）

## 1. 背景與動機

三個 plugin 是「同一個模式的三次實作」：spawn 外部 agent CLI、背景 job
生命週期（per-job JSON 真相、O_EXCL CAS 終態、死 PID reconcile）、
status/result/cancel/setup 指令、hermetic 測試（fake binary + 重導 data dir）。
`args.mjs`、`render.mjs`、`state.mjs`、`job-control.mjs` 三邊同名但實作已分岔。

| | codex-plugin-cc | antigravity-plugin | delegate-plugin-cc |
|---|---|---|---|
| 引擎 | Codex app-server（常駐 broker、JSON-RPC） | 一次性 `agy --print` | 一次性 `claude -p` |
| 獨有功能 | review、adversarial-review、handoff、stop-review-gate、attach | image 生成、handoff、multi-host | profile 切模型、env 完全重建、防遞迴 |
| 血統 | openai/codex-plugin-cc 的 fork（領先 51 commits、落後 0） | sakibsadmanshajib fork（領先 3、落後 0） | 原創 |
| lib 規模 | ~180K | ~90K | ~20K（最新、吸收前兩者教訓的精簡設計） |

使用者目標（已確認）：

1. **維護負擔**：同樣的地基 bug 不要修三次、測試不要寫三套。
2. **統一使用體驗**：一致的指令語法與 job 管理。
3. **單一 marketplace**：裝一個 marketplace 就拿到全部。
4. **統一調度抽象層**：底層架構要能容納全部引擎、高擴充性、可觀測、可測試。

### 已驗證的關鍵技術事實

- **安裝只快取 plugin 子目錄**（實測 `~/.claude/plugins/cache/claude-delegate/delegate/0.1.0/`
  只含 `scripts/ commands/ .claude-plugin/`）→ 共享 lib 必須 vendor 進各 plugin。
- **一個 marketplace 可裝多個 plugin**（claude-plugins-official 即此模式）。
- 指令前綴 = plugin 名 → 保留 `/codex:*` `/antigravity:*` `/delegate:*` 就必須維持三個 plugin。
- 兩個 fork 目前都落後 upstream 0 commits → 放棄追蹤的即時成本為零。
- Job 資料與 profile 依 plugin 名存於 `~/.claude/plugins/data/<plugin>/` → plugin 名不變則資料原地存活。

## 2. 決策摘要（已逐段核准）

- 開**全新 repo `agent-fleet-cc`**，marketplace 名 **`agent-fleet`**；新 repo 乾淨起始，不帶三個舊 repo 的 git 歷史。
- **保留各引擎指令前綴**：三個 plugin（codex / antigravity / delegate）並存於一個 marketplace。
- **只支援 Claude Code**：antigravity 的 multi-host（Codex CLI / agy 原生 / npx）於第二階段拆除。
- **三階段漸進**，每階段可獨立收工：搬遷並存 → 共享地基 → fleet 視圖。
- 舊三個 repo 加遷移指引後 archive，不刪（歷史與 upstream cherry-pick 來源）。

## 3. Repo 佈局

```
agent-fleet-cc/
├── .claude-plugin/marketplace.json   # 一份，列所有 plugin
├── plugins/
│   ├── codex/          # /codex:*       版號沿用 1.0.18
│   ├── antigravity/    # /antigravity:* 版號沿用 0.2.0
│   ├── delegate/       # /delegate:*    版號沿用 0.1.0
│   └── fleet/          # /fleet:*       第三階段新增（選裝）
├── shared/lib/         # 共享地基 single source of truth（第二階段）
├── scripts/sync-shared.mjs   # vendor：shared/lib → plugins/*/scripts/lib/shared/
├── tests/{codex,antigravity,delegate,shared}/
└── docs/
```

## 4. 第一階段 — 搬遷並存（零行為改變）

- `codex-plugin-cc/plugins/codex/` → `plugins/codex/`（原樣）。
- `antigravity-plugin/`（repo 根即 plugin）→ `plugins/antigravity/`；multi-host
  佈線檔（`.codex-plugin/`、`.agents/`、`bin/`）**原樣帶著**，拆除留到第二階段。
- `delegate-plugin-cc/plugins/delegate/` → `plugins/delegate/`（原樣）。
- 各 repo `tests/` → `tests/<plugin>/`，單一 `npm test` 全跑（測試不進安裝快取，位置自由）。
- 各 plugin 版號不變；plugin 名不變 → `~/.claude/plugins/data/<plugin>/` 的
  job 狀態與 profile（含 deepseek.json）原地存活，零搬遷。

**使用者遷移步驟**（一次性，寫進 README）：先 uninstall 舊三個 plugin、
remove 舊三個 marketplace（避免前綴撞名），再 add `agent-fleet`、install 所需 plugin。

**交付**：單一 marketplace ✅、單一 repo/CI ✅，風險近乎零。

## 5. 第二階段 — 共享地基（Ports & Adapters）

### 5.1 核心思想

引擎差異只在「怎麼執行、怎麼解析輸出」；job 生命週期、狀態機、觀測、控制是普世的。
地基 = 「Job Runtime 框架」+「Engine Adapter 插件」：

```
shared/lib/
├── core/                      ← 純引擎無關，零 I/O 假設，100% 可單測
│   ├── job.mjs                # Job schema + 統一狀態機（唯一真相）
│   │                          #   created → running → completed|failed|cancelled|timed-out
│   ├── state-store.mjs        # per-job JSON、O_EXCL CAS、atomic write、prune
│   ├── reconcile.mjs          # 死 PID 探活、liveness 分類、timeout 政策
│   └── events.mjs             # 正規化事件日誌（觀測性脊椎）
├── runtime/
│   ├── worker.mjs             # 通用 detached worker：吃 adapter，驅動完整生命週期
│   └── spawn.mjs              # process seam（測試可注入）
├── adapter-api.mjs (+ .md)    # EngineAdapter 合約（擴充點）
└── render/                    # status/result 渲染，吃統一 Job schema
```

### 5.2 EngineAdapter 合約 — 雙形態，從第一天就容納 broker

```js
// ProcessAdapter（一次性程序型：claude -p、agy --print）
{
  name,
  buildInvocation(jobSpec),        // → { argv, env, stdinPayload }（delegate 的 env 重建住這）
  parseEvent(rawLine),             // → 正規化事件 | null（容錯跳行）
  extractResult(events, exitCode), // → { ok, resultText, sessionId }
  classifyError(stderr, exitCode), // → 'auth' | 'not-installed' | 'endpoint' | ...
  resumeArgs(sessionId),           // claude: -r <id>；agy: --conversation <id>
}
// SessionAdapter（常駐 broker 型：codex app-server）— 合約的第二種合法形態，
// worker 內部 strategy 分流。介面細節於實作 codex 移植時定稿。
```

加第 4 個引擎的成本 = 實作 adapter + 提供 fake fixture + 通過 conformance suite + 加 commands md。

### 5.3 可觀測性 — 正規化事件日誌

每個 job 目錄自包含：`spec.json`（任務定義 + 引擎 + 去敏 env 摘要）、
`events.ndjson`（正規化事件流；引擎原始輸出包在 `raw` 欄透傳）、`result.json`。
事件格式統一 → 跨引擎 status、「最後活動」、fleet 視圖皆為 schema 的副產品。

### 5.4 可測試性 — Adapter conformance suite

參數化合約測試：任何 adapter + fake binary fixture 自動驗七種劇本 —
正常完成 / 半路斷線 / 雜訊容錯 / 卡死 / 立即退出 / cancel 競態 / resume。
hermetic 手法（重導 data dir、注入 spawnImpl/clock）沿用三個來源 repo 的既有模式。

### 5.5 Vendor 機制與 drift check

`scripts/sync-shared.mjs` 複製 `shared/lib/` → 各 `plugins/*/scripts/lib/shared/`；
CI 跑 sync 後 `git diff --exit-code`，vendored 副本與 source 不同步即紅燈。

### 5.6 移植順序（風險遞增）

1. **delegate**：地基母體，幾乎是搬目錄。
2. **antigravity**：同為一次性 spawn；此時拆 multi-host（`host-detect.mjs`、
   `.codex-plugin/`、`.agents/`、npx 入口），保留 image / handoff / adversarial-review。
3. **codex**：**只移植 job-state 層**（state/CAS/liveness/cancel）。
   broker / app-server / attach / review-gate 的引擎機器**不動**（戰鬥驗證過，
   重寫無收益）；SessionAdapter 化可無限期延後，待合約被兩個一次性引擎驗證後再議。

每個 plugin 移植完跑自己整套既有 hermetic 測試，綠了才動下一個。

### 5.7 兩個明確裁定

1. **Job 資料仍按 plugin 分目錄**，schema 統一；fleet 視圖掃兄弟目錄實現。
   不搞單一共用 store：擁有權清楚、解除安裝不留孤兒資料。
2. **Reconcile 雙保險**：每次 status 讀取同步 reconcile（永遠有效）+
   可選 detached watchdog（agy/codex 開、delegate 可不開）— 政策在 core，開關由 adapter 宣告。

## 6. 第三階段 — fleet 視圖（選配）

極薄的第四個 plugin `fleet`，僅兩個指令、~200 行、不執行任務：

- `/fleet:status`：掃三個 plugin 的 data 目錄，統一 schema 渲染（引擎、job、狀態、最後活動、耗時）。
- `/fleet:cancel <id>`：跨引擎按 id 取消（轉發給對應 plugin 的 cancel 路徑）。

獨立 plugin 而非塞進某引擎的理由：不裝的人三個引擎照常各自運作。

## 7. 錯誤處理原則（地基層統一）

- 引擎 binary 不存在 / 未登入 → `classifyError` 給可行動指引（裝什麼、跑什麼登入指令）。
- worker 被 SIGKILL / 機器重開 → 同步 reconcile 下次讀取時標 failed，永不卡 `running`。
- 終態競態（cancel vs 自然完成）→ CAS first-terminal-writer-wins，cancel 永不蓋掉真實結果。
- stdin EPIPE、stream 雜訊、非預期退出 → conformance suite 固定劇本，每個 adapter 被迫處理。

## 8. 測試策略

conformance suite（合約級）+ 各引擎既有 hermetic 測試（行為級）+
plugin-structure 測試（marketplace.json / plugin.json 完整性）+
drift check（vendor 同步）；單一 `npm test` 全綠才算數。

## 9. 風險與緩解

| 風險 | 緩解 |
|---|---|
| codex broker 移植 SessionAdapter 出問題 | 排最後；第二階段只換 state 層已拿到大部分收益，SessionAdapter 可無限期延後 |
| vendored 副本與 shared/ 漂移 | CI drift check |
| 遷移期指令前綴撞名 | 文件明定先 uninstall 舊三個再裝新的 |
| upstream 日後出重要修補 | 目前 0 behind；舊 repo archive 不刪，必要時人工 cherry-pick |
| 統一 Job schema 與三邊現有 job JSON 不相容 | 不做 migration：新 job 用新 schema，舊 job 隨 prune 自然淘汰（已核准） |

## 10. 非目標（明確排除）

- 統一成 `/ai:task --engine x` 的單一指令面（已否決：保留各引擎前綴）。
- multi-host 支援（只留 Claude Code）。
- 共享地基發佈成 npm package（安裝不跑 npm install，終究要 vendor）。
- 第二階段全面重寫 codex broker。
- 帶入三個舊 repo 的 git 歷史。

## 11. 各階段完成定義

- **第一階段**：新 repo 三 plugin 並存、`npm test` 全綠（三套原測試）、
  從 `agent-fleet` marketplace 實裝三個 plugin 並各跑一個真實 job 成功、舊 repo archive。
- **第二階段**：shared/lib 落地、delegate 與 antigravity 跑在 ProcessAdapter 上、
  codex 換 job-state 層、conformance suite 對兩個 adapter 全綠、drift check 上 CI、
  multi-host 已拆、真實端點冒煙（deepseek profile + agy + codex 各一個 job）。
- **第三階段**：`/fleet:status` 能同時看到三引擎 job、`/fleet:cancel` 跨引擎可用。
