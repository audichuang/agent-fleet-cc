# delegate → cc 重定位設計(Phase 1)

- 日期:2026-06-20
- 狀態:設計已確認(brainstorming Understanding Lock 通過),待實作
- 範圍:把 `delegate` plugin 徹底改名為 `cc` 並重新定位;**不含** codex 整合(Phase 2)

---

## Understanding Summary

1. 把 `delegate` plugin **徹底改名為 `cc`**,重新定位為「fleet 裡的 **Claude Code 引擎
   adapter**」——在 Claude Code 內 spawn `claude`,用 **profile** 決定那個 claude 連哪個
   endpoint / 用哪個模型 / 什麼權限。
2. **原生 claude(空 profile `{}`)從 workaround 升格為一等公民**。已實證可行:用空 settings
   實跑,模型自報「Claude(Opus 4.8)」;對照 deepseek profile 自報「DeepSeek V4 Pro」,證明
   profile 的 `env` block 是唯一變數,空 profile = 原生認證(`~/.claude/.credentials.json`)。
3. 「徹底換」涵蓋**門面 + 內裡**:plugin 名 / `/cc:*` 前綴 / 目錄 / marketplace / README /
   fleet 顯示,以及 job 記錄 engine id、env 變數、dataRoot、recursion marker、companion 檔名。
4. **附一次性遷移**:現有 profile 與環境變數從 `DELEGATE_*` 轉 `CC_*`。
5. **fleet 連帶更新**;IRONCLAD 允許(fleet 不在保護名單);**不碰 codex/antigravity** 原始檔。
6. **行為/介面零改動**:所有 verb(task/status/wait/logs/result/cancel/setup)、旗標、shared
   runtime、conformance 全部不變。這是改名+重定位,不是功能改動。
7. **codex 主動外包給 cc** 的整合明確排除在 Phase 1 之外,Phase 2 獨立 brainstorm。

## 為什麼改名(定位論據)

agent-fleet 裡三個引擎 plugin 的命名不一致:

```
codex        → 派給 Codex 引擎          (引擎名)
antigravity  → 派給 Antigravity 引擎    (引擎名)
delegate     → 派給 Claude Code 引擎    (動詞,不一致)
fleet        → 管理上面三個
```

`cc` = Claude Code 引擎 adapter,與 codex/antigravity 對齊。caveman/superpowers「命名中性化」
的理由(要散佈到多個宿主)對 delegate 不成立——delegate 是**從一個宿主 spawn 一個被控引擎**
的派工器,不是一份要裝進多宿主的 skill。「未來要派別的引擎時 cc 就過時」的疑慮也不成立:派
codex/agy 已是 codex/antigravity 的職責,cc 永遠只派 claude。

## Assumptions

- A1:不保留 `/delegate:*` 舊命令 alias,直接全換(個人專案,無外部依賴)。
- A2:`CLAUDE_DELEGATE_ACTIVE` → `CLAUDE_CC_ACTIVE`;`delegate-companion.mjs` →
  `cc-companion.mjs`;vendored 路徑 → `plugins/cc/scripts/lib/shared/`。
- A3:舊 env 變數(`DELEGATE_*`)**不留 fallback**(徹底換,非相容墊片)。
- A4:既有舊 delegate job 記錄不遷移,可丟。
- A5:開 feature 分支做(AGENTS.md 規定),不直接 commit main;全程 `npm test` 驗證。

## Decision Log

| 決策 | 選擇 | 替代 | 理由 |
|---|---|---|---|
| 改名 | delegate→**cc** | 保留 delegate | fleet 裡兄弟都是引擎名,delegate 是動詞、不一致 |
| 名字 | **cc** | claude / claude-code | 最短、CC=Claude Code 直覺、對齊短引擎名 |
| 定位軸 | Claude 引擎 adapter | 多 host(superpowers 路線) | delegate 是派工器非 skill,多 host 不成立 |
| 深度 | 徹底(門面+內裡) | 只門面 / 相容墊片 | 唯一用戶,避免技術債 |
| 版本 | **0.3.0** | 1.0.0 | 介面行為不變,與兄弟版本階段對齊 |
| native profile | setup **自動建** | 只提示 | 原生開箱即用是重定位核心訴求 |
| 舊 alias/env fallback | **不留** | 保留一版 | 徹底換,無外部依賴 |
| codex 整合 | **Phase 2** | 這次一起 | 風險隔離,情境(codex 主動外包)需獨立 brainstorm |
| single-profile auto-select | `resolveProfile` 在**恰好一個 profile** 時自動採用(0 或 2+ 仍報錯) | 維持「永遠要 --profile」 | codex review 指出:setup 自動建 native 但 task 不會自動用它 → 承諾落空;且 Phase 2 codex 直接呼叫 cc-companion 需免帶 --profile。1 個 profile 無歧義 ≠「猜」 |

## 設計細節

### 1. 改名機制:git mv 保歷史 + 分類字串替換

先 `git mv` 搬目錄/檔案(保留 blame),再做**分類**替換(非無腦 sed):

| 替換 | 範圍 |
|---|---|
| `plugins/delegate/` → `plugins/cc/`;`tests/delegate/` → `tests/cc/` | git mv |
| `delegate-companion.mjs` → `cc-companion.mjs`;`delegate.conformance.test.mjs` → `cc.conformance.test.mjs` | git mv |
| `engine: "delegate"` → `"cc"`(job schema 欄位) | adapter + 所有測試斷言 |
| `/delegate:` → `/cc:` | commands、README、fleet/setup.md |
| `DELEGATE_*` → `CC_*`(PLUGIN_DATA/DEFAULT_PROFILE/CLAUDE_BIN/PERMISSION_MODE/JOB_TIMEOUT_MS) | adapter、companion、fleet-doctor、測試 |
| `CLAUDE_DELEGATE_ACTIVE` → `CLAUDE_CC_ACTIVE` | adapter、companion、env guard、測試 |
| dataRoot fallback `"delegate"` → `"cc"` | adapter resolveDataRoot、fleet-doctor |
| `test:delegate` → `test:cc` | package.json scripts + test chain |
| plugin name/source/description | marketplace.json、plugins/cc/.claude-plugin/plugin.json |
| `TARGETS = ["delegate"]` → `["cc"]` | scripts/sync-shared.mjs |

### 2. 不可動的邊界(防誤殺)

- IRONCLAD:不碰 `plugins/{codex,antigravity}/` 與其 tests。fleet 可改(不在保護名單)。
- **不替換的 "delegate" 字面**:
  - `docs/specs/*` 歷史規格(保留原貌)。
  - marketplace.json 裡 codex/antigravity 描述、antigravity/SKILL.md 的英文動詞「delegate tasks」。
  - README「Migrating from the standalone repos」段提到舊 repo 的部分。
  - `shared/lib/*` 註解裡的歷史淵源提及(可保留,非功能性)。

### 3. cc:setup 自動建 native

`cmdSetup` 偵測到**零 profile** 時:
1. 自動寫 `<dataRoot>/profiles/native.json`,內容 `{}`(0600)。
2. 輸出 `✓ profile native (原生 claude)` 並提示可直接 `/cc:task "..."`。

因為 `task` 在「恰好一個 profile」時自動採用該 profile,所以裝好 cc → `cc:setup` → `/cc:task`
直接跑原生,零額外步驟。這是 setup 唯一一處從 guide-only 變成「會寫檔」,需在測試覆蓋。

### 4. dataRoot 與遷移

- `resolveDataRoot` 順序:`CC_PLUGIN_DATA` → `CLAUDE_PLUGIN_DATA` → `~/.claude/plugins/data/cc`。
- dev 環境(`CLAUDE_PLUGIN_DATA=...codex-agent-fleet`,marketplace 級不隨 plugin 改):現有
  `deepseek.json`/`native.json` 不需搬;只需把環境變數 `DELEGATE_DEFAULT_PROFILE=deepseek` 改
  `CC_DEFAULT_PROFILE=deepseek`。
- 正式安裝:host 依 plugin 名給 dataRoot,從 `.../delegate` → `.../cc`;README 附 `mv` 遷移指引。

### 5. 測試與驗證

- 更新 `tests/cc/*` 全部斷言(engine 欄位、env 變數、recursion marker、companion 檔名)。
- 更新 `tests/fleet/*`(`CANONICAL` 斷言、engine id)、`tests/fleet-structure.test.mjs`
  (marketplace 一致性)。
- 新增:`cc:setup` 自動建 native 的測試(零 profile → 寫檔 → 列出)。
- `npm run sync-shared` 重新 vendoring,source + vendored copy 都 commit。
- 驗證閘:`npm test` 全綠 + 一次真實 smoke(`/cc:task` 原生 + deepseek 各一)。

### 6. 版本 / marketplace

- `marketplace.json` cc 條目 version `0.3.0`,description 改為「派一個 Claude Code 實例,用
  profile 切換 endpoint/模型(原生 / 便宜端點 / 不同模型)」。
- `package.json` description 同步更新定位措辭。

## 風險

- **誤殺替換**:英文動詞 "delegate" 與歷史 specs 不能替換 → 用分類替換 + 人工審查 diff。
- **engine id 改動**:`engine: "delegate"` → `"cc"` 影響 job.json schema 與 fleet-status 正規化
  → 全測試斷言同步更新,真實 smoke 確認 fleet-status 顯示正確。
- **環境變數遷移**:使用者環境的 `DELEGATE_DEFAULT_PROFILE` 失效 → README + 本文件明列改名。

## Post-review 修正(codex handoff,2026-06-20)

codex handoff review 判定 SHIP-WITH-FIXES,兩個 finding 已修並驗證:

1. **(High)** `resolveProfile` 原本無單一 profile 自動採用 → setup 自動建 native 的「開箱即用」
   承諾在 raw companion 呼叫端落空。**修正**:`profiles.mjs` 在恰好一個 profile 時自動採用;
   0 / 2+ 維持報錯。新增測試:`profiles.test.mjs`(0/1/2+ 三態)、`companion-task.test.mjs`
   (2+ fail / 單一 auto-select / 0 fail)、`companion-control.test.mjs`(setup 建 native →
   task 免 --profile 自動採用,端到端)。真實 smoke 確認:單一 native、不帶 --profile →
   `engine:"cc"` completed。
2. **(Low)** `.claude/skills/e2e-testing/`(real-engine-smoke.mjs + SKILL.md)仍指向 delegate
   → real smoke 跑不到 cc。**修正**:全數 delegate→cc(engines.cc / cc-companion / CC_PLUGIN_DATA /
   tests/cc)。

`npm test` 全鏈通過(cc 87 / shared 96 / antigravity 280 / codex 321 / fleet 81 / e2e 20)。

## Phase 2 預告(不在本次)

codex 主動外包給 cc:codex 跑任務時自行判斷哪段適合 Claude,spawn cc 派 claude,結果拿回繼續。
需獨立 brainstorm:code 放 cc 側(讓 codex 調用,不碰 codex plugin)vs 授權改 codex;
codex 如何解析 cc companion 路徑;遞迴守衛跨引擎行為(codex 不設 cc 的 marker,不會被擋)。
