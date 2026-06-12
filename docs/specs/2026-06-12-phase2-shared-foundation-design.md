# agent-fleet-cc 第二階段設計規格 — 共享地基 + 指令對齊(機器層優先)

日期:2026-06-12
狀態:設計已逐段核准(brainstorming session),待使用者審閱本文件
關係:細化並部分修訂《2026-06-12-agent-fleet-merge-design.md》(下稱「藍圖」)§5–§6。
本文件 §11 取代藍圖 §11 的第二階段完成定義;藍圖 §10 非目標全部沿用,§12 另有擴充。
指令對齊的決策背景見《docs/notes/2026-06-12-command-alignment-matrix.md》(本階段將其更新為終局矩陣)。

## 1. 核心洞察:編排上移,動詞重定義

使用者的工作流已演進為 workflow 驅動:brainstorm → writing-plans 拆 task →
Claude Code 原生 Workflow 逐 task 執行(實作 agent 組 prompt 驅動外部引擎、
審查 agent 獨立重跑驗證、未過回灌修正最多 3 輪、過關才推進)。實證:使用者現役的
`plan-codex-opus` workflow,其中引擎只被一行呼叫——`codex-companion.mjs task
--prompt-file "$TMPFILE" --write`。

對指令設計的三個含義(本 spec 一切決策的根源):

1. **編排邏輯屬於協調層**(Workflow / Agent / 主 agent),不屬於引擎 plugin。
   把編排埋進指令的 execute-plan(fire-and-pray:整份 plan 交出去祈禱成功)
   已被使用者判定不成熟 → 淘汰。
2. **動詞 = 一次引擎呼叫的角色定義**(實作者 / 對抗審查者 / 救援者…)。
   組 prompt 的智慧在協調層;引擎 plugin 的職責是把「執行」做穩。
3. **對齊主戰場是機器層**(companion CLI),不是 slash 動詞。三引擎原子操作
   介面一致後,workflow 換引擎 = 換一個路徑變數,prompt 邏輯零修改。

```
┌─ 協調層(Claude Code 原生:Workflow / Agent / 主 agent)──────┐
│  編排、組 prompt、審查迴圈、修正回灌 — fleet 只交付 skill      │
├─ 人類層(slash commands)────────────────────────────────────┤
│  核心五動詞三引擎齊;角色型動詞保留不擴散;execute-plan 刪除   │
├─ 機器層(companion CLI)── 第二階段對齊主戰場 ────────────────┤
│  三引擎嚴格一致的原子操作;--json 輸出 = 統一 Job schema 投影  │
├─ 共享地基(shared/lib,藍圖 §5 既核准結構)──────────────────┤
│  core(job/state/reconcile/events)+ runtime + adapter + render │
└──────────────────────────────────────────────────────────────┘
```

機器層的一致性不是另寫的對齊層,而是共享地基的自然產物:統一 Job schema 落地後
`--json` 輸出三引擎同 schema 是免費的;ProcessAdapter 的 `resumeArgs(sessionId)`
合約讓 resume 統一成為可能。

## 2. 機器層統一 CLI 合約(核心交付物)

統一子指令:`task` / `wait` / `logs` / `status` / `result` / `cancel` / `setup`
(`wait` 與 `logs` 為本輪編排審閱新增,見 §2.3)。

### 2.1 task 旗標映射

| 旗標 | 語意 | codex 現況 | antigravity 現況 | delegate 現況 | 裁定 |
|---|---|---|---|---|---|
| `--prompt-file <path>` | 從檔案讀 prompt(workflow 必備) | ✓ | task ✗(僅 rescue 有) | ✗(positional only) | **三引擎 task 必支援** |
| `<prompt...>` positional | 短 prompt 直接給 | ✓ | ✓ | ✓ | 保留 |
| `--wait` / `--background` | 前景等結果 / 背景 job | ✓ | ✓(預設 bg) | 僅 `--background` | 統一兩旗標皆有;**預設 = 前景等待**(antigravity 改預設,版號註明) |
| `--json` | 結構化輸出 | ✓ | ✓ | ✗ | **三引擎必支援,schema 統一(§2.2)** |
| `--write` / `--read-only` | 權限 | `--write`(預設唯讀) | sandbox 機制 | env 預設 bypassPermissions | **旗標名統一、預設沿革各自保留**(改 delegate 預設會破壞跑腿用例;workflow 一律顯式傳) |
| `--resume-job <id>` / `--resume-last` | 以 job 為單位續跑 | thread 機制 | `--conversation <id>` | `--resume-id` / `--resume-last` | **統一 job 維度**:引擎從 job 的 `sessionId` 自組 resume 參數(= ProcessAdapter `resumeArgs` 合約)。delegate 的 `--resume-id` 改名 `--resume-job`;引擎原生 id 旗標(如 agy `--conversation`)保留為引擎特定 |
| `--model <id>` | 指定模型 | ✓ | ✓ | ✗ | **升級為三引擎一致**(delegate 補,透傳 `claude -p --model`;與 `--profile` 正交——profile 管 endpoint/key,model 管模型名) |
| 引擎特定 | | `--effort` | `--add-dir` | `--profile` `--settings` `--timeout-ms` | 保留,文件標明「特定」;不加引擎前綴(prompt 模板中本就置於引擎特定段) |

權限旗標的引擎映射:`--write` → delegate `bypassPermissions` / codex `--write` /
agy 無 sandbox;`--read-only` → delegate `--permission-mode default`(headless
下工具被拒,只能讀與回答)/ codex 預設 / agy `--sandbox`。

### 2.2 `--json` 輸出 schema(統一 Job schema 的投影)

```js
// launch 形態(--background 派發時):
{ engine, jobId, status: "queued" }
// result 形態(--wait 完成時 / result 指令):
{ engine, jobId, status, resultText, sessionId, exitCode, error, errorKind, durationMs }
```

最小保證欄位集;引擎可附加額外欄位(如 codex launch 的 `signalFile`),機器
消費者以最小集為準。`status` / `cancel` 的 `--json` 同樣輸出核心欄位投影(§3)。

### 2.3 wait 與 logs:編排 re-entry 動詞

Bash 工具單次上限 10 分鐘,大任務(Codex 級 review / 實作)經常超過;缺少事後
等待動詞時,編排者只能前景賭超時、或輪詢 status 燒 turn。新增兩個統一動詞
(實作在 shared core,各 companion 薄轉發,三引擎一致):

- `wait <jobId> [--timeout-s <n>] [--json]` — 阻塞到 job 終態或超時;阻塞期間
  把新增的 events 行透傳 stdout(進度心跳)。超時不是錯誤:輸出當前狀態後退出,
  exit code 區分(0 = 已終態、專用碼 = 仍在跑)。編排迴圈因此是乾淨 re-entry:
  `task --background` → `wait --timeout-s 540` → 未完就再 `wait`。
- `logs <jobId> [--follow]` — `events.ndjson` 的 tail 投影,`--follow` 跟隨至
  終態。codex 既有 `attach` 即其前身,保留為其特化(原生 stream),`logs` 為
  跨引擎統一動詞。

### 2.4 companion 穩定路徑 recipe

cache 路徑含版本號(`~/.claude/plugins/cache/agent-fleet/<plugin>/<ver>/`),
workflow hardcode 必隨升版斷裂。裁定:**不做 symlink**(plugin 更新不保證重跑
setup,symlink 必 stale),skill 與文件內建一行動態解析:

```bash
COMPANION=$(ls -d ~/.claude/plugins/cache/agent-fleet/<plugin>/*/scripts/<plugin>-companion.mjs | sort -V | tail -1)
```

(antigravity 的 companion 入口為 `scripts/commands/<cmd>.mjs` 多檔形態;移植時
統一補一個單一入口 `scripts/antigravity-companion.mjs` 轉發子指令,使三引擎的
解析 recipe 同形。)

### 2.5 delegate profile 選擇流程:不下沉

機器層必須無互動可腳本化(workflow 不能被 AskUserQuestion 卡住)。互動式選
profile 是人類層的事——delegate 0.1.1 的 command-md 層設計正確,維持原樣;
機器層僅靠 `--profile` / `DELEGATE_DEFAULT_PROFILE` 顯式指定。

## 3. 統一 Job schema

狀態機六態:`queued → running → completed | failed | cancelled | timed-out`。
(藍圖 §5.1 草案用 `created`,定稿改 `queued` —— delegate/antigravity 現役用詞,
搬遷成本最低;`timed-out` 收編 delegate 的獨立超時態。)

核心欄位(攤平;fleet 視圖與 `--json` 只讀這層):

```js
{
  id, engine,                 // engine: "codex" | "antigravity" | "delegate"
  status, createdAt, updatedAt,
  title,                      // 統一 agy 的 title 與 dlg 的 promptPreview
  cwd, pid, sessionId,        // sessionId = resume 根基(ProcessAdapter 合約)
  exitCode, error, errorKind, // exitCode 可為 null(session 型引擎無單一退出碼);
                              //   errorKind 收編 agy 的 healthStatus,
                              //   = classifyError 輸出('auth'|'not-installed'|'endpoint'|…)
  phase,                      // optional,收編 agy 的子階段標籤
  resultText, durationMs,
  model, usage,               // 成本遙測;usage = { inputTokens, outputTokens } | null
                              //   引擎報不齊就 null —— 這是模型路由決策(便宜端點
                              //   vs 貴模型)的數據基礎,現在加零成本,日後加要動三 adapter
  request: { ... }            // 引擎特定參數整包(profile/effort/addDirs…)
}
```

儲存佈局:**每 job 一個目錄** `jobs/<id>/`,含 `job.json` + `prompt.txt` +
`events.ndjson` + `log`(藍圖 §5.3 落實)。prune = 整目錄移除;CAS lock 檔與
unlink 順序的既有不變量(delegate `state.mjs` 的 lock-after-json 邏輯)隨之搬進
目錄。舊平鋪檔案不遷移——新 job 用新 schema,舊 job 隨 prune 自然淘汰(藍圖 §9
已核准)。

**證據鏈合約**:任何 reviewer job 只需 `jobId` 即可從 `jobs/<id>/` 重建全部證據
(prompt 原文、cwd、events、result、log)——互相監督的單位是 artifacts,不是
實作者的文字自述。搭配 `--resume-job`,「審查不過 → 帶 issues resume 同一
session 修正」的多輪迴圈是 schema 的副產品。

`events.ndjson` 事件型別最小集:`job-created` / `spawned` / `engine-event`
(引擎原始輸出進 `raw` 欄透傳)/ `result` / `finalized`(記錄誰寫的終態)。
狀態以 `job.json` 為唯一真相,events 是觀測脊椎(跨引擎 status、「最後活動」、
fleet 視圖的資料源)。

## 4. 人類層指令變更

終局矩陣(取代對齊矩陣文件中的「決策留待第二階段」):

| 指令 | codex | antigravity | delegate |
|---|:-:|:-:|:-:|
| task | **補** | ✓ | ✓ |
| status / result / cancel / setup | ✓ | ✓ | ✓ |
| review | ✓ | ✓ | ✗ |
| adversarial-review | ✓ | ✓ | ✗ |
| rescue | ✓ | ✓ | ✗ |
| handoff | ✓ | ✓ | ✗ |
| attach | ✓ | ✗ | ✗ |
| image | ✗ | ✓ | ✗ |
| ~~execute-plan~~ | **刪** | ✗ | **刪** |

原則:核心五動詞(task + 生命週期四指令)三引擎必齊、語意一致;角色型動詞
(review / adversarial-review / rescue / handoff)既有保留、**不擴散**(delegate
不補——要用任意模型做 review,就是協調層組 review prompt 打 `delegate task`);
能力型動詞(attach / image)依附引擎能力,照藍圖裁定不對齊。

變更清單(本階段全部指令面變更,共六項):

1. codex:**+ `task.md`**——薄轉發 companion 既有的 `task` 子指令(把 rescue
   穿的衣服脫掉);`rescue.md` 不動。
2. codex:**− `execute-plan.md`**。
3. delegate:**− `execute-plan.md` 與 companion `execute-plan` 子指令**(含
   `EXECUTE_PLAN_TEMPLATE`)——它就是 task + 模板薄包裝,workflow 模式下無存在理由。
4. antigravity:task 預設改前景等待(§2.1);`task.md` 同步改寫。
5. handoff 語意分岔文件化:codex handoff =「組 GPT-5.5 prompt 請 Codex review
   或做任務」、agy handoff =「寫交接文件請 agy 接手續做」——不改行為,README
   與矩陣文件標明差異。
6. `docs/notes/2026-06-12-command-alignment-matrix.md` 更新為終局矩陣 +
   execute-plan 淘汰理由(fire-and-pray 被 workflow 逐 task 模式取代)。

## 5. 共享地基落地(藍圖 §5 沿用 + 本次定稿)

藍圖既核准、不重開:shared/lib 結構(§5.1)、ProcessAdapter 合約(§5.2)、
conformance suite 七劇本(§5.4)、vendor + drift check(§5.5)、移植順序(§5.6)、
job 資料按 plugin 分目錄 + reconcile 雙保險(§5.7)。

本次定稿補充:

- **`git.mjs` / `prompt-templates.mjs` 留各 plugin 私有,shared/lib 不收。**
  delegate 不補 review 後,跨 plugin 共用需求消失;shared/lib 維持純 job-runtime
  範圍,不膨脹。
- **SessionAdapter 維持無限期延後**(藍圖 §5.6):codex 只移植 job-state 層;
  `--resume-job` 在 codex 的實作走既有 thread 機制查表,不碰 broker。
- **Adapter 形態無關不變量(現在寫死,防合約被隱含「一次性程序」假設綁架)**:
  無論 Process 或 Session 形態——(1) job 必達終態;(2) 事件必寫 events.ndjson;
  (3) cancel 必殺乾淨(process group);(4) result 必冪等;(5) `exitCode` 可為
  null。conformance suite 驗的是這五條;SessionAdapter 日後落地時不得要求重簽
  合約(若兩個 ProcessAdapter 驗證出的合約隱含 exitCode 必存在之類的假設,到
  codex 移植時就是 breaking change)。
- **防遞迴與 env 消毒上移 core**:`runtime/worker.mjs` 在 spawn 前對 adapter
  回傳的 env 強制套用 core 的 `sanitizeEnv()`(剝除自父環境繼承的 `CLAUDE_*` /
  `ANTHROPIC_*` 注入變數、設遞迴守衛標記),adapter 不可繞過;profile / adapter
  顯式提供的 env 在消毒後疊加(delegate「env 完全重建」邏輯的一般化)。
  「Claude Code 指揮 delegate 跑 claude -p」是主用例,遞迴炸彈是地基級風險,
  不是單引擎特性。
- **cancel 殺 process group**:`runtime/spawn.mjs` 以 `detached: true` 讓引擎
  child 自成 process group;cancel 與 timeout 的 kill 路徑一律 `kill(-pgid)`。
  引擎會帶起孫子程序(claude -p 的 MCP server 等),只殺 worker/child 會留下
  殭屍引擎繼續燒 API 錢。
- 統一 CLI 的參數解析進 shared(`shared/lib` 的 args 工具),三 companion 共用
  同一套旗標定義,杜絕再分岔。

## 6. fleet plugin 提前出生(0.1.0:只帶 skill)

藍圖將 fleet plugin 排在第三階段(status/cancel 指令)。本階段以最小形態提前
出生:**只含一個 skill、無 commands**;第三階段再加指令。

```
plugins/fleet/
├── .claude-plugin/plugin.json        # 0.1.0
└── skills/multi-engine-plan-execution/
    ├── SKILL.md                      # 方法論本體
    └── references/plan-fleet-example.workflow.mjs   # 完整可跑範例
```

SKILL.md 內容(使用者現役 `plan-codex-opus` 方法論的一般化):

1. **何時用**:有 superpowers 風格 plan(`### Task N` + checkbox steps)想跨引擎
   代工實作 + 獨立把關、全程自動推進時。
2. **引擎角色決策表**:寫手(codex = GPT 強模型 / antigravity = Gemini /
   delegate `--profile` = 任意 Anthropic-compatible 端點如 minimax)、審查者
   (opus 原生 agent / codex 對抗性審查)。**成本結構預設**(實戰驗證):driver
   用最便宜模型(haiku 級,只組 prompt + spawn CLI)、實作交外部引擎、把貴的
   花在審查上——審查品質決定整條鏈的下限。
3. **機器層合約速查**:companion 動態路徑解析(§2.3)、
   `task --prompt-file --wait --write --json` 用法、`--json` 輸出怎麼 parse。
4. **workflow 骨架**:逐 task → 實作(便宜 model agent 組 prompt 驅動引擎)→
   審查(獨立 agent 重跑 GATE、核對 plan 驗證指令、護欄抽查)→ 未過 issues
   回灌修正(amend)最多 3 輪 → 三輪不過斷鏈停止。
5. **把關設計原則**:GATE 指令、ironRules 鐵律、knownFail 白名單、baseline tag
   比對、「審查不信任實作者自述、證據先於斷言」。

skill 同時是機器層對齊的驗收場景:依 skill 生成的 workflow 中,換引擎只改
args(writer/reviewer 參數),prompt 組裝與呼叫行零修改——做不到即地基未對齊。

## 7. 測試策略

| 層 | 內容 |
|---|---|
| conformance suite(藍圖 §5.4 擴充) | **十劇本** × 兩個 ProcessAdapter(claude / agy),fake binary fixture——藍圖七種 + 本輪新增三種:超長輸出(數十 KB result 的 stream 與截斷)、auth 在 job 中途過期(classifyError 不只管啟動時)、cancel 後孫子程序必須死光(§5 process group) |
| **companion CLI 合約測試(本次新增)** | 同一套參數化測試跑三引擎:`--prompt-file` / `--json` schema 驗證 / `--wait` / `--background` / `--resume-job`——「指令對齊」的機器驗收 |
| 各引擎既有 hermetic 測試 | 每個 plugin 移植完跑自己整套,綠了才動下一個(既定鐵則) |
| structure 測試 | marketplace.json / plugin.json 完整性,涵蓋第 4 個 plugin(fleet) |
| drift check | vendor 同步,CI `git diff --exit-code`(藍圖 §5.5) |
| **core 競態對抗審查** | shared/lib core 落地後,安排專門的對抗 agent 構造「first-terminal-writer-wins 被違反」的劇本(cancel vs 自然完成、prune vs finalize、lock 寫入與 JSON 寫入間死亡)——構造成功即紅燈,修復後該劇本固化進 conformance |
| 真實冒煙(**人工關卡**) | 三引擎各一真實 job(deepseek profile / agy / codex)+ 依 skill 生成的 workflow 跑一個 2-task 迷你 plan;需要三家 auth 與真實端點,由使用者在場執行,不交給自動化編排 |

## 8. 移植順序(藍圖 §5.6 細化)

0. **Pre-flight(基線與環境,開工第一步)**:跑 `npm test` 重驗 641 全綠並記錄
   基線——若出現環境性失敗,釘 known-fail 白名單再開工,審查者以白名單為準,
   不把既有失敗誤判為新工作弄壞的。確認 node 版本(CI 押 Node 24 的 codex 上游
   不相容見 `.github/workflows/ci.yml` 註解;本機 /tmp 的 node 二進位重開機會
   消失)。探測三引擎 auth(codex 登入狀態 / agy auth / deepseek profile 存在性)
   ——失敗不擋開發步,只把 §7 人工關卡提前標紅。
1. shared/lib core 先行(純單測,零 I/O 假設)+ core 競態對抗審查(§7)。
2. **delegate**(地基母體):搬上 shared、CLI 合約補齊(`--prompt-file` /
   `--json` / `--wait` 顯式旗標 / `--model` / `--resume-id`→`--resume-job` /
   統一 `wait` `logs` 動詞)、刪 execute-plan。
3. **antigravity**:搬上 ProcessAdapter;拆 multi-host(`host-detect.mjs`、
   `.codex-plugin/`、`.agents/`、`bin/`、package.json `bin` 欄位);task 預設改
   前景;補單一入口 companion;CLI 合約補 `--prompt-file` 與統一 `wait` `logs`
   動詞;保留 image / handoff / review / adversarial-review / rescue。
4. **codex**:只換 job-state 層(state / CAS / liveness / cancel);+`task.md`、
   −`execute-plan.md`、機器層補 `--resume-job` 與統一 `wait` `logs` 動詞
   (attach 保留為 logs 的原生 stream 特化);broker / app-server / review-gate
   不動。
5. **fleet plugin**:skill + example + marketplace.json 登錄。
6. 文件收尾:handoff 分岔標注、對齊矩陣終局化、各 README 更新(§4 第 5–6 項)。
7. 真實冒煙(§7 最後一列,人工關卡)。

每步全套測試綠才進下一步。**串行是刻意的,編排時勿平行移植**:antigravity 依賴
delegate 驗證過的 adapter 合約、codex 依賴兩個一次性引擎驗證過的 state 層。
可平行的只有 conformance 劇本級 fan-out、同一步內的獨立檔案工作、與文件收尾。

## 9. 風險與緩解

| 風險 | 緩解 |
|---|---|
| antigravity task 預設改前景 = 行為改變 | minor bump + README 遷移註記 |
| 刪 execute-plan = breaking | 私人生態無其他使用者,成本趨零;淘汰理由入 docs |
| codex job-state 替換出問題 | 藍圖既定:排最後、broker 不動、SessionAdapter 無限期延後;只換 state 層已拿到大部分收益 |
| Workflow 工具介面演進 | skill 與 example 不依賴 Workflow 內部 API,只教方法論;壞了改文件不用動 runtime |
| vendored 副本漂移 / 統一 schema 與舊 job 不相容 / 前綴撞名 / upstream 修補 | 藍圖 §9 既有緩解全部沿用 |

## 10. 版號

| plugin | 現況 | 第二階段 | 理由 |
|---|---|---|---|
| delegate | 0.1.1 | **0.2.0** | CLI 合約 + 刪 execute-plan + shared 地基 |
| antigravity | 0.2.0 | **0.3.0** | 預設改前景 + 拆 multi-host + shared 地基 |
| codex | 1.0.18 | **1.1.0** | +task、−execute-plan、job-state 層替換、+`--resume-job` |
| fleet | — | **0.1.0** | 新生,只帶 skill |

## 11. 第二階段完成定義(取代藍圖 §11 對應段)

1. shared/lib 落地;delegate、antigravity 跑在 ProcessAdapter 上;codex 換
   job-state 層。
2. 機器層 CLI 合約測試三引擎全綠;conformance suite 兩 adapter 全綠;drift
   check 上 CI。
3. multi-host 拆除;人類層指令變更六項(§4)落地。
4. fleet plugin 出生(skill + example);真實冒煙(人工關卡,使用者在場):
   三引擎各一 job + 依 skill 生成的 workflow 跑 2-task 迷你 plan。
5. 單一 `npm test` 全綠(四 plugin structure + 三套 hermetic + shared 單測 +
   conformance + CLI 合約)。

## 12. 非目標(藍圖 §10 全部沿用 + 本次擴充)

沿用:不做 `/ai:task` 單一指令面、只支援 Claude Code、不發 npm package、
不重寫 codex broker、不帶舊 repo git 歷史。

擴充:

- 不統一權限「預設值」(只統一旗標名;delegate 維持 bypass、codex 維持唯讀)。
- 不做 SessionAdapter(codex resume 走既有 thread 機制)。
- shared/lib 不收 git diff 蒐集與 review prompt 模板(留各 plugin 私有)。
- 不做舊 job 資料 migration(新 job 新 schema,舊 job 隨 prune 淘汰)。
- 角色型動詞不擴散(delegate 不補 review / adversarial-review / rescue / handoff)。
- 不在第二階段給 fleet plugin 任何 command(/fleet:status、/fleet:cancel 仍屬第三階段)。
- 不做 per-engine 並發上限(Workflow 編排層已有併發控制;若日後需要,地基加
  「檢查並拒絕」式上限即可,不做排隊機制)。
- 不做 `cost_estimate` 計算欄位(價目表維護是無底坑;`usage` 原始 token 數已足
  以支撐路由決策)。
- 引擎獨有旗標不加引擎前綴(`--effort` 不改 `--codex-effort`:醜、breaking,
  且 prompt 模板中獨有旗標本就置於引擎特定段,無誤傳風險)。
