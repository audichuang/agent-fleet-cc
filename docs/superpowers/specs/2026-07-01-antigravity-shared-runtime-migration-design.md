# antigravity → Shared Runtime 遷移設計(design spec)

> **狀態:** v2 — 已過 Codex 驗證閘(2026-07-01,判定 **PROCEED-WITH-CHANGES**)。Codex 的 5 個 must-fix + 5 個 missing decision 已全數 fold:D-1(保真度改 emit 所有行)、D-3(auth 改可行機制:extractResult 不能設 errorKind)、D-5/§8(移除 hash 12→8 矛盾)、D-14(session 存 top-level `sessionId`)、D-16(result projection)、D-17(job id)、D-18(foreground 不串流)、D-19(timeout matrix)、D-6(config 位置)。架構判斷 §3 經 codex 獨立確認成立。
> **範圍:** 把 `antigravity` plugin(agy 引擎)從自帶 job runtime 遷移到 repo 的 vendored shared runtime(`shared/lib/`),對齊 `cc`(v0.3.0)的遷移形狀。
> **本文是 design spec**(what / why / scope / 契約 / 驗收),不含逐步實作 code — 那屬於後續 plan。

---

## 1. Summary

`antigravity` 目前自帶一整套 job runtime(`scripts/lib/state.mjs`、`atomic-state.mjs`、`job-control.mjs`、`liveness.mjs`、`agent-runtime.mjs` …),與 `cc`、`codex` 各自維護幾乎同構的狀態機。這造成三份分叉:`shared/lib/` 上做的 race 修復(cross-process CAS、TTL 孤兒回收、claim-owner vs worker-pid reconcile、orphan-lock sweep、no-resurrect / TOCTOU 防護)不會自動流到 antigravity。

本案把 antigravity 的 **job runtime 換成 vendored `shared/lib/`**,並為 agy 實作一個 `ProcessAdapter`(就像 `cc` 的 `makeClaudeAdapter`)。agy 引擎特有的知識(spawn `agy --print`、OAuth、prompt 組裝、review JSON 解析、IMAGE_PATH 提取、git diff 收集)全部集中在 adapter 與 command 層;job 生命週期(spawn / 逐行解析 / finalize / cancel / reconcile / wait / prune)交給 shared。

遷移後 antigravity 的 race 硬化程度**升級**到與 cc/codex 一致(shared 是這些修復的權威源頭),且刪掉自家 runtime god-file。

## 2. Goals / Non-goals

### Goals
- antigravity 的 job 持久化 + worker 生命週期改用 vendored `shared/lib/`,與 cc 共用同一套 `state-store` / `runWorker` / `ProcessAdapter` 模型。
- 為 agy 實作合格的 `ProcessAdapter`(通過 `validateProcessAdapter` + shared conformance 五不變量)。
- 保留 antigravity 既有的**全部使用者可見行為**,除本文 §7 明列的行為變更外。
- 保留跨引擎 `wait` exit-code 契約(completed=0 / cancelled=2 / failed|missing=1 / timeout=10)。
- 保留三宿主 + npx 打包(Claude Code / Codex / agy / standalone)。
- 遷移後 race 硬化程度**只升不降**(對照 shared 的 TTL / claim-owner reconcile / orphan sweep)。
- 全程 hermetic 測試綠 + CI drift-check 綠;分階段,每階段獨立可 ship、可回退。

### Non-goals(YAGNI,明確排除)
- **不改** `shared/lib/` 的行為契約(除非發現真缺口;若真要改,會漣漪到 cc/codex,列為決策點送 codex,不靜默改)。
- **不動** sibling plugin 及其測試(`plugins/{codex,cc}/`、`tests/{codex,cc}/`)。唯一跨切面例外:`scripts/sync-shared.mjs` 的 TARGETS 陣列(加 `antigravity`)。
- **不採用** SessionAdapter(常駐 broker 形態,無限期延後);agy 是一次性 spawn,ProcessAdapter 就夠。
- **不新增** agy 引擎能力:不做 streaming、thought chunks、structured tool events(agy `--print` 天生沒有)。
- **不做** 舊 flat-state 的向後相容讀取層(見 §8:採 clean break,理由充分)。
- **不改** review / adversarial-review / image / handoff 的**使用者介面**(旗標、輸出格式不變)。

## 3. 核心架構決策:走 cc 路線,不是 codex 路線

`codex` 的遷移(`docs/superpowers/plans/2026-06-29-codex-shared-state-store-migration.md`)刻意**只採用 shared state-store**,不採 `runtime/worker.mjs` 也不採 `ProcessAdapter`,因為 codex 引擎是 persistent `codex app-server` broker(JSON-RPC、turn capture/interrupt/steer,跨 job 共用),不 fit「spawn 一個 CLI → 逐行解析 stdout → 它退出」的模型。

**antigravity 相反。** `agy --print`(或 `--continue` / `--conversation`)就是**一次性 spawn、跑完退出、stdout 拿最終回應**——與 `claude -p` 同構,完美 fit `buildInvocation → spawnEngine → parseEvent(stdout) → extractResult → finalizeJob`。

| 面向 | codex 遷移 | **antigravity 遷移(本案)** |
|---|---|---|
| 採用範圍 | 只 state-store | **完整 runtime(runWorker + ProcessAdapter)** |
| 引擎模型 | persistent broker(不 fit spawn) | **spawn-per-job(`agy --print`),完全 fit** |
| conformance | state-store subset | **full ProcessAdapter conformance** |
| 最佳範本 | 無(broker 特殊) | **`cc`(v0.3.0,同模型)** |
| 工作量本質 | 大(broker/state 交界複雜) | 薄 adapter(~120 行)+ worker-entry(~34 行)+ command 改線 |

**決策:antigravity 採用完整 shared runtime,以 `cc` 為實作範本。**

## 4. Locked decisions

以下每項都是遷移必須遵守的鎖定決策;`D-*` 供 plan 與 codex 驗證引用。

### D-1 agy print-mode I/O 映射(prompt-as-argv + 累積行)
`runWorker`(`shared/lib/runtime/worker.mjs:202-220,236-238`)逐行讀 stdout:每行呼叫 `adapter.parseEvent(line)`,**只有回非 null 的行才進 `events`**;結束後 `adapter.extractResult(events, exitCode)` **只看 `events`**。cc 走 `--output-format stream-json`,`parseEvent` 只在 `session`/`result` JSON 事件回值、內容行回 null。

**agy `--print` 吐的是純文字最終回應**(實測回 `OK\n\n...`),不是 JSON 流。若照 cc 對內容行回 null,`extractResult` 會拿到空結果。

**決策(輸入端):** prompt 必須當 `--print` 的 **argv operand** 傳(`argv.push("--print", prompt)`),`stdinPayload: ""`。**agy 不讀 stdin**(`agent-runtime.mjs:135` 已如此,且 `stdio:['ignore','pipe','pipe']`;實測 `agy --print`(無值)→ exit 2 `flag needs an argument`)。**這推翻了「照 cc 走 stdin」的直覺——cc 的 `stdinPayload: prompt` 對 agy 是錯的。**

**決策(輸出端,含 codex review must-fix #4 的保真度修正):** agy 的 `parseEvent` 對**每一行(含空白行)**回一個累積事件 `{ kind: "line", text: line }`(永不 throw),`extractResult` 用 `\n` join 回 `resultText`(exit 0 → `ok:true`)。**保真度(鎖定):emit 所有行**,故 `resultText` 保留段落與空行結構;唯一非 byte-exact 之處是 readline 對行尾 `\r\n`/`\n` 的正規化(對 `parseReviewJson` / `IMAGE_PATH` 提取無害)。**不採「丟空白行」的優化**——那會塌縮多段落答案,且與 review/image 需要無損還原多行輸出(含 code fence / JSON)矛盾(這修掉了原稿 D-1 與 Q3「log 是 verbatim」的錯誤宣稱:`log` 經 readline `line+"\n"` 重組,本就不是 byte-exact,`worker.mjs:202-218`)。特殊 marker(OAuth 標記、`IMAGE_PATH:`)由 command/adapter 端從 `resultText` 偵測(見 D-3、D-4)。

### D-2 agy 無 print-mode sessionId → sessionId 恆 null,resume 靠 `--continue`
agy print 模式不暴露可捕捉的 conversation id(CHANGELOG v0.2.0 明載)。

**決策:** `extractResult` 的 `sessionId` 恆為 `null`;`resumeArgs` 形同虛設(可回 `["--conversation", id]` 以滿足契約,但實務用不到)。resume 由 command 層下 `agy --continue` 完成(續最近對話),不依賴 sessionId。不得偽造 sessionId 捕捉。

### D-3 OAuth 語意變更 + auth 雙 channel 偵測(§7 詳述)
`runWorker` 是一次性 spawn + `stdin.end()`,**無法**偵測 OAuth URL → 暫停 → 等使用者完成 → 續跑(這是 v0.2.0 background worker + SPIKE-findings 描述的行為)。

**決策(行為):** background job 遇未登入的 agy 一律走 auth 失敗 → job `failed`(`errorKind:"auth"`),command 層偵測 `errorKind==="auth"` 印「請跑 `/antigravity:setup` 完成登入後重試」。**`commands/setup.mjs` 的互動 OAuth 路徑(`stdio:"inherit"`)保留不變**——它才是 sanctioned 的 (re-)auth 入口;本變更只移除 background worker 的「暫停等待」語意。

**決策(auth 偵測機制,codex review must-fix #1 — 原稿「靠 errorKind==="auth"」不可實作):** shared 契約限制了做法——`extractResult` 回傳是 `{ok, resultText, sessionId, usage?}`,**不能設 errorKind**(`adapter-api.mjs:7-10`);只有 `classifyError(stderrTail, exitCode)` 能設 errorKind,而它**只拿 `stderrTail`**(`worker.mjs:252-259`)。舊 v0.2.0 是從 **stdout** scrape auth 標記(`agent-runtime.mjs:150-160`)。因此採三管齊下、且**不倚賴單一 errorKind 來源**:
- `classifyError` 對 `stderrTail` 匹配 auth 正則 → `errorKind:"auth"`(涵蓋 agy 把 auth 印 stderr 或非零退出);
- `extractResult` 對 join 後的 `resultText` 匹配 auth 標記 → 回 `ok:false`(涵蓋 agy 把 auth 印 stdout 又 exit 0,避免靜默假成功);
- **auth 提示在 command 層產生**:command 讀完成 job 後,若 `errorKind==="auth"` **或** `resultText` 含 auth 標記 → 印「跑 `/antigravity:setup` 重試」。
- **承認的邊界(NEEDS-VERIFY):** 若未登入 agy 掛著等互動輸入,shared 的 `timeoutMs` 會先到 → job `timed-out`(errorKind `timeout`),不是 auth。本機已登入,未登入路徑無法在此驗證;plan 必須加 fake「unauth」shim(stdout 版 / stderr 版 / 掛起版)+ 一次真的登出手動驗證來釘死。

全部 adapter / command-local,無 shared 改動。

### D-4 引擎特有邏輯留在 command 層,不進 runtime
與現行架構一致,以下不進 shared runtime、留在 command / adapter 層:
git context 收集(`git.mjs`,review / adversarial-review)、容錯 review-JSON 解析(`render.mjs` 的 `parseReviewJson`)、IMAGE_PATH marker 提取(`image.mjs`)、prompt 組裝(`prompts.mjs` / `prompt-templates.mjs`)、review / adversarial-review 的 markdown render。

adapter 只擁有:`buildInvocation`(組 agy argv:`--print <prompt>` 為 argv operand + `--continue`/`--conversation <id>`/`--model`/`--sandbox`/`--print-timeout`/`--add-dir`,`stdinPayload:""`,見 D-1)、`parseEvent`、`extractResult`、`classifyError`、`resumeArgs`。

### D-5 佈局遷移(clean break)+ stateDir keying 不變
**stateDir keying 必須保持與現在完全一致**:`resolveDataRoot` 回 `CLAUDE_PLUGIN_DATA`,fallback **`os.tmpdir()/antigravity`**(`state.mjs:50-54`);stateDir = `<slug>-<sha256 前 12 碼>`(`state.mjs:56-61`)。**絕不**改成 cc 的 8 碼 hash 或 `~/.claude/plugins/data/...` root——那會把整個 workspace 的 state 搬家(4 個 lens flag 的 blocker)。

clean break 發生在**同一個 stateDir 的內部佈局**,不是路徑:
- 舊:`state.json`(config + job index)+ `jobs/<id>.json`/`.log`/`.lock`,in-process `withJobMutex`。
- 新:同一 stateDir 下,directory-per-job(`jobs/<id>/job.json`)+ append-only `events.ndjson` + O_EXCL cross-process CAS(shared)。

**決策:採 clean break**(見 §8)——升級後新碼掃 `jobs/<id>/`,讀不到舊的 flat `jobs/<id>.json`;不寫向後相容讀取層。升級說明明確告知舊背景任務記錄不再顯示(inert,可手動清)。config 例外,見 D-6(一次性遷移,不 clean break)。

### D-6 config.stopReviewGate 一次性遷移(沿用 codex 先例)
舊 `state.json` 存了 workspace 級 `config.stopReviewGate`(`state.mjs:44`);shared 是 jobs-only,無 workspace 級 config 容器。

**決策:** config 拆到獨立檔 `config.json`,**放 stateDir 根**(與舊 `state.json` 同層);`getConfig` **一次性遷移**——新檔不存在但舊 `state.json` 存在時,從舊 `config` 區塊 seed,避免升級後設定被靜默重置。`/antigravity:setup` 寫 `stopReviewGate` 的路徑一併改到 `config.json`(現行寫 `state.json`)。此為 codex 遷移已驗證的解法(codex plan gate must-fix #4)。

### D-7 listJobs 排序 facade
shared `listJobs` 按 `createdAt`;antigravity status/result 期望 newest-by-`updatedAt`。

**決策:** facade 在 shared `listJobs` 之上 re-sort by `updatedAt` desc,消費端排序不變(codex plan gate must-fix #5 同款)。

### D-8 `claimTerminalTransition` 在 shared 是 private
shared `state-store.mjs:83` 的 `claimTerminalTransition` **未 export**;終態轉移一律走 public `finalizeJob`(內部自做 O_EXCL claim)。

**決策:** 不假設有 shared `claimTerminalTransition` export;所有終態寫入走 `finalizeJob`(codex plan gate must-fix #2 同款事實)。

### D-9 wait exit-code 契約保持(shared 有三個陷阱)
遷到 shared `waitForJob` 後,`commands/wait.mjs` 的 `exitCodeFor`(`wait.mjs:83-88`)必須續產:completed=0 / cancelled=2 / failed|missing=1 / wait-deadline-timeout=10。shared 引入三個必須處理的差異:

1. **`timed-out` 是 shared 新增的 TERMINAL job status**(`job.mjs:5`),antigravity 的 `exitCodeFor` 從沒見過。要區分兩件事:(a) job **finalize 成 `timed-out`**(terminal,worker 端 `timeoutMs` 到)→ 這是**終態**;(b) **wait deadline** 到但 job 未終態(`waitForJob` 回 `done:false`)→ exit **10**。決策:wait-deadline(done:false)→ 10;終態 job 的 `timed-out` status 映射到 exit **1**(與 failed 同類,非 10)——鎖定此映射,plan 補測試。
2. **missing / pruned job**:shared `waitForJob` 回 `{done:true, job:null}`(`wait.mjs:37`);antigravity 現在的 `waitForTerminal→buildSingleJobSnapshot` 對 no-match 會 **throw**。決策:`job:null` → exit **1**(不得 throw)。
3. **無限 timeout**:`task.mjs --wait` 現在 `waitForJob(workspaceRoot, job.id)` 無 timeout(`job-helpers.mjs:316` default `timeoutMs=0`=infinite);shared `waitForJob` 無 infinite 模式(缺 timeoutMs → `deadline=NaN` → 行為未定義)。決策:**所有** `--wait` 路徑(`task`、`rescue`、`review` 等,不只 task)傳明確的有限 timeoutMs(見 D-19 timeout matrix)。

### D-10 空輸出但 exit 0 = completed(非 failed)
`extractResult` 回 `ok:(exitCode===0)`;`worker.mjs:244-248` 的 `failed = …|| exitCode!==0 || !result.ok`。故一次乾淨但無輸出的 agy run(exit 0、stdout 空)finalize 成 `completed` 且 `resultText:null`。**決策:這是預期 UX**(`render.mjs` 的 result 渲染 fall through 到「無結果 payload」訊息),鎖定並加測試,不視為失敗。注意此決策與 D-3 的 auth-on-stdout 偵測並存:未登入若在 stdout 印 auth 標記,`extractResult` 回 `ok:false`(D-3),不會誤判為 completed。

### D-11 `process.mjs` 保留
`lib/process.mjs` **不可刪**:`git.mjs:9` import 它的 `runCommand`/`runCommandChecked`/`formatCommandFailure`。只有 `terminateProcessTree` 在 cancel 改走 shared `cancelJob` 後變死碼。決策:保留模組與被用到的 export,刪 `terminateProcessTree`。

### D-12 background 入口改兩參數形
現行 background 是 `node _worker.mjs <jobId>`,workspace 靠 `ANTIGRAVITY_WORKSPACE_ROOT` env(`_worker.mjs:5-6,32-34`)。決策:改成 cc 的 `node worker-entry.mjs <stateDir> <jobId>` 兩參數形(stateDir 明確傳入,不靠 env);`_worker.mjs` 刪除。

### D-13 conformance 用 agy 專屬 test,不重用 shared `runConformanceSuite`
shared `tests/shared/conformance/conformance.mjs` 硬編 JSON-stream 期待(`sessionId==='fake-session-1'`、`resultText` 匹配 `/^echo:/` 等),plain-text 的 agy adapter **過不了**。決策:寫 **agy 專屬** `tests/antigravity/adapter-conformance.test.mjs`,驗同樣的**五不變量**(§9),但用 plain-text 語意 + agy fake shim(mode:ok/echo/auth/hang/nonzero/grandchild,從 `--print <prompt>` argv 讀 prompt、emit 純文字、honor pidfile)。不 import shared 的 conformance harness。

### D-14 session filtering 保留(command 層)
現行 status/result/cancel 用 `ANTIGRAVITY_PLUGIN_SESSION_ID`(`job-control.mjs:15`)經 `filterJobsForCurrentSession` 過濾,而該 filter 讀的是 **top-level `job.sessionId`**(`job-control.mjs:29-32`),建 job 時也寫 top-level `sessionId`(`job-helpers.mjs:86-94`)。shared job schema **本來就有 top-level `sessionId` 欄位**(`shared/lib/core/job.mjs:39`),且 agy 的 engine resume sessionId 恆 null(D-2)不佔用它。決策(codex review must-fix #3 — 原稿「存 `job.request`」會讓現有 filter 靜默失效):**session id 續存 top-level `sessionId`**,`filterJobsForCurrentSession` 邏輯不變,在 command 層對 facade `listJobs` 結果過濾;維持現有多 session 隔離。

### D-15 recursion guard(新增保護)
antigravity 目前**沒有** recursion guard 讀取端(對照 cc `cc-companion.mjs:91` 有)。shared `buildEngineEnv` 要求 adapter 宣告 `recursionMarker` 並強制注入。決策:marker 取 `ANTIGRAVITY_ACTIVE`;讀取端 guard 加在 CLI 入口(對齊 cc),遞迴呼叫時拒絕。這是**新增保護**,非行為變更。

### D-16 result schema projection(codex review must-fix #5)
現行 render 讀 `storedJob.result.rawOutput`,無則 fall through「No captured result payload」(`render.mjs:324-368`),而現行 job 存 `result.rawOutput`(`job-helpers.mjs:214-220`);shared worker 寫的是 **top-level `resultText`**(`worker.mjs:265-270`)。若不處理,`/antigravity:result` 即使 job 正常完成也會 regress 成「無 payload」。**決策:** facade 提供一個 projection——把 shared job record 的 `resultText`/`error`/`errorKind` 映射成 command / render 端期望的形狀(採「render 改讀 shared `resultText` + `errorKind`」為主;若改動面過大,facade 合成舊 `result.rawOutput`/`errorMessage` 形狀當相容層)。plan 鎖定確切欄位對應並加 render 測試。

### D-17 job id 格式
現行 `generateJobId` 產 12-hex(`job-helpers.mjs:24-27`);shared `newJobId` 產帶前綴 id(`shared/lib/core/job.mjs:12-13`)。**決策:** 採 shared `newJobId`(遷到 shared 就用其 id 生成,少寫 code);plan 必須先 grep 確認沒有 command / 測試 / 使用者可見文案硬依賴 12-hex 格式(如 `status` 顯示、job 匹配的 slice 長度),有則一併改。

### D-18 foreground 不再即時串流 stdout(behavior change,codex missing-decision)
現行 review / task / image 的 foreground 路徑會把 agy stdout 即時轉發到 stderr 給使用者看(`commands/task.mjs:70`、`review.mjs:98`、`image.mjs:62` 的 `onStdout`);shared `runWorker` **無等價 callback**。**決策:** 接受遷移後 foreground **不即時串流**,結果在 job 完成後一次呈現(agy `--print` 本就是一次性回最終回應、非 streaming engine,即時串流價值低)。列入 §7 行為變更;**不為此改 shared**(加 callback 會漣漪 cc/codex)。

### D-19 timeout matrix
三層 timeout 必須明確對應,不得互相打架:
- agy 自身 `--print-timeout <Ns>`(引擎端,adapter `buildInvocation` 依 `AGY_PRINT_TIMEOUT_MS` 組);
- shared job `timeoutMs`(worker 端硬 backstop,`worker.mjs:177` 讀 `running.timeoutMs`,依 `AGY_JOB_TIMEOUT_MS`);
- command `--wait` deadline(`waitForJob` 的 poll 上限,見 D-9,須有限、非無限)。
**決策:** job `timeoutMs` ≥ agy `--print-timeout`(讓引擎自己先超時、給出乾淨錯誤,worker backstop 才動);`--wait` deadline 獨立於前兩者(它是「呼叫端願意等多久」,到期回 exit 10 但不殺 job)。plan 定確切預設值。

## 5. Architecture:遷移後檔案職責

| 檔案 | 遷移後職責 |
|---|---|
| `plugins/antigravity/scripts/lib/shared/**`(vendored) | shared core,由 `sync-shared` 從 `shared/lib/` 複製;此處唯讀。 |
| `plugins/antigravity/scripts/lib/adapter.mjs`(新) | `makeAgyAdapter()`:agy 全部引擎知識(argv 組裝、parseEvent 累積、extractResult join、classifyError、resumeArgs)。以 `cc adapter.mjs` 為範本。 |
| `plugins/antigravity/scripts/worker-entry.mjs`(新) | background detached 入口(~34 行,參考 cc):early pid stamp + `installCancelForwarder` + `runWorker`。 |
| `plugins/antigravity/scripts/lib/state.mjs` | 縮成 **thin facade** over vendored shared store(保留現有 export 面:路徑 helper、readJob/listJobs、finalize、reconcile),外加 D-7 排序、D-6 config 遷移入口。刪自家 flat-index + `.lock` CAS 機制。 |
| `plugins/antigravity/scripts/lib/agy-config.mjs`(新,若需) | `getConfig`/`setConfig` over `config.json` + D-6 一次性遷移。 |
| `plugins/antigravity/scripts/lib/{git,image,prompts,prompt-templates,render}.mjs` | 引擎特有,**保留**(command 層用,見 D-4)。 |
| `plugins/antigravity/scripts/lib/{agent-runtime,atomic-state,job-control,liveness,poll,job-helpers}.mjs` | job 生命週期核心 → 由 shared 取代;逐階段刪除或縮成 facade shim。 |
| `plugins/antigravity/scripts/commands/*.mjs` | 改用 shared API(foreground: `await runWorker`;background: spawn `worker-entry.mjs` detached;status/result/cancel/wait/logs 呼叫 shared `readJob`/`listJobs`/`cancelJob`/`waitForJob`/`readEvents`)。review/adversarial-review/image 額外保留其 prompt/context/parse/render 層。 |
| `plugins/antigravity/scripts/commands/{_worker,_watchdog}.mjs` | `_worker` → 由 shared `runWorker` + worker-entry 取代;`_watchdog` → 依 adapter `wantsWatchdog` 決定去留(見 §11 open question)。 |
| `scripts/sync-shared.mjs` | TARGETS 加 `"antigravity"`(跨切面例外)。 |

## 6. 引擎特有 vs 通用分界(一句話)
**通用(交給 shared):** state 持久化、終態 CAS、reconcile、wait、prune、cancel(process-group kill)、events.ndjson、env 消毒 + 遞迴守衛、worker 生命週期。
**agy 特有(adapter + command 保留):** agy spawn argv、print-mode 輸出累積、OAuth 分類、`--continue` resume、git diff、review JSON、IMAGE_PATH、prompt 組裝、render。

## 7. Behavior changes(必須明列給使用者)

1. **OAuth(D-3):** 未登入時,舊行為是 worker 偵測 OAuth URL、透過 `/antigravity:status` surface、暫停等使用者完成再續。**新行為:未登入 → job 直接 `failed`(errorKind `auth`),提示跑 `/antigravity:setup` 登入後重試。** 理由:shared 一次性 worker 無「暫停等外部事件再續」能力;把未登入當可重試的 auth 失敗,比 hang 著等更清晰。已登入的正常路徑不受影響(實測 `agy --print` 直接回結果)。
2. **舊背景任務記錄消失(D-5):** 同一 stateDir 內部佈局變(flat `jobs/<id>.json` → `jobs/<id>/job.json`),升級後看不到升級前的 job 記錄(inert,不影響新任務)。
3. **空輸出的乾淨 run 顯示為 completed 但無 payload(D-10):** exit 0 且 stdout 空 → `completed`,結果區顯示「無結果 payload」而非 failed。
4. **health / heartbeat / watchdog 欄位移除:** `classifyRuntimeHealth`、`lastProgressAt`/`lastHeartbeatAt`/`healthStatus`/`possibly_stalled`、`oauthUrl` 欄位與 `_watchdog.mjs` 被 shared reconcile-per-poll + `reconcileDeadPids` 取代;status 渲染不再有 Health 區。淨 liveness 相等或更好(shared 多 TTL + orphan sweep)。
5. **foreground 不再即時串流 stdout(D-18):** review / task / image 的前景輸出不再邊跑邊顯示,改為 job 完成後一次呈現(agy `--print` 本就一次性回最終結果)。

## 8. Data-integrity / 遷移安全

- **In-flight 舊 job:** 採 clean break。理由:(a) **佈局變(同一 stateDir 內** flat `jobs/<id>.json` → `jobs/<id>/job.json`**,stateDir 路徑本身不變 — 見 D-5,不涉 hash 長度變更)**,新碼掃 dir-per-job 讀不到舊 flat 檔;(b) antigravity 是 pre-release(v0.2.0),無正式相容承諾;(c) 寫向後相容讀取層的成本 > 效益(YAGNI)。**緩解:** CHANGELOG + 升級提示明說;舊記錄 inert 可手動清;建議在無 in-flight job 時升級。
- **config(D-6):** 一次性遷移,不 clean break(設定遺失對使用者有感,且 codex 已有現成解法)。
- **升級期間 crash-survivability 不得有缺口:** 遷移後 reconcile(dead-pid + TTL claim-orphan)+(watchdog,若保留)必須在切換完成時即刻覆蓋;不得出現「新碼已寫 job 但 reconcile 尚未接管」的窗口。分階段時,任一階段結束都不得讓 suite 或真實背景任務停在破碎中間態。

## 9. Acceptance criteria(驗收)

1. `validateProcessAdapter(makeAgyAdapter())` 回空陣列(結構合格)。
2. **agy 專屬 conformance**(D-13;驗 shared 五不變量,但用 plain-text 語意 + agy fake shim,**不** import shared `runConformanceSuite`):job 必達終態、events.ndjson 五類事件齊、cancel 殺整個 process group、result 冪等、exitCode 可為 null。
3. `wait` exit-code 契約(D-9)有測試證明 0/2/1/10。
4. 遷移前綠的 antigravity 行為測試,遷移後語意等價地綠(該重寫的重寫,見 §10)。
5. `npm run sync-shared && git diff --exit-code` 綠(vendored 與源零漂移)。
6. hermetic e2e(`tests/antigravity/e2e-cli.test.mjs`)綠;真 agy smoke(launch→wait→result→cancel 契約)手動通過。
7. 一個真實 race 對抗測試:證明終態 CAS 在 cross-process 下 first-writer-wins(對齊 shared,不倒退)。

## 10. Test disposition(30 個 `tests/antigravity/*.test.mjs`)

| 類別 | 處置 | 代表檔 |
|---|---|---|
| 針對被移除的自家內部(flat state / atomic-state / 自家 CAS)的單元測試 | **刪除或重寫**成對 shared facade 的行為測試 | `state-cas`, `state-resilience`, `job-control`, `job-control-snapshot`, `reconcile`, `liveness`, `cancel-cas` |
| 針對 agy 引擎特有邏輯(不動的部分) | **保留** | `image`, `render`, `git`, `text`, `args`, `host-detect`, `agy-timeout` |
| worker / watchdog integration | **重寫**成對 shared runWorker / reconcile | `agent-runtime*`, `background-integration`, `watchdog-integration`, `_worker` 相關 |
| 命令 self-invoke / e2e | **保留 + 重 seed** | `command-selfinvoke`, `commands`, `e2e-cli` |
| adapter conformance | **新增** | `adapter-conformance.test.mjs`(D-13:agy 專屬,`validateProcessAdapter` + 五不變量 + fake-agy shim;**不** import shared `runConformanceSuite`) |

> **`e2e-cli.test.mjs` 必須重 seed**(`e2e-cli.test.mjs:11-16` 現在 import 已刪的 `lib/state.mjs` 的 `resolveJobLogFile`/`ensureStateDir`/`upsertJob`/`writeJobFile`,且 seed 寫舊 flat `jobs/<id>.json` 佈局)——改成寫 shared dir-per-job 佈局。
> 精確的逐檔去留在 plan 落地(依 Phase 1 實際 facade 形狀而定);此處鎖定兩原則:「沒有任何測試被靜默丟失」+ 一個 **grep gate 證明沒有存活模組仍 import 已刪的 `state.mjs`/`atomic-state.mjs`/`job-control.mjs` 等**。

## 11. Phasing overview(spec 級,詳細 code 屬 plan)

| Phase | 交付 | 風險 | 測試閘 |
|---|---|---|---|
| **0** | `sync-shared` vendor `shared/lib` 進 antigravity(零行為變更,無人 import) | 低 | `npm test` + drift check 綠 |
| **1** | `adapter.mjs` + `worker-entry.mjs` + `state.mjs` facade;佈局改 dir-per-job;config 拆分 + 遷移;命令改線;測試重寫 | **最高** | full `npm test`(含 `--experimental-test-module-mocks`)+ e2e + agy conformance 綠 |
| **2**(可選) | 刪除死掉的自家 runtime(agent-runtime/atomic-state/job-control/liveness/poll/_worker/_watchdog) | 中 | 綠 + grep gate |

每 Phase 獨立綠燈可停。Phase 1 過大,plan 會再切子步,並鎖定三個排序原則:
- **Spike-first(graft risk-first):** Phase 1 第一步先建最小 `adapter.mjs`,用 **fake-agy shim + 一次 live `agy --print`** 直接驅動 shared `runWorker`,證明 print-mode → parseEvent 累積 → extractResult join 能讓 job 達 `completed` 且拿到 join 後的 `resultText`,**再**動佈局與命令。
- **Read-only commands first(graft dependency-order):** 先把唯讀命令(status/result)改到 shared facade,再 cancel、wait、logs,最後才是 launch 路徑(task/rescue/review/adversarial-review/image),每個 commit blast radius 最小、suite 綠得最久。
- **RED-until-green 原子窗口:** 刪 `state.mjs`/`atomic-state`/`_worker`/`_watchdog`/`liveness`/`poll` + 測試重寫/刪除必須**當一個原子可 merge 單位**落地(branch 上明確的 red-until-green 窗口),**絕不 push 半套**到會被消費的地方。

## 12. Risks & rollback

- **佈局遷移是最高 blast radius。** 緩解:facade 隔離重寫於 state.mjs 內部;Phase 0 零行為變更先落地;每 Phase 綠燈可回退;race 對抗測試當回歸證明。
- **print-mode → runWorker 映射(D-1)是最不確定點。** 緩解:plan 的 Phase 1 第一步就 spike adapter 並用 fake agy + 一次真 agy 證明 job 達 `completed` 且拿到真文字,再動佈局。
- **OAuth 行為變更(D-3)可能讓習慣「暫停等登入」的使用者困惑。** 緩解:CHANGELOG + 錯誤訊息明確導向 `/antigravity:setup`。
- **CI 不只 `npm test`:** 還有 sync-shared drift check(+ 若 antigravity 納入 tsc 則 build 檢查)。本地三者都要跑。
- **conformance:** antigravity 是完整 worker adopter,做 **full** ProcessAdapter conformance(與 codex 的 subset 不同)。

## 13. Open questions(待 Codex 驗證閘確認)

- **Q1 watchdog 覆蓋確認(codex missing-decision,刪 `_watchdog.mjs` 前必須關閉):** 已決定設 `wantsWatchdog: false`、靠 shared reconcile-per-poll + `reconcileDeadPids`(§7 #4、D-15)。待 plan 確認:shared reconcile(dead-pid + TTL claim-orphan + orphan sweep)是否**完整覆蓋** `liveness.mjs` 的 escalate-not-kill、HUNG 偵測——若有一項未覆蓋,需在 plan 補回或明確接受降級。
- **Q2 真登出 auth 路徑(D-3,NEEDS-VERIFY):** 本機已登入,未登入 agy 的實際 channel(stdout/stderr)與退出碼無法在此驗證。plan 用 fake「unauth」shim(三變體)+ 一次真登出手動驗證釘死。
- **Q3 tsc/build:** antigravity 是否納入任何 tsc checkJs(如 codex 的 `build:codex`)?vendored tree 要 in 還是 out(mirror cc)?
- **Q4 shared 是否需要新 primitive:** 理論上不需要(adapter 全吸收 agy 特性);若真需要,那是 `shared/lib/` 變更(漣漪 cc/codex),必須明確決策而非靜默改。

> 已由 codex review 收斂、不再是 open question 的:config 位置(D-6:stateDir 根)、foreground 串流(D-18:接受不串流)、timeout matrix(D-19)、job id 格式(D-17:採 shared newJobId)、result projection(D-16)、session 隔離(D-14:top-level sessionId)。
