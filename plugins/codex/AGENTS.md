> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。
> root 已載 codex 的幾個跨層事實:**不跑 shared runWorker**、
> **build:codex 型別檢查是 npm test 之外的**、**runtime.test 偶爾 flaky**、`codex-protocol-sync-audit.md`。
> 本檔只寫增量,不重抄。完整結構問 `codegraph explore` / `tree`。

# codex plugin — the OpenAI Codex (GPT-5.6) engine

## 定位
把任務交給 **Codex**(GPT-5.6):獨立 code review / 第二意見、調查與修、帶寫實作。codex **不用 shared
runWorker** —— 它自己跑一顆 **app-server broker**(持久 net socket、Codex app-server protocol)驅動
turn / review;job 持久化才用 shared core 的 **state-store / events / job / reconcile**(見 root gotcha)。

## 結構角色(判斷,不是清單)
- **discovery**:一顆 **proactive `codex:codex-rescue` subagent**(`agents/codex-rescue.md` — 卡住 /
  要第二意見時主動用)。它的 description 常駐在 host 的系統提示裡,是 codex 唯一、也是**目前
  marketplace 裡最強**的自動發現路徑 —— fleet 的 `delegating-to-fleet` 路由索引已隨 fleet plugin
  移除(見 `docs/adr/0001` 的 superseded 註記)。model-invocable 的 verb 仍是 `handoff`(review)/
  `rescue`(調查·修)/ `execute-plan`(帶寫實作)。
- `scripts/codex-companion.mjs` — CLI 入口;經 `lib/codex.mjs` 的 `runAppServerTurn` /
  `runAppServerReview` 驅動 Codex app-server(**不是** runWorker)。
- `scripts/app-server-broker.mjs` — 持久**共用** broker(streaming turn/review/compact、idle-shutdown
  `CODEX_BROKER_IDLE_TIMEOUT_MS` 預設 5s);一次只服務一個 turn,並行的會收到 BROKER_BUSY(-32001)。
- `scripts/codex-watchdog.mjs` — **detached** 背景 turn 的救援層(非唯一:另有 in-process transport
  watchdog、tracked-job timeout/interrupt、dead-pid/deadline reconcile)。
- `scripts/stop-review-gate-hook.mjs` — Stop hook,對上一個 Claude turn 跑 codex review
  (`/codex:setup --enable-review-gate` / `--disable-review-gate` 開關)。
- `scripts/session-lifecycle-hook.mjs` — SessionStart/SessionEnd hook(`hooks/hooks.json`)。
  SessionEnd **終止並標 failed** 本 session 非 background 的 queued/running job
  (`endedBySession: true`),`background: true` 的**豁免存活**;broker 只在「shutdown 未被
  BUSY 拒絕 **且** 無 active background job」才拆(`shouldTeardownBroker`)。下面
  「session-scoped vs durable」那條踩雷的底層機制就是它。
- `scripts/lib/codex.mjs` — 高層編排(turn / review、auth·availability、model list、structured
  output);app-server **client 與 direct/broker transport 在 `lib/app-server.mjs`**。
- `scripts/lib/worktree-guard.mjs` — **條件式** expected-triplet 驗證(給齊 expected-worktree /
  branch / base 才 assert;現行 handoff/rescue/execute-plan 沒帶 → 實質 no-op)。

## 進來改要遵守
- **commander 入口 = `handoff` / `rescue` / `execute-plan` / `setup`(model-invocable)**;
  `task` / `review` / `adversarial-review` / `status` / `wait` / `logs` / `result` / `cancel` /
  `attach` 都 user-run(`disable-model-invocation`)—— 別假設 `/codex:task` 能自呼叫。
- **動到 app-server 相關型別 → 跑 `npm run build:codex`**(`tsc`,對 generated types +
  `lib/app-server-protocol.d.ts`);為何 `npm test` 不涵蓋、CI 卻會紅,見 root Conventions。
- **只有一顆 skill(`codex`)**,1.6.2 起。body 是 9 個 command 的熱路徑(result-handling 契約),
  細節一律放 `skills/codex/references/`,並在 SKILL.md 的表格裡掛一行 —— `tests/codex/commands.test.mjs`
  同時釘住「只有一顆」與「表格 ↔ references/ 完全對齊」。要加第二顆先問為什麼。
- **NOT dual-host**(無 `.codex-plugin/`)—— 不像 cc / agy;bump 只動 plugin.json ↔ marketplace。

## 踩雷
- **`/codex:handoff --background` 是 session-scoped best-effort**(`run_in_background`),**不是**
  `/codex:task --background` 那種 detached + watchdog 的 durable tracked job —— session 結束就結束
  (`commands/handoff.md`)。要活過 session 用 `/codex:task --background`。
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
- **預設模型 `gpt-5.6-sol` 對 ChatGPT 帳號會間歇被 400**(「requires a newer version of Codex」,同模型
  多數時候可用)。turn 失敗**是 RETURN 不是 throw**,失敗原因有**三種**形狀:獨立 `error`
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
  model-unavailable 會**自動單次重試降 `gpt-5.6-terra`**
  (`isModelUnavailableFailure` + `runWithModelFallback`,可見:progress line + payload `modelFallback`);
  偵測刻意保守,別把 auth/rate-limit 也吃進 fallback。
- **`context: fork` 別碰**(issue #234)。forked general-purpose subagent **沒有 `Agent` tool**,
  routing 會退回 `Skill(codex:rescue)` 並遞迴回同一個 command。`commands/rescue.md` 保持 inline +
  用 `Agent` 派 subagent;`tests/codex/commands.test.mjs` 與 antigravity 那邊各釘一條
  `doesNotMatch(/^context:\s*fork\b/m)`。名字很像但機制不同的另兩個(`/subtask`、`/fork`)見下面
  delivery-paths。
- **`codex-rescue` 一次 spawn ~20K tokens**(實測 `subagent_tokens: 20732`,一次 trivial 轉發)。
  成因:`skills:` frontmatter 會**預載技能全文**,不只 description。那個數字是 1.6.1 量的,當時預載兩顆
  skill(`codex-cli-runtime` + `gpt-5-6-prompting`)+ agent body ≈ 4.8K 固定成本。**1.6.2 收成一顆
  `codex` skill**:runtime 契約併回 agent body(本來就 ~90% 重複),prompting 降級成 references/ 靠
  `cat` 取用,所以固定成本只剩一份短 skill body + agent body。**20K 那個數字還沒對 1.6.2 重測**,
  當上界看;agent system prompt 與工具定義才是大頭,別預期等比例下降。
  這筆錢買到的是 proactive discovery 與 `tools: Bash` 圍欄,**不是** context
  隔離(隔離本來就由 Codex 自己的 context 提供,主線兩條路收到的位元組一樣,因為 agent 被明文禁止摘要)。
  一批 ticket 走主線直接 `task` 就好,別 N × 20K。要調的話 frontmatter 還有 `effort` / `maxTurns`
  沒用 —— 但 `maxTurns` 會夾死 `--prompt-file` 那條(寫檔 + task + 收尾 = 3 turns 起),別設 2。
  `permissionMode` / `hooks` / `mcpServers` 對 plugin subagent **會被靜默忽略**,別在這裡試 ——
  這三個 key 在 Claude Code 的 agent frontmatter schema 裡**是有定義的**(對 user-defined agent
  有效),所以「查了 schema 發現有」不構成推翻這條。要重驗哪些 key 現在真的存在、叫什麼,
  `strings` 那顆 `claude` binary 撈 zod schema(`grep -oa '.\{0,220\}<描述片段>.\{0,320\}'`)——
  那是唯一權威來源,別背清單,每個版本都可能加。

## 細節指向
- 交付路徑選型(直接 `task` · `--resume-last` · subagent · conversation fork)含實測成本與 fork 命名
  陷阱:`skills/codex/references/delivery-paths.md`。
- protocol / health sync 稽核 + 何時重跑:`docs/codex-protocol-sync-audit.md`(root 已指)。
- 寫 GPT-5.6 prompt:`skills/codex/references/prompting.md`;worktree 驗證合約見
  `lib/worktree-guard.mjs`、設計見 `docs/superpowers/plans/2026-06-21-worktree-cwd-guard.md`。
