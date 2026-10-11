> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。

# codex skill — the OpenAI Codex (GPT-6.1) engine (developer notes)

> 改 `skills/codex/`、`tests/codex/` 前先讀這份。不放在 `skills/codex/` 裡:skill 目錄整包會被裝到使用者機器,
> 那裡的 `AGENTS.md` / `CLAUDE.md` 會在 host 讀 references 時被載進使用者的 session。

## 定位
把任務交給 **Codex**(GPT-6.1):獨立 code review / 第二意見、調查與修、帶寫實作。codex **不用 shared
runWorker** —— 它自己跑一顆 **app-server broker**(持久 net socket、Codex app-server protocol)驅動
turn / review;job 持久化才用 shared core 的 **state-store / events / job / reconcile**(見 root gotcha)。

## 結構角色(判斷,不是清單)
- **discovery**:host 要 Codex 檢查時讀 `skills/codex/SKILL.md`,自己跑 `scripts/codex-companion.mjs`。
  **skill 就是整個介面**:3.0.0 起不再是 plugin(沒有 `plugin.json`、marketplace、hooks、subagent),
  使用者用 aghub / `npx skills` 裝 `skills/codex/` 這個目錄。自動發現只靠 skill 的 description;`/codex` 也能手動叫。
- `scripts/codex-companion.mjs` — CLI 入口;經 `lib/codex.mjs` 的 `runAppServerTurn` /
  `runAppServerReview` 驅動 Codex app-server(**不是** runWorker)。
- `scripts/app-server-broker.mjs` — 持久**共用** broker(streaming turn/review/compact、idle-shutdown
  `CODEX_BROKER_IDLE_TIMEOUT_MS` 預設 5s);一次只服務一個 turn,並行的會收到 BROKER_BUSY(-32001)。
- `scripts/codex-watchdog.mjs` — **detached** 背景 turn 的救援層(非唯一:另有 in-process transport
  watchdog、tracked-job timeout/interrupt、dead-pid/deadline reconcile)。
- **session 範圍靠 `CLAUDE_CODE_SESSION_ID`**(`lib/tracked-jobs.mjs` 的 `readSessionId`):Claude Code
  把它匯出給每個 Bash call,所以 `status` 只列本 session 的 job、`task --resume-last` 只接本 session 的
  thread,不需要 SessionStart hook。`CODEX_COMPANION_SESSION_ID` 有設時優先。測試的 `helpers.mjs`
  兩個都會刪 —— 在 Claude Code 裡跑測試時它們一定在環境裡。
- **資料目錄**(`lib/state.mjs` 的 `resolveDataDir`):`CODEX_COMPANION_DATA`,沒設就是
  `~/.local/state/codex-companion`。skill 沒有 host 給的 per-install 資料目錄,所以用固定的 per-user
  路徑,重裝、清 `$TMPDIR` 都不會丟 job。2.x plugin 寫在 `~/.claude/plugins/data/codex-*` 的 job
  仍由 `collectCandidateStateRoots` 掃到,`status` / `wait` / `result <id>` 用完整 id 找得到。
  測試的 `helpers.mjs` 把它指到暫存目錄,並且是 `CODEX_*` 清理的唯一例外。
- **入口判斷比真實路徑**(`lib/entry.mjs`):aghub 用 symlink 裝 skill,node 的 `argv[1]` 留著 symlink、
  `import.meta.url` 卻是真實路徑,直接比字串會不跑 `main()`、exit 0 無輸出。`tests/codex/entry-symlink.test.mjs`。
- **2.0.0 起沒有 SessionEnd 清理**:session 結束時不再主動終止本 session 的前景 job、也不再拆 broker。
  收尾靠既有的層:broker idle 5s 自關、dead-pid reconcile、watchdog、job 硬上限。
- `scripts/lib/codex.mjs` — 高層編排(turn / review、auth·availability、model list、structured
  output);app-server **client 與 direct/broker transport 在 `lib/app-server.mjs`**。
- `scripts/lib/desktop-ipc.mjs` — **桌面版後端**:經 Codex 桌面版私有 IPC router(`$CODEX_HOME/ipc/ipc.sock`,
  u32 LE 長度 + JSON)當 thread follower:owner discovery → 廣播 following → `load-complete-history` 拿快照
  → 套 JSON patch → `thread-follower-start-turn` / `interrupt-turn`。`lib/codex.mjs` 的 `runDesktopTurn` 回傳
  與 `runAppServerTurn` **同形**的結果,render/status/result 因此不分後端。`task --backend auto|cli|desktop`、
  `--thread <id>`;job 記錄帶 `backend: "desktop"`,cancel / hard timeout / watchdog 讀它改走 IPC 中斷、
  **永不 reap broker**。新 thread 兩條路:`--new-thread-via cli`(預設,一次性 app-server 跑 bootstrap)/
  `app`(`codex://threads/new?prompt&path` 深層連結 + 在 App 視窗按 Enter,再從 rollout 檔以首則訊息找出 thread id)。使用者文件在 `skills/codex/references/desktop-backend.md`;
  協定契約、實測證據與 app 更新後的重驗步驟在 `docs/codex-desktop-ipc-audit.md`,為何這樣設計在 `docs/adr/0004`。
- `scripts/lib/worktree-guard.mjs` — **條件式** expected-triplet 驗證(給齊 expected-worktree /
  branch / base 才 assert;現行 verb 都沒帶 → 實質 no-op)。

## 進來改要遵守
- **沒有 `commands/`。** host 依 skill 呼叫 companion verb(`review` / `adversarial-review` /
  `task` / `status` / `result` / `cancel` / `wait` / `logs` / `setup`)。別再寫 `/codex:*`。
- **動到 app-server 相關型別 → 跑 `npm run build:codex`**(`tsc`,對 generated types +
  `lib/app-server-protocol.d.ts`);為何 `npm test` 不涵蓋、CI 卻會紅,見 root Conventions。
- **只有一顆 skill(`codex`)**,1.6.2 起。它同時是呼叫入口(怎麼跑 companion)與
  result-handling 契約。description 常駐 host 的系統提示,body 每次使用都會載入,所以維持短(<80 行),
  細節放 `skills/codex/references/`,並在 SKILL.md 的表格裡掛一行 —— `tests/codex/commands.test.mjs`
  釘住「表格 ↔ references/ 完全對齊」,`tests/repo-structure.test.mjs` 釘住「只有一顆」。
- **版本**在 `skills/codex/SKILL.md` frontmatter 的 `metadata.version`(app-server 的 clientInfo 也讀它),
  CHANGELOG 最新一節要同號,`tests/versions.test.mjs` 檢查。

## 踩雷
- **桌面版只接得手「已有 turn」的 thread。** 只做 `thread/start` 的 thread 進了 state DB,但 app 不肯載入
  (2026-10-03 實測)。所以新的 desktop task 先在**一次性**(`disableBroker`)app-server 跑一輪 bootstrap;
  走共用 broker 的話 broker 的 app-server 會一直握著 thread 的單一寫入鎖,app 開不了它。
- **桌面版的 effort 會被 thread 的協作模式蓋掉。** `inheritThreadSettings:true` 時 app 會把 thread 上一輪的
  `collaborationMode` 帶進新 turn,而 codex 讓協作模式優先於 `model`/`effort`;thread 第一輪是 `low` 的 CLI
  bootstrap,所以 1.8.0 以前桌面任務全跑 `low`。`startTurn` 因此自帶 `collaborationMode`,別拿掉。測試只看得到線上
  送了什麼,實際用哪個 effort 要看 rollout 的 `turn_context`(見 `docs/codex-desktop-ipc-audit.md` B13)。
- **桌面版的權限要自己要,而且要用 app 自己的形狀。** turn request 沒帶任何權限欄位時,app 套用它自己的預設
  (workspace-write、無網路),任務寫不出 project、不能 ssh,停下來問。`startTurn` 因此送
  `approvalPolicy:"never"` + `permissions:":danger-full-access"`(app「完整存取」選單送的就是這個);**別改成
  `sandboxPolicy`**:protocol audit 明令 turn/start 不帶它(auto-review 的 workspace 會拒)。證據見
  `docs/codex-desktop-ipc-audit.md` B14。
- **thread 一次只有一個 writer。** app 開著的 thread,CLI `thread/resume` 回 `already has an active writer`
  —— 這不是 bug,是 `--backend auto` 把這種 follow-up 送去 app 的理由。
- **`--new-thread-via app` 只按一次 Enter,別加重按。** App 開新對話要幾秒(忙時實測 3.3 s),所以是等
  `NEW_CHAT_SETTLE_MS` 後按一次。看似加個「沒出現 thread 就再按」就好,但沒有任何訊號能判斷第一下有沒有送出
  (送進既有對話只會 append 到既有 rollout),盲按會把使用者移過去的草稿送出;三輪 review 證實。找不到 thread
  時結果是「未知」,訊息只叫人先看 App,不建議重跑。
- **未被載入的 thread,owner discovery 在 macOS 可能等滿 router 的 10 s 才回否定**(Linux 立即回)。
  `OWNER_DISCOVERY_TIMEOUT_MS`(2 s)把沉默當「未載入」;別拿掉,不然每次開 thread 白等 20 s。
- **IPC 的 method 版本是對某一版 app 的契約。** 改 `METHOD_VERSIONS` 前先從已安裝 app 的 `app.asar` 撈版本表
  (搜 `"thread-stream-state-changed":`);app 不認的版本回 `request-version-mismatch`,已轉成明確錯誤。
- **Bash `run_in_background` 包住前景 companion,session 結束就結束。** 要活過 session,用
  companion 自己的 `--background`(detached worker + watchdog)。
- broker 是持久共用的(一次一個 turn、idle 5s 自關),不是每次 spawn;改 broker / turn-ack / idle /
  watchdog 時,event-ordering 測試偶爾 flaky(root gotcha),re-run 一次確認。
- **`resolveSandboxMode` 忽略它自己的參數**,每個 thread 都是 `danger-full-access` +
  `approvalPolicy: "never"`(`lib/codex.mjs`,經 buildThreadParams / buildResumeParams)。
  **釘住的只有純函式 `resolveSandboxMode` 本身**(`tests/codex/sandbox-mode.test.mjs`)——
  真正把值送上 wire 的 `buildThreadParams` / `buildResumeParams` 沒有 export,fake fixture 的
  `thread/start` / `thread/resume` **原本也完全不看這兩個欄位**(還回一個跟送出去相反的寫死值)。
  1.6.2 讓 fixture 把收到的 params 記成 `wireStart` / `wireResume`,`tests/codex/sandbox-wire.test.mjs`
  就對那份反查;動這條路徑時看那支。
  **值本身**是**刻意的**:這個 fork 的目標主機起不了 Codex 的
  bwrap,連唯讀 turn 都會 abort。後果是 **`--write` 只是 job metadata,不給任何隔離** —— 少給它
  什麼都沒關住。四個 prose surface 曾經同時把這件事寫錯(暗示省略 `--write` 就等於唯讀),所以改
  任何講 sandbox / 唯讀的文案前先看這條。真要強制:`CODEX_SANDBOX_MODE=read-only`,且只在 bwrap
  起得來的主機上。
- **預設模型 `gpt-6.1-sol`。** 帳號還沒開通這個 slug 時,turn 會 400
  (「requires a newer version of Codex」),失敗原樣交回,不換較弱的 slug。5.6 那個「同模型多數時候可用、偶發 400」是舊觀察,
  沒有在 6.1 上重測。turn 失敗**是 RETURN 不是 throw**,失敗原因有**三種**形狀:獨立 `error`
  notification、terminal `turn/completed` 的 `turn.error`、以及 terminal turn **既非 completed
  也不帶 error**(`buildResultStatus` 把任何非 `"completed"` 都算失敗;第三種 1.6.2 才補上,
  fixture 的 `interrupted-no-error`)。三者都要灌進結構化 `errorMessage`(`failureReasonFor`,
  它在任何失敗上都回非空字串),否則 `--json`/status 只剩裸「failed」。
  **但結構化狀態對了 ≠ 使用者看得到**:`--json`、`wait`、`status` 一直都帶著失敗,而 slash command
  實際列印的那幾條 render 路徑(`renderTaskResult`、`renderStoredJobResult`、`renderReviewResult`)
  曾經只回裸輸出 —— 於是一個「吐了半個答案才死」的 turn 被當成完成的答案交出去
  (`commands/task.md` 叫 Claude 原封不動轉述那份 stdout)。
  **判別式是「body 是不是已經就是那個原因」,不是「有沒有 agent message」。**
  1.6.0 用 `runAppServerTurn` 的 `hadAgentMessage` 當代理,1.6.2 拆掉了:那個旗標兩個方向都錯 ——
  沒有 agent message 但 `turn.error.message` 是真的(裸 `401 Unauthorized`)時它扣住原因、印出來
  完全沒有失敗標記;沒有 agent message 又沒有輸出時它讓 render 掉進 `failureMessage`(broker
  transport 上恆為 `""`),死掉的 turn 印成「Codex did not return a final message.」。
  現在 `errorMessage` 無條件傳給 render,由 render 自己比對 body,相同就退成裸標記
  (`reviewFailureLines` / `renderTaskResult` / `renderStoredJobResult` 三處同一套)。
  **`hadAgentMessage` 已從 `codex.mjs` 刪除**(1.6.2;拿掉最後一個讀者之後,一個看起來還活著的
  欄位就是陷阱本身)—— 別再拿它當判準,也別因為看到舊文件提到它就重新加回去。
  **這個比較有天花板,是刻意接受的**:`describeTurnError` 會給原因接上 ` [codexErrorInfo]` 或
  ` — additionalDetails`,body 沒有,所以 `includes` 必然 miss、兩者近似重複(不是 1.6.0 那種
  字面雙前綴)。理由見 `render.mjs` 的 `ponytail:` 註解:沒有資訊遺失,而放寬比對會有吞掉真正
  不同原因的風險。`tests/codex/turn-error-surfacing.test.mjs` 的 `decorated-turn-error` 把這個
  天花板釘成一條會咬的斷言,改比對邏輯它就會變。動 render 時**三種形狀都要各驗一次**。
  **預設 `gpt-6.1-sol`,閘住就失敗,不降級。** 1.6.4 拿掉 `gpt-6-sol` 單次重試,也拿掉
  `gpt-6-luna` ticket lane。使用者點名才傳 `--model`;`gpt-6-astra` 是 frontier,不是預設。
  不傳 service tier(沒有 Fast)。`ultra` 仍拒絕。`review` / `adversarial-review` 與 `task` 一樣預設
  effort `xhigh`;`review/start` 沒有 effort 欄,所以寫在該 thread 的 `model_reasoning_effort`。
  這兩個 verb 的 `--background` 走同一個 detached worker。app-server 以 `--enable image_generation` 啟動,
  完成的 `imageGeneration` item 的 `savedPath` 進 turn 結果與 stdout 的 `Images:`。
- **未知 flag 不會報錯,會變成 positional。** `lib/args.mjs` 的 `parseArgs` 刻意如此(`task` 的 prompt 文字要能含
  `--flag`)。所以只吃 job id 的 verb 都過 `rejectUnknownOptions`,否則 `wait <id> --timeout 590` 會被讀成三個
  job id。給 job verb 加 option 時,要同時加進該 handler 的 `valueOptions`/`booleanOptions`;`logs` 把 argv
  原樣交給 `handleAttach`,所以 `logs` 的 flag 也要讓 attach 認得。
- **`context: fork` 別碰**(issue #234)。forked general-purpose subagent **沒有 `Agent` tool**,
  routing 會退回 `Skill(codex:rescue)` 並遞迴。command 檔已刪;不要把 `context: fork` 加回 skill。
  `tests/codex/commands.test.mjs` 釘住 skill 是唯一介面。名字很像但機制不同的另兩個
  (`/subtask`、`/fork`)見 `skills/codex/references/delivery-paths.md`。

## 細節指向
- 交付路徑選型(直接 `task` · `--resume-last` · conversation fork)含 fork 命名
  陷阱:`skills/codex/references/delivery-paths.md`。
- protocol / health sync 稽核 + 何時重跑:`docs/codex-protocol-sync-audit.md`(root 已指)。
- 寫 GPT-6.1 prompt:`skills/codex/references/prompting.md`;worktree 驗證合約見
  `lib/worktree-guard.mjs`。
