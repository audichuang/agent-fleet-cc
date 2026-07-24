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
  要第二意見時主動用)+ fleet `delegating-to-fleet` 路由到 model-invocable 的 `handoff`(review)/
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
- **NOT dual-host**(無 `.codex-plugin/`)—— 不像 cc / agy;bump 只動 plugin.json ↔ marketplace。

## 踩雷
- **`/codex:handoff --background` 是 session-scoped best-effort**(`run_in_background`),**不是**
  `/codex:task --background` 那種 detached + watchdog 的 durable tracked job —— session 結束就結束
  (`commands/handoff.md`)。要活過 session 用 `/codex:task --background`。
- broker 是持久共用的(一次一個 turn、idle 5s 自關),不是每次 spawn;改 broker / turn-ack / idle /
  watchdog 時,event-ordering 測試偶爾 flaky(root gotcha),re-run 一次確認。
- **預設模型 `gpt-5.6-sol` 對 ChatGPT 帳號會間歇被 400**(「requires a newer version of Codex」,同模型
  多數時候可用)。turn 失敗**是 RETURN 不是 throw**,失敗原因有兩種形狀(獨立 `error` notification 與
  terminal `turn/completed` 的 `turn.error`)—— 兩者都要灌進結構化 `errorMessage`(`failureReasonFor`),
  否則 `--json`/status 只剩裸「failed」。model-unavailable 會**自動單次重試降 `gpt-5.6-terra`**
  (`isModelUnavailableFailure` + `runWithModelFallback`,可見:progress line + payload `modelFallback`);
  偵測刻意保守,別把 auth/rate-limit 也吃進 fallback。

## 細節指向
- protocol / health sync 稽核 + 何時重跑:`docs/codex-protocol-sync-audit.md`(root 已指)。
- 寫 GPT-5.6 prompt:`gpt-5-6-prompting` skill(本 plugin 內);worktree 驗證合約見
  `lib/worktree-guard.mjs`、設計見 `docs/superpowers/plans/2026-06-21-worktree-cwd-guard.md`。
