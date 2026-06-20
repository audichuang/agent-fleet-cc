# codex(host)→ cc(claude worker)handoff 設計(Phase 2)

- 日期:2026-06-20
- 狀態:**設計 v2**(已過 5 critic 硬化 + codex handoff 驗證閘 + orca 環境探針;codex 6 blocker 修法見文末「## v2 修訂」,該節 override 上文對應段落;**plan-ready**)
- 範圍:讓 **codex 當最外層 host**(直接跑 codex CLI、Claude Code 不在場)時,能把使用者**明確指派**的子任務 handoff 給 **cc(headless Claude Code worker)**,底層用既有 `cc-companion task` 前景同步拿回結果繼續。
- **本期交付物(釘死的交付邊界)**:cc payload 內的 `.codex-plugin/plugin.json` + `skills/<skill>/SKILL.md` + 一個可單元測的 resolver 模組 + 對應測試 + README/marketplace 同步。**不含**:codex 端安裝管線/installer、codex AI 自動判斷外包、新 runtime、MCP server、SessionStart hook、背景/非同步 handoff 的編排層、cc-companion runtime 的任何改動。codex 端「裝 marketplace + `codex plugin add`」屬使用者操作與**驗證觀察項**,不屬本期交付。

---

## Understanding Summary

1. **本質:雙向 handoff 補完(方向對稱,形態不對稱)。** 既有 handoff 能力是 Claude Code(host)→ codex(worker),由 `codex:handoff` **command** 承載(`plugins/codex/commands/handoff.md`,frontmatter 帶 `argument-hint`/`allowed-tools`)。本期做相反方向:codex(host)→ cc(claude worker)。**注意**:`codex:handoff` 是一個跑在 Claude Code 裡的 slash **command**,不是 skill;本期落地為 **skill**。兩者「角色方向對稱」(host↔worker 互換),但「形態不對稱」——形態差異源於宿主能力差異(見 #4),不是「對稱一個既有的 handoff skill」。
2. **觸發現場:codex 是最外層。** 使用者直接用 codex CLI,Claude Code **不在場**(沒有 `/cc:*` 這種 Claude-Code 式 slash command 可用)。
3. **觸發方式:明確指派,不是 AI 自動判斷。** 指令寫在使用者給 codex 的 prompt 裡(例如「這段請交給 Claude 跑」)。codex 不自行決定哪段該外包。
4. **形態選 skill 的真正理由:codex 宿主無 `/plugin:command` 觸發面。** codex 沒有 Claude-Code 式 `/plugin:command`;使用者是 workflow-driven、把參數寫進 prompt。skill 是 codex 宿主**唯一能被指引/被原生註冊**的形態(已實證,見 #7)。**這才是形態決策的依據,而非「對稱既有 handoff skill」**(被對稱的對象本身是 command)。
5. **落地:cc 升級為「雙宿主 plugin」。** 新增 `plugins/cc/.codex-plugin/plugin.json`(以**同 repo 既有的** `plugins/antigravity/.codex-plugin/plugin.json` 為第一形狀範本),加上 `skills: "./skills/"`,與 Claude 結構**共用同一個 `skills/`**。
6. **runtime 沿用既有 `cc-companion.mjs`,本期零改動。** 它隨 plugin payload 一起裝(純 ESM 零依賴),skill 指引 codex `spawn cc-companion task --prompt-file ... --json` 前景同步拿結果。**不用** npm 包、不編譯、不 MCP、不裝 hook。
7. **codex 原生支援第三方 marketplace 的 `.codex-plugin` skills(已實證,不再是阻塞未決)。** 本機 `~/.codex/plugins/cache/` 下 `superpowers`/`github`/`notion`/`canva`/`figma` 全是 `.codex-plugin/plugin.json` + `skills: "./skills/"` + `skills/<name>/SKILL.md` 的原生佈局;codex CLI 有一級 `codex plugin add` / `codex plugin marketplace add` 子命令,`config.toml` 用 `[plugins."<name>@<marketplace>"] enabled = true` 註冊。claude-mem 走 `npx ... skills add` 是它**自己的**選擇,不代表 codex 不支援原生路。
8. **路徑解析:多候選 fallback,但 marketplace 段不可寫死。** 已實證 codex cache 佈局為 `~/.codex/plugins/cache/<marketplace-id>/<plugin-name>/<version-or-hash>/`,其中 `<marketplace-id>` 由使用者 `codex plugin marketplace add` 時**自取**(本機實例為 `openai-curated`),resolver 無從預知,必須 glob。payload 為**平鋪**(`scripts/`、`skills/`、`.codex-plugin/` 直接在版本目錄下,**無** claude-mem 那種 `plugin/` 包一層)。
9. **遞迴守衛天然放行(已實證)。** `cc-companion.mjs` 在 `runCompanion` 開頭 `if (env.CLAUDE_CC_ACTIVE === "1") return 0`(L91);codex **不設**這個 env → 放行。cc 對它 spawn 的 `claude` 子程序才注入 `CLAUDE_CC_ACTIVE=1`(經 `buildEngineEnv`,worker.mjs L122-126,marker = adapter `RECURSION_MARKER`),擋住「claude 再叫 cc」的真遞迴。
10. **模型/設定不靠 flag。** 沿用 Phase 1 的單一 profile auto-select(免 `--profile`),其餘指示寫在 prompt 裡。skill 不帶「如何替 claude 組 prompt」的方法論(claude 不像 GPT-5.5 需要官方 prompting guide);只把「每個動作怎麼用」寫清楚。

## Assumptions

- **A1(已實證,非待驗證)**:codex 第三方 plugin 的 cache 佈局是 `~/.codex/plugins/cache/<marketplace-id>/<plugin-name>/<version-or-hash>/`。`<marketplace-id>` 由使用者命名(實例:`openai-curated`、`openai-curated-remote`),`<plugin-name>` 為 plugin 名(`cc`),版本段為 semver(`5.1.3`)或 hash(`202e9242`)。payload 平鋪,`.codex-plugin/`、`skills/`、`scripts/` 直接在版本目錄下。
- **A2(已實證,非待驗證)**:codex 原生讀第三方 marketplace 的 `.codex-plugin/plugin.json` 並把 `skills: "./skills/"` 註冊為可觸發 skill(見 Understanding #7)。本機 `superpowers` 等即為先例。本期不需做 installer。
- **A3**:`skills/` 由兩個 manifest 共用,skill body 是 engine-neutral 的操作說明(不含 Claude-only 語法),對 Claude 與 codex 兩宿主都成立。
- **A4**:本期 handoff 是**前景同步**(`cc-companion task` 預設前景,跑完才回);本期 skill **完全不提**背景路徑(`--background`/輪詢留 Phase 3b)。
- **A5**:開 feature 分支(AGENTS.md 規定),不直接 commit main;全程 `npm test` + 一次 codex→cc 真實 smoke 當驗證閘。
- **A6(修訂)**:cc 既有 `commands/`、`scripts/` payload **零改動**;`.claude-plugin/plugin.json` **僅** `version` 欄由 `0.3.0` bump 到 `0.4.0`(其餘三欄不動),這只算版本同步、不算改 Claude 行為。`skills/` 為**新增目錄**。**待驗證 A6a**:Claude Code 宿主如何發現 plugin 根的 `skills/`——是自動掃描,還是需在 `.claude-plugin/plugin.json` 宣告 `skills` 鍵?本期**不**在 `.claude-plugin/` 加 `skills` 鍵(維持 A6「除 version 外不動」);若真 Claude smoke 顯示需要宣告,記為後續 item,不在本期動。**本期 skill 的目標宿主是 codex**;對 Claude 宿主,既有 `/cc:*` command 路徑完全不變,skill 是否被 Claude 自動發現不影響本期交付。
- **A7**:cc spawn 的 `claude` 工作 cwd 需是「使用者要操作的專案目錄」,故 skill 必須在 codex 工具呼叫裡以正確 cwd spawn cc-companion(見 §4 與 Q-cwd)。

## Decision Log

| 決策 | 選擇 | 替代 | 理由 |
|---|---|---|---|
| handoff 方向 | codex(host)→ cc(worker) | 維持單向(只有 Claude→codex) | 方向對稱補完;使用者在 codex 最外層時也要能借 Claude 引擎 |
| 觸發 | **明確指派**(寫在 prompt) | codex AI 自動判斷外包 | 不可預測的自動外包風險高;明確指派可控、可測、YAGNI |
| 形態 | **skill** | 在 cc 加新 command | **codex 宿主無 `/plugin:command` 觸發面;skill 是 codex 唯一能被指引/原生註冊的形態**(理由非「對稱 codex:handoff」——後者是 command) |
| 既有 `/cc:*` command | **完全不動** | 改寫成 skill | 改寫無收益且增風險;只做方向補完 |
| 雙宿主形狀範本 | **同 repo 的 `plugins/antigravity/.codex-plugin/plugin.json`**(精簡:name/version/description/author/license),加唯一功能性欄位 `skills: "./skills/"` | 抄 claude-mem(帶 mcpServers/hooks/巨大 interface) | 同 repo 已驗證可共存;claude-mem 重型欄位本期用不到 |
| `interface{}` 商店卡 | **不放**(YAGNI) | 比照 superpowers/github 帶整塊 | antigravity 的 codex manifest 無 interface 也成立 → 非必要;Q-interface 待 codex 安裝若報缺再加最小集 |
| runtime | 沿用 `cc-companion.mjs`,**本期零改動** | npm 包 / 編譯 binary / MCP server / hook | 三個參考 repo 中我們最輕;task 已同步可用 |
| handoff 呼叫 | `cc-companion task --prompt-file <abs> --json`(前景同步) | `--background` + 輪詢 | 同步最直接、一次 codex 工具呼叫拿回結果;背景留 Phase 3b,本期 skill 完全不提 |
| 路徑解析 | resolver 純函式 + glob marketplace 段,以 marker 檔命中 | 寫死 `<owner>` / 只靠 env | marketplace 段由使用者命名不可預知;平鋪佈局 |
| resolver 落點 | **獨立模組** `scripts/lib/resolve-companion.mjs`(可注入 fs/env);SKILL.md 引用它、不內嵌邏輯副本 | 把 resolver 邏輯內嵌成 SKILL.md 裡的 `node -e` 字串 | 內嵌字串不可單元測且是第二處漂移源;獨立模組才能被 Layer0 斷言 |
| 模型/設定 | 不加 flag,靠單一 profile auto-select + prompt | 加 `--profile`/`--model` flag | Phase 1 已讓單一 profile 免 flag;codex 端帶 flag 反而是負擔 |
| skill 智慧 | **輕版**:只寫「每個動作怎麼用」 | 帶完整 claude prompting 方法論 | claude 不像 GPT-5.5 需官方 prompting guide;方法論是噪音 |
| 遞迴守衛 | 不在 codex 設 cc 的 marker(天然放行,已實證) | 在 codex 加 cross-engine guard | Phase 1 已確認 codex→cc 不被擋;cc 仍擋 claude→cc 的真遞迴 |
| skill 定名 | **`cc-handoff`**(本 spec 直接拍板做為 plan 基準) | 留 TBD / `hand-to-claude` | skill name 是測試斷言/目錄/觸發語硬依賴,寫 plan 前必須釘死;Q3 僅留 description 觸發語精確措辭待調 |
| **Q1 證否時的 fallback(待決決策,以 smoke 結果二擇一)** | **(B)既已實證 codex 原生註冊,主路徑走原生** | (A)README 記錄手動 `skills add` | 證據(#7)強烈支持原生路;若真 smoke 意外證否,退路是 README 記錄手動安裝步驟 + skill 純靠 prompt 內指引,**不做 installer** |
| `--read-only` 語意 | 在 skill 文案精確描述為「改用 claude 預設權限模式(`permissionMode: default`),**非** bypass」,不承諾「禁寫」 | 文案寫「唯讀/只看不改」 | 已查 cc-companion.mjs:214,`--read-only` 只把 `permissionMode` 設為 `"default"`,headless 下是否真禁寫待驗證(見 Q-readonly) |

## 設計細節

### 1. 雙宿主 manifest(`plugins/cc/.codex-plugin/plugin.json`)

新增一份 codex 宿主 manifest,**形狀以同 repo 既有的 `plugins/antigravity/.codex-plugin/plugin.json` 為第一範本**(精簡欄位集),加上唯一功能性新增欄位 `skills`。既有 `.claude-plugin/plugin.json` **僅 version bump**(見 A6)。

```jsonc
{
  "name": "cc",
  "version": "0.4.0",
  "description": "Run tasks on a headless Claude Code instance, selected by profile (native Claude, a cheap endpoint, or any model)",
  "author": { "name": "audichuang" },
  "license": "MIT",
  "skills": "./skills/"
}
```

- **不放** `interface{}`(YAGNI):同 repo 的 antigravity codex manifest 無 `interface` 也作為合法 codex manifest 存在;superpowers/github 帶 `interface` 是它們選擇做商店展示卡,非 codex 必要。若 **Q-interface**(codex 安裝時是否要求/是否影響 skill 觸發)在真 smoke 證實需要,再補**最小集**(僅 `displayName` + `shortDescription`),且不進一致性斷言。
- **不放** `mcpServers`/`hooks`(決策:本期不走 MCP、不裝 hook)。
- `author`/`license`:比照 antigravity 先例帶上(已知合法形狀);`keywords`/`homepage` 可選,起草 plan 時按 codex 安裝報錯與否決定。
- **single-source 風險**:`name`/`version` 兩欄在兩份 manifest + marketplace 重複。CI 需新增一致性斷言(見 §5),**僅斷 name/version**,description 允許三處措辭不同(避免與 §6 文案微調衝突)。

### 2. handoff skill(`plugins/cc/skills/cc-handoff/SKILL.md`)

skill 定名 **`cc-handoff`**(本 spec 拍板,做為 plan/測試基準;改名要同步:目錄 `skills/cc-handoff/`、frontmatter `name`、Layer0 步驟2 斷言)。命名風格對齊 codex 既有 skill 的中性 kebab-case(`codex-cli-runtime` 等)。**輕版**——只寫操作,不寫 claude prompting 方法論。

**frontmatter**
- `name`: `cc-handoff`
- `description`: 必須含三要素(Q3 收斂判據):(a)**方向性**——「hand a subtask FROM a Codex host TO a headless Claude Code (cc) worker and return the result」;(b)**明確指派觸發語**——「hand this to Claude / run this with cc / delegate to Claude Code worker / 交給 Claude 跑」;(c)**界線**——「only when the user explicitly assigns a subtask to Claude; not automatic offloading」。Layer0 步驟2 斷言一組釘死的關鍵字 regex(至少含 `claude` 與 `hand|delegate` 與 `subtask`)。

**body 綱要(操作步驟,具體到可寫 plan)**

1. **何時用**:使用者在 prompt 裡**明確指派**某段給 Claude 時。非明確指派不要自行外包。
2. **第 0 步——定位 `cc-companion.mjs`**:呼叫 §3 的 resolver(skill body 提供一段「原樣貼進 codex Bash 工具去跑」的可執行片段,印出命中的絕對路徑);找不到 → 明確報「cc plugin 未安裝或 cc-companion 不在預期路徑」並停,不要猜。
3. **第 1 步——備妥 prompt(temp file 為主路徑,傳絕對路徑)**:把要交給 claude 的子任務寫成**完整、自足**的指令(檔案、約束、完成定義都講清楚),寫進 temp file(`mktemp` 回絕對路徑)用 `--prompt-file "<絕對路徑>"` 傳。**必須傳絕對路徑**——因 cc-companion 對 `--prompt-file` 走 `path.resolve(cwd, ...)`(cc-companion.mjs:308),相對路徑會受 codex 宿主 cwd 影響(見 §4 / Q-cwd)。temp file 寫入在 codex 宿主的可行性(`mktemp` 是否放行、temp 目錄位置)列為 **Q-temp 待驗證**;若 codex 宿主不放行 `mktemp`,退路是用位置參數 prompt(`cc-companion task "<prompt>"`,cc-companion.mjs:313 支援)。
4. **第 2 步——同步 spawn(以正確 cwd)**:
   ```
   node "<RESOLVED_CC>/cc-companion.mjs" task --prompt-file "<TMPFILE_ABS>" --json
   ```
   - **cwd**:spawn 時 cwd 應為使用者要操作的專案根(讓 cc task 的檔案操作落在對的目錄),不是 temp 目錄(A7 / Q-cwd)。
   - 不帶 `--profile`(單一 profile auto-select;見 §4)。
   - 權限:**預設 `bypassPermissions`(可寫)**。明確指派的子任務通常要寫檔 → 用預設。只在使用者要求「不要用 bypass 權限」時加 `--read-only`(語意見 §4:轉 `permissionMode: default`,**非**保證禁寫)。
   - **本期不提背景**(A4)。
5. **第 3 步——讀回結果(先讀 stdout JSON,不靠 exit code 短路)**:
   - **無論 exit code,先解析 stdout 那一行 JSON**(§4 契約是 single-line),取 `status`/`resultText`/`error`/`errorKind`。`exit 1` 不代表沒有可讀結果(foreground 失敗仍輸出一行 projection)。**不要**用 shell `&&` 串接或拿 exit code 短路而丟掉 JSON。
   - 分支(偽碼,讓「每個動作怎麼用」具體):
     ```
     out = spawn(node, [CC, "task", "--prompt-file", TMP, "--json"], {cwd: PROJECT_ROOT})
     line = first non-empty stdout line
     若 line 不是合法 JSON(例如前置 "cc: ..." profile 錯誤):
         → 屬「前置 ProfileError」:指引使用者設 CC_DEFAULT_PROFILE 或跑
           `node "<CC>" setup`(自動建 native profile);可安全重試
     j = JSON.parse(line)
     若 j.status == "completed":
         → 把 j.resultText 帶回 codex 繼續
     否則(task 已執行但非 completed):
         → 把 j.error / j.errorKind 回報使用者;**不要**換 profile 重跑
           (失敗 job 可能已有 side effect,對齊 task.md no-failover 規則)
     ```
   - **兩種失敗要分清**(對齊 task.md 兩段式):(a)**前置 ProfileError**(0 或 2+ profile;stdout 是 `cc: ...` 非 JSON,根本沒跑 claude)→ 指引設 `CC_DEFAULT_PROFILE` 或跑 setup,**可安全重試**;(b)**task 已執行但非 completed** → 套 no-failover,不換 profile 重跑。
6. **delegated write 警語**:cc 預設 `bypassPermissions` → codex 一句指派就能讓 headless claude **無二次確認**改使用者工作區檔案。skill **必須在回報中明列 claude 改了哪些檔**(可從 resultText/log 摘要),讓使用者知道發生了什麼(緩解見風險 R7)。
7. **清理**:跑完刪 temp prompt file。

> skill body **不含**:如何替 claude 寫 prompt 的方法論、profile 怎麼建的細節(那是 setup 的事,skill 只在「找不到/0/2+ profile」時指引使用者跑 `node "<CC>" setup` 或設 `CC_DEFAULT_PROFILE`——**不**引用 Claude-only 的 `/cc:setup`,因 codex 宿主沒有 slash command)。
> skill body 是給 codex(GPT-5.5)讀的**操作手冊**,本身不可執行;真正會被執行的是它指引 codex 去跑的 resolver 片段與 cc-companion 呼叫。

### 3. 路徑解析 resolver(獨立模組,可單元測)

resolver **落為獨立模組** `plugins/cc/scripts/lib/resolve-companion.mjs`,export 可注入 seam 的純函式,SKILL.md 只**引用/呼叫**它(skill body 提供一段「原樣貼到 codex Bash 工具」的 `node -e` 片段去 import 並 print 結果),**不**內嵌一份邏輯副本(避免漂移、可被測)。

**介面契約(精確到可寫測試)**:
```
export function resolveCompanion({
  env,            // 物件,預設 process.env
  homedir,        // string,預設 os.homedir()
  existsSync,     // fn(path)->bool,預設 fs.existsSync
  readdirSync,    // fn(path,{withFileTypes})->Dirent[],預設 fs.readdirSync
  statSync,       // fn(path)->Stats,預設 fs.statSync(取 mtimeMs 排序)
}): string        // 回傳命中根下的 cc-companion.mjs 絕對路徑
                   // 全數落空 → throw CompanionNotFoundError(具名,訊息含掃過的候選根)
```

**候選順序**(第一個含 `scripts/cc-companion.mjs` 的勝出):

1. **env**:`env.CLAUDE_PLUGIN_ROOT || env.PLUGIN_ROOT`(宿主可能注入的 plugin 根)。
   - **待驗證 Q-env**:codex 在 skill 執行的 shell 裡實際注入哪個 plugin-root 變數名未證實(claude-mem 的 codex-hooks 讀 `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT`,但那是 hook 情境;skill body 由 GPT-5.5 在工具呼叫裡跑,該 env 是否在那個 shell 存在待 smoke 確認)。故 env 候選**不當定論**,只當第一順位嘗試;失敗就走候選 2。
2. **codex cache(glob,marketplace 段不寫死)**:對 `~/.codex/plugins/cache/` 下**每個** entry `M`(marketplace-id),檢查 `M/cc/` 是否為目錄;若存在,列出 `M/cc/` 下**所有**子目錄(**不**用 `^[0-9]` 過濾——版本目錄可能是 hash `202e9242` 或 semver `0.1.5`,純 hash 若首字母非數字會被 `[0-9]*` 漏掉),按 `mtimeMs` 由新到舊排序,逐一當候選根 `R`。
3. **claude cache(同機若也經 Claude 裝過 cc 的退路)**:`~/.claude/plugins/cache/` 下同樣演算法(glob marketplace 段 → `*/cc/*` → mtime 排序)。
4. **marker 判定**:對每個候選根 `R`,**只**判 `R/scripts/cc-companion.mjs` 是否存在(本 repo payload **平鋪**,無 claude-mem 式 `plugin/` 包一層 → **不**做 `R/plugin/scripts/...` 雙段判斷,那是 cargo-cult)。命中即回傳該絕對路徑。
5. **去重 / 跨層優先序**:候選 1(env)> 候選 2(codex)> 候選 3(claude);同一層內多命中按 mtime 最新優先(對齊 claude-mem `ls -dt`)。全數落空 → throw 具名錯誤,**不** silent fallback、不臆造路徑。

**安全**:resolver 只讀目錄、判存在,不執行任意路徑;最終 spawn 的是命中根下的 `cc-companion.mjs`(用 `process.execPath` 跑 node,絕對路徑),不從 PATH 找。

**env 生命週期釐清(防誤解)**:resolver 在 **codex 工具呼叫的 shell** 裡跑,讀 host env(含 `CLAUDE_PLUGIN_ROOT` 若有);這與 **cc-companion 之後 spawn claude 時**的 env 是**兩個不同階段**——後者經 `buildEngineEnv`,`DENY_PREFIXES = ["ANTHROPIC_","CLAUDE_","CLAUDECODE"]`(env.mjs:5)會把 `CLAUDE_*` strip 掉。故 `CLAUDE_PLUGIN_ROOT` **不會**一路傳進 worker;它只在 resolver-time 有用。cc-companion 自身的 dataRoot 由 `CC_PLUGIN_DATA → CLAUDE_PLUGIN_DATA → ~/.claude/plugins/data/cc`(adapter.mjs:12)決定,與 resolver 用的變數**無關**。

### 4. cc-companion 呼叫契約(已實證,本期零改動)

skill 依賴的是 `cc-companion task` 的**現有**行為(讀自 `plugins/cc/scripts/cc-companion.mjs`),本期 **runtime 嚴格零改動**:

- **同步前景**:`task`(不帶 `--background`)`await runWorker(...)` 跑完才回(cc-companion.mjs:281-300)——正是 handoff 要的「spawn → 拿回結果繼續」。
- **`--json` 輸出**:**單一行** JSON(cc 特性),shape = `resultProjection`(cc-companion.mjs:74-86):
  ```json
  {"engine":"cc","jobId":"...","status":"completed","resultText":"...","sessionId":"...","exitCode":0,"error":null,"errorKind":null,"durationMs":1234}
  ```
- **exit code**:foreground `task` 在 `status==="completed"` 回 `0`,否則 `1`(cc-companion.mjs:300)。**但失敗時 stdout 仍輸出一行 projection** → skill 必須先讀 JSON 再依 `status` 判斷(§2 step 5)。
- **profile auto-select**:不帶 `--profile` 時,恰好一個 profile → auto-select;0 或 2+ → 拋 `ProfileError`,以 `cc: ...` 輸出、exit 1(cc-companion.mjs:120-123)。
  - **codex 端前置依賴(關鍵)**:profiles 目錄由 dataRoot 決定。codex 宿主下使用者**大概率沒跑過** `/cc:setup`(那是 Claude-only slash command),故 `~/.claude/plugins/data/cc/profiles/` 可能為**空** → 0 profile → 報錯而非 auto-select。skill 收到「0 profile」錯誤時,應指引使用者跑 `node "<RESOLVED_CC>/cc-companion.mjs" setup`(會自動建 native profile,cc-companion.mjs:140-154),**而非**引用 `/cc:setup`。這讓 auto-select 在 codex 端真正開箱即用。多 profile(2+)時 codex 宿主**無互動選擇面**(task.md 的 `AskUserQuestion` 在 codex 不存在)→ 指引使用者設 `CC_DEFAULT_PROFILE`(風險 R-profile)。
- **權限**:預設 `bypassPermissions`(可寫);`--read-only` → `permissionMode: "default"`(cc-companion.mjs:214)。**注意**:`"default"` 是 claude 的正常權限詢問模式,**不是**硬性「禁寫」;headless(`-p --output-format stream-json`,adapter.mjs:32)下對寫操作的實際行為(自動拒?卡住?)列為 **Q-readonly 待驗證**。skill 文案因此用「改用 claude 預設權限模式,非 bypass」,**不**承諾「只看不改」。
- **prompt 來源**:`--prompt-file <path>`(`path.resolve(cwd, ...)`,相對 cc-companion 進程 cwd 解析,cc-companion.mjs:308)或位置參數(cc-companion.mjs:313)。skill 用 `--prompt-file` **傳絕對路徑**(§2 step 3)。
- **遞迴守衛**:`runCompanion` 開頭 `if (env.CLAUDE_CC_ACTIVE === "1") return 0`(cc-companion.mjs:91-94)。codex 不設此 env → 放行。cc spawn 的 `claude` 子程序才被注入 `CLAUDE_CC_ACTIVE=1`——經 `buildEngineEnv(recursionMarker: adapter.recursionMarker)`(worker.mjs:122-126),`adapter.recursionMarker = RECURSION_MARKER = "CLAUDE_CC_ACTIVE"`(adapter.mjs:9,45)。**(已讀檔坐實,非推測)**

> **本期 runtime 嚴格零改動。** 若真實 codex→cc smoke 暴露 codex 注入的 env 污染 cc 解析(R-env),**本期只觀察、記錄,不改 cc-companion**;修法另開 Phase 的獨立 item。不在本期替「改 runtime」開後門。

### 5. 安裝流程與一致性

- **payload 形狀(裝進使用者機器的就是 `plugins/cc/`,平鋪)**:
  ```
  plugins/cc/
    .claude-plugin/plugin.json     (既有 — 僅 version bump 0.3.0→0.4.0;Claude 宿主入口)
    .codex-plugin/plugin.json      (新增 — codex 宿主入口,§1)
    commands/*.md                  (既有,不動 — Claude 宿主 /cc:* )
    skills/cc-handoff/SKILL.md      (新增 — 兩宿主共用,§2)
    scripts/cc-companion.mjs        (既有,不動 — runtime,兩宿主共用)
    scripts/lib/resolve-companion.mjs  (新增 — resolver 純函式,§3)
    scripts/lib/...                 (既有,不動)
  ```
- **Claude 宿主**:只看 `.claude-plugin/` + `commands/` + `scripts/`;`skills/` 對 Claude 的可見性見 A6a(待驗證,不影響本期 codex 交付)。既有 `/cc:*` command 路徑完全不變。
- **codex 宿主(已實證的原生安裝路,使用者操作)**:
  1. `codex plugin marketplace add <repo-url-or-local-path>`(命名一個 marketplace,`<marketplace-id>` 由此產生)。
  2. `codex plugin add cc@<marketplace-id>`。
  3. 確認 `~/.codex/config.toml` 出現 `[plugins."cc@<marketplace-id>"] enabled = true`。
  4. codex 即把 `.codex-plugin/skills/` 載入為可觸發 skill(原生,見 #7)。
  > 此安裝路是**使用者操作 + 驗證觀察項**,**不屬本期交付**(本期不做 installer)。Layer2 step7 的 smoke 沿此步驟跑。
- **CI 一致性(作用域只限 cc)**:見 §測試策略 Layer0 步驟1。**斷言只比對 `name`/`version` 三方(.codex-plugin ↔ .claude-plugin ↔ marketplace cc 條目)一致**;`description` 只斷「.codex-plugin 解析成功且非空」,**不**要求三處逐字相同(容許 §6 marketplace 文案微調)。另斷 `.codex-plugin.skills === "./skills/"` 且 `skills/cc-handoff/SKILL.md` 存在。

### 6. 版本 / marketplace

- cc `version`:`0.3.0` → **`0.4.0`**(雙宿主能力 additive,minor bump)。**三處同步**:`.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`(僅此欄改,見 A6)、`marketplace.json` cc 條目。
  - **既有測試會連動**:`tests/cc/plugin-structure.test.mjs:72`(`entry.version === plugin.version`)與 `tests/fleet-structure.test.mjs:21`(marketplace↔.claude-plugin version)——三處不同步則 `npm test` 紅。plan 必須同步這三處。
- `marketplace.json`:cc 條目 version 同步 `0.4.0`;description **可**微調為「…可被 Claude Code 或 Codex 宿主指派子任務」(因一致性斷言只比對 name/version,此微調不破斷言)。
- `README.md`:新增「codex→cc handoff」一節(安裝命令、明確指派用法、resolver 行為、同步契約、delegated-write 警語)。**只新增 cc 自己的段落,不得編輯既有 codex/antigravity 段落或其安裝說明。**

## 不可動的邊界(防誤殺,IRONCLAD)

- **絕不碰** `plugins/{codex,antigravity}/` 與 `tests/{codex,antigravity}/` 的任何檔案(讀來對照合法,修改不可)。
- **可動清單**(本期會碰):
  - `plugins/cc/.codex-plugin/plugin.json`(新增)
  - `plugins/cc/skills/cc-handoff/SKILL.md`(新增)
  - `plugins/cc/scripts/lib/resolve-companion.mjs`(新增 — resolver 純函式)
  - `plugins/cc/.claude-plugin/plugin.json`(**僅 version 欄** 0.3.0→0.4.0)
  - `tests/cc/*`(新增 resolver / manifest / skill 靜態測試;cc 是 working plugin)
  - `tests/fleet-structure.test.mjs`(IRONCLAD 明文允許;新增斷言**只**針對 cc 條目,**不**寫成對所有 plugin 的通用迴圈——否則會把 codex(無 .codex-plugin)/antigravity 拖進約束)
  - `.claude-plugin/marketplace.json`(**只**改 cc 條目的 version/description 兩個 key)
  - `README.md`(只新增 cc 的 codex→cc 段)
  - `package.json`(沿用既有 `test:cc`,通常不必新增)
- **不替換/不重寫**:既有 `plugins/cc/commands/*.md`、既有 `cc-companion.mjs` runtime(本期零改動,R-env 只觀察不修)。
- **codex 不設 cc marker**:這是「特意不做」的設計(決策),不要在 codex 側加任何 guard。

## 測試策略(對齊 `.claude/skills/e2e-testing` 的兩層模型)

> **本期新功能的自動化驗收重心在 Layer 0**(resolver 純函式 + manifest/skill 靜態檢查)。Layer 1 是**既有契約的回歸護欄**,不冒充新驗收。codex 整合的端到端只能靠 Layer 2 真 smoke。報告時誠實標明哪層、fake 還是 live。

### Layer 0 — 靜態/單元(hermetic,進 `npm test`)— **本期主驗收**

1. **manifest 一致性(只限 cc,放 `tests/cc/plugin-structure.test.mjs`)**:
   - `.codex-plugin/plugin.json` 解析成功、必填欄位齊。
   - `name`/`version` 三方一致(.codex-plugin ↔ .claude-plugin ↔ marketplace cc 條目)。
   - `.codex-plugin.skills === "./skills/"` 且 `skills/cc-handoff/SKILL.md` 存在(打錯 skills 路徑 hermetic 測得出,不必等 smoke 才炸)。
   - **作用域分工**:`tests/fleet-structure.test.mjs` 既有迴圈仍只管 marketplace↔.claude-plugin(跨 plugin);cc 的 .codex-plugin 三方一致性寫成**只針對 cc 的獨立 case**(放 tests/cc/),不混進通用迴圈(IRONCLAD)。
2. **skill 存在性 + frontmatter(tests/cc/)**:`skills/cc-handoff/SKILL.md` 存在(路徑定值)、frontmatter 可被 YAML parse、有 `name`/`description`、`name === "cc-handoff"`、`description` 命中釘死關鍵字 regex(至少 `claude` + `hand|delegate` + `subtask`)。**skill body 品質(輕版/無方法論)靠 review 不靠自動測**——明說它無自動驗收標準。
3. **resolver 單元測試(tests/cc/,本期唯一新增 cc-side 邏輯,必須非空)**:測 `resolveCompanion({env,homedir,existsSync,readdirSync,statSync})` 純函式,用 fake fs 覆蓋:
   - **codex cache 佈局** fixture:`<home>/.codex/plugins/cache/<mkt>/cc/<ver>/scripts/cc-companion.mjs` → 命中且回傳該絕對路徑。
   - **claude cache 佈局** fixture:`<home>/.claude/plugins/cache/<mkt>/cc/<ver>/scripts/cc-companion.mjs` → 命中。
   - **候選優先序**:env > codex > claude(env 指向有效根時優先;env 指向無效根時 fallback 到 codex）。
   - **多命中按 mtime**:同層多個版本目錄 → 取 mtime 最新。
   - **hash 版本目錄**:版本段為 `202e9242` 之類也要命中(證明不靠 `^[0-9]` 過濾)。
   - **全落空** → throw 具名 `CompanionNotFoundError`,訊息含掃過的候選根。
   - **無 `plugin/` 雙段**:`R/plugin/scripts/cc-companion.mjs` 存在但 `R/scripts/...` 不存在時**不**命中(證明砍掉 cargo-cult 分支)。
4. **env 污染回歸(hermetic,放 tests/cc/,坐實 R-env 而非推給昂貴 smoke)**:用既有 `spawnSync + 自訂 env` 框架跑 cc-companion task,**故意注入** codex 可能設的雜訊 env(`PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` 指到別處),斷言:cc-companion 的 dataRoot 仍由 `CC_PLUGIN_DATA` 決定、profile 仍正確 auto-select、job 落在預期 dataRoot。證明 resolver 用的 env 與 cc-companion 用的 dataRoot env 互不污染。

### Layer 1 — hermetic E2E(`npm run test:e2e`,fake engine)— **回歸護欄,非新驗收**

5. **cc-companion 同步契約回歸(handoff 所依賴的下層契約;**明確標註不測 handoff 路徑本身**)**:此層 spawn `node cc-companion task --prompt-file f --json`,斷言單行 JSON、`engine:"cc"`、`status:"completed"`、`exitCode:0`。**這與既有 `tests/cc/e2e-cli.test.mjs`(L132/L246)重疊,屬 Phase 1 既有覆蓋**;本期不重複造輪,只在 plan 註明「依賴此契約不退化」。**不**把它包裝成「codex→cc handoff 驗證」(那是 vacuous claim:runtime 零改動,它在未做 Phase 2 的 code 上 100% 綠)。
6. **遞迴守衛(既有覆蓋,本期不重測)**:`CLAUDE_CC_ACTIVE=1` → 早退 exit 0 + `recursion guard` 訊息,已由 `e2e-cli.test.mjs:275-278` 逐字覆蓋。決策「codex 天然放行」本質**不可 hermetic 測**(測不到「一個沒寫的 guard 不存在」)→ 誠實寫:此為設計選擇,靠 Layer 2 觀察 codex 未被擋,無 hermetic 斷言。

### Layer 2 — real-engine smoke(手動閘,live)— codex 整合的唯一端到端裁決

7. **codex→cc 真實 smoke(本期關鍵手動驗證,可勾選清單)**:
   - **前置(使用者操作)**:`codex plugin marketplace add <repo>` → `codex plugin add cc@<marketplace>` → 確認 `config.toml` 出現 `[plugins."cc@<marketplace>"] enabled = true`。**漏這步 codex 不會載入 skill,smoke 必失敗且會被誤判成「codex 不支援」。**
   - **可勾選驗收(取代「觀察 codex 拿著結果繼續」這種無界敘述)**:
     1. resolver 在真 codex 下 print 出的命中路徑 == `~/.codex/plugins/cache/<marketplace>/cc/<ver>/scripts/cc-companion.mjs`(把實際 marketplace/ver 記成事實,坐實 A1)。
     2. `cc-companion task --json` 回傳的單行 JSON parse 後 `status == "completed"` 且 `exitCode == 0`。
     3. 記錄 codex 是**自動觸發 skill** 抑或需使用者手動指路徑(坐實 A2;二者皆記為事實,不留模糊)。
     4. 守衛放行:codex 未被擋(無 `recursion guard` 訊息)。
   - **若意外證否**(codex 未自動註冊 skill):記錄實際行為,走 Decision Log 的 fallback(B)——README 記錄手動步驟 + skill 純靠 prompt 指引,**不做 installer**。
8. **cc runtime 回歸 smoke(降為選配,非必跑)**:`.claude/skills/e2e-testing/scripts/real-engine-smoke.mjs` 的 cc 段——本期 runtime 零改動,它是回歸保護而非本期交付,**選配**跑以防意外回歸,不列為 ship 前置。

### prove-non-vacuity(對齊 e2e-testing)

- resolver 測試:暫時 revert resolver 的「marker 判定」一行 → 對應 case 必須紅。
- manifest 一致性測試:暫時讓 `.codex-plugin.version` 與 `.claude-plugin.version` 不同 → 斷言必須紅。
- skill 存在性測試:暫時把 `name` 改成非 `cc-handoff` → 斷言必須紅。
- 每條新測試在 plan 都附「revert 哪一行會讓它紅」。

## 風險與緩解

- **R1(降級為低)— codex 是否原生讀 `.codex-plugin` 並註冊 skill。** 已由本機 `superpowers`/`github` 等實證 codex 原生支援(#7)。剩餘風險僅「skill description 觸發語在 GPT-5.5 下能否被明確指派語觸發」——屬 prompt-engineering 風險,非安裝拓樸風險。緩解:Q3 收斂 description 三要素;Layer2 step7 觀察。
- **R-profile(原 minor 升為列管)— codex 宿主下 2+/0 profile 無互動選擇面。** task.md 的 `AskUserQuestion` 在 codex 不存在。0 profile → 指引跑 `node "<CC>" setup`(自動建 native);2+ profile → 指引設 `CC_DEFAULT_PROFILE`。skill description/body 點出「多 profile 時需先指定 `CC_DEFAULT_PROFILE`」。
- **R2 — manifest 漂移**:兩份 manifest + marketplace 重複 name/version。緩解:§5 CI 三方一致性斷言(只 name/version)。
- **R-env(原 R3,降為純觀察)— codex 注入 env 污染 cc 解析。** `DENY_PREFIXES` 已 strip 全部 `CLAUDE_*`/`ANTHROPIC_*`;`CC_*` 是顯式使用者自設,codex 不太可能注入。**已由 Layer0 步驟4 hermetic 覆蓋**(注入雜訊 env 斷言 dataRoot 不受污染)。real smoke 額外觀察 dataRoot 落點,但**不阻塞、不在本期改 runtime**。
- **R4 — marketplace 段不確定**:`<marketplace-id>` 由使用者命名。緩解:resolver glob `cache/*/cc/*` 以 marker 命中,**不寫死**;real smoke 坐實實際值(設計約束,非待驗證阻塞)。
- **R5 — 同步前景長任務**:大子任務同步等可能很久。本期接受(A4),skill **不提**背景退路(YAGNI;Phase 3b 再說)。
- **R6 — 誤殺 IRONCLAD**:雙宿主升級誘惑去「順手」改 codex/antigravity,或把一致性斷言寫成通用迴圈拖進 sibling。緩解:§「不可動的邊界」明列可動清單 + 斷言只限 cc;diff review 必查無 sibling 改動。
- **R7 — delegated write 無二次確認**:codex 一句指派 → cc `bypassPermissions` → headless claude 無聲改使用者工作區檔案(claude-mem 有 hook 攔截,本期無攔截)。緩解:skill **必須在回報中明列 claude 改了哪些檔**(§2 step6);文案明示預設可寫。是否引入確認機制留後續評估。
- **R-readonly — `--read-only` 非真禁寫**:`permissionMode: "default"` 在 headless 下對寫操作行為待驗證(Q-readonly)。緩解:skill 文案不承諾「禁寫」,只說「改用預設權限模式,非 bypass」。

## 未決問題

- **Q3(非阻塞,僅措辭)**:`cc-handoff` skill 的 description 觸發語**精確措辭**(name 已釘 `cc-handoff`)。判據已給(方向性 + 明確指派觸發語 + 界線三要素);brainstorm 收斂最終文案,確保不與 Claude 端 `codex:handoff` 在使用者心智/觸發語對撞。
- **Q-env(待 smoke)**:codex 在 skill 執行的 shell 裡實際注入哪個 plugin-root 變數名(`CLAUDE_PLUGIN_ROOT`? `PLUGIN_ROOT`? 都沒有?)。resolver 已設計成 env 候選失敗即 fallback 到 cache glob,故**非阻塞**。
- **Q-cwd(寫 plan 前釘死)**:skill spawn cc-companion 時的 cwd 應為使用者專案根(讓 cc task 檔案操作落對地方);codex 工具呼叫如何設定/取得該 cwd 需在 plan 明確。`--prompt-file` 一律傳絕對路徑以免受 cwd 影響(已定)。
- **Q-temp(待 smoke)**:codex 宿主是否放行 `mktemp`/temp file 寫入、temp 目錄位置。退路:用位置參數 prompt(cc-companion 支援)。
- **Q-readonly(待驗證)**:headless claude 在 `permissionMode: "default"` 下對寫操作的真實行為(自動拒/卡住/詢問)。決定 skill `--read-only` 文案能否更精確。
- **Q-interface(待 codex 安裝驗證)**:codex 安裝/顯示是否要求 `.codex-plugin` 帶 `interface{}`?antigravity 先例顯示非必要;若報缺再補最小集(displayName + shortDescription),不進一致性斷言。
- **Q-A6a(待 Claude smoke,不阻塞本期 codex 交付)**:Claude Code 宿主如何發現 plugin 根的 `skills/`(自動掃描 vs 需在 `.claude-plugin` 宣告 `skills` 鍵)。本期不在 `.claude-plugin` 加鍵;若需要記為後續 item。
- **Q5(已自答,移出未決)**:fleet(setup/doctor)是否反映 cc 雙宿主 → **不做(YAGNI)**;fleet 對 cc 的 runtime 健檢不受雙宿主影響。

## 後續(Phase 預告,不在本期)

- **Phase 3a — codex AI 自動判斷外包**:codex 自行判斷哪段適合交給 Claude(非明確指派)。需更強策略與守衛,風險獨立,單獨 brainstorm。
- **Phase 3b — codex 側背景編排**:`--background` + `status`/`wait`/`result` 做非同步多 job 編排。本期 skill 完全不提背景,留此期。
- **(一句帶過)engine plugin 多宿主化範式**:antigravity/codex 遷移 shared/lib 後,雙宿主拓樸可成三引擎共同範式——遠期願景,與本期無關。

---

## v2 修訂(吸收 codex 驗證閘 + orca 環境探針,2026-06-20)

> 本節 **override 上文對應段落**。來源:① codex handoff 驗證閘判 *not ready*,列 6 blocker;② 在本機 orca codex 上跑的環境探針(headless codex via codex-companion)實測。

### 環境事實(探針坐實,取代先前路徑推測)
- codex(orca)執行 shell 時:**cwd = 專案根**;**無** `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT`;`CODEX_HOME=~/.config/orca/codex-runtime-home/home`;plugin 真實落點 `$CODEX_HOME/.tmp/plugins/plugins/<name>`;**`CLAUDE_PLUGIN_DATA` 已被設成 codex 的 data 目錄**;**plugin `bin/` 會進 PATH**。
- **侷限**:此探針是 Claude Code 經 codex-companion spawn 的 *headless* codex(env 帶 `CLAUDECODE=1`);**互動 codex 的 env 可能不同,A2 自動觸發仍待真 smoke**。

### V-1(解 #1 resolver 啟動循環 + #6 marker 太弱)— resolver 換錨
- **丟棄**原 §3 的「寫死 `~/.codex/plugins/cache` glob + `env.CLAUDE_PLUGIN_ROOT||PLUGIN_ROOT` 主錨」(探針證明 env 為空、路徑被 orca 重導)。
- **新主路徑:cc plugin 帶 `bin/cc-companion`**(launcher,裝後進 PATH);skill 直接 `command -v cc-companion` 命中即 `cc-companion task …` → **無 import、無 bootstrap 循環**(#1 消解)。
- **Fallback(PATH 無命中)**:skill 內一段**最小 inline bash bootstrap**(純 shell,不 import .mjs → 無循環),依序 glob `$CODEX_HOME` → `~/.codex` → `~/.claude` 下 `*/cc/*/scripts/cc-companion.mjs`,命中**必須驗相鄰 `.codex-plugin/plugin.json` 的 `name==="cc"`**(#6)。
- **可測性**:把 fallback 的純解析邏輯仍放 `scripts/lib/resolve-companion.mjs`(fake-fs 單元測;§3 介面契約保留,但**錨改為 `CODEX_HOME`/cache glob + manifest 驗證,移除 env 主錨地位**);skill 的 inline bootstrap 是其精簡版,靠 Layer2 smoke。
- **待驗證 Q-binpath(實作 smoke)**:codex plugin 的 `bin/` 是否真進 codex 的 PATH(本機 canva/github 是 MCP plugin、無 bin,未證 bin 機制)。若否,主路徑退回 inline bootstrap。

### V-2(解 #2 `CLAUDE_PLUGIN_DATA` 污染,探針證實「確定中」)
- cc-handoff skill 跑 cc-companion **必須顯式設** `CC_PLUGIN_DATA` —— 否則被環境裡指向 codex 的 `CLAUDE_PLUGIN_DATA` 拖走,cc 的 profile/state 錯位。
- 片段:`CC_PLUGIN_DATA="${CC_PLUGIN_DATA:-$HOME/.claude/plugins/data/cc}" cc-companion task …`
- **Layer0 測改寫**(取代原 step4 測 `PLUGIN_ROOT` 的 vacuous 測):注入錯誤 `CLAUDE_PLUGIN_DATA`,斷言「有 `CC_PLUGIN_DATA` 時 dataRoot/profile 仍落預期 root」。

### V-3(解 #5 Q-cwd — 探針已證 cwd=專案根)
- 釘死:skill spawn 前 `PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"`,在 `cd "$PROJECT_ROOT"` 下跑 cc-companion;`--prompt-file` 一律絕對路徑。**Q-cwd 移出未決(已解)**。

### V-4(解 #3 `--json` 失敗契約過強)
- §2 step5 / §4 改:**先試解析 stdout 首行 JSON projection;非 JSON 時依來源分類** —— stdout `cc: …` = Profile/Usage error(指引 `cc-companion setup` 或 `CC_DEFAULT_PROFILE`,可重試);stderr stack = runtime crash(回報、不重跑);exit code 僅輔判。**不再宣稱「所有失敗都有 single-line JSON」**。

### V-5(解 #4 delegated-write 緩解可落地)
- skill 在 task **前後**各跑 `git status --porcelain --untracked-files=all`,以兩次差異列出 claude 改了哪些檔並回報;非 git workspace 則**明示無法可靠列舉**,要求使用者明確接受可寫 handoff 或加 `--read-only`。(取代原「靠模型自述」。)

### V-6(A2 降為 smoke gate,解前後矛盾)
- A2 從「已實證可觸發」**降級**為:**安裝佈局已實證**(本機 `.codex-plugin`+`skills` cache 先例);但「第三方 marketplace 安裝後 `cc-handoff` 在對話中**自動觸發**」**未證,列為實作後 Layer2 真 smoke gate**。auto-trigger 未過 → 本期不算達成;README 手動 fallback 不冒充原目標。

### 未決問題更新
- **Q-cwd:已解**(V-3)。 **Q-env:已解方向**(無 plugin-root env → 改 PATH/`CODEX_HOME` 錨)。
- **新增 Q-binpath**:codex plugin `bin/` 是否進 codex PATH(決定 resolver 主路徑;實作 smoke 驗)。
- **A2**:保留為 Layer2 smoke gate(V-6)。

### plan 就緒度
codex 6 blocker 修法已定(V-1~V-6),Q-cwd/Q-env 已解,A2 與 Q-binpath 明確降為「**實作後 smoke 驗證步驟**」而非 plan 前 blocker。**spec 可進 implementation plan**。
