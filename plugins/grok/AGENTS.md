> 共通規則見 repo 根 `AGENTS.md`(IRONCLAD、sync-shared、bump-version、CI gate、attribution)。
> 本檔只寫 grok 這顆引擎的**增量**。完整結構問 `codegraph explore` / `tree`,別在這窮舉。

# grok plugin — the xAI Grok Build (grok-4.5) engine

## 定位
把委派任務交給 `grok` CLI 一次跑完:自足的一次性子任務、structured JSON 抽取、可 fan-out 的
研究 / 廣掃。便宜(grok-4.5),適合平行 offload。

## 結構角色(判斷,不是清單)
- **無 `SKILL.md` / `README`** —— grok 沒有自我推薦 surface;commander 靠 fleet 的
  `delegating-to-fleet` 路由 + model-invocable `/grok:task` / `/grok:live` 才找得到它
  (見 `docs/adr/0001`)。
- `commands/*.md` — slash verb 的薄殼,每支 shell `scripts/grok-companion.mjs <verb>`。
- `scripts/grok-companion.mjs` — CLI 入口(`runCompanion(argv, deps)`,deps 可注入 seam 測);
  `bin/grok-companion` 是啟動器。
- `scripts/lib/adapter.mjs` — **所有 grok 引擎知識**(argv / parseEvent / sentinels);job 生命
  週期是 vendored shared runtime。

## 進來改要遵守
- **auth 委派給 grok CLI**(`XAI_API_KEY` 或 `~/.grok/auth.json`);companion **絕不碰 secrets、
  無 profile**。無 auth 的 headless run 會卡在裝置碼授權 → `startJob` 有 preflight 直接擋掉。
- **`task` 和 `live` 是 model-invocable**(兩支 delegation entry);`cancel/logs/result/status/wait/setup`
  是 user-run(`disable-model-invocation`)。長任務 watch loop 靠**直接 shell companion** 跑 `wait`,
  不靠 model 觸發那些 verb。
- **`--json-schema` 走非串流**(單一結果物件、無 live `/grok:logs`);一般模式是 `streaming-json`
  (text / end / error 事件;thought / tool 只留在 raw log,不進正規化事件)。
- **`--read-only` 是 opt-in,不是預設**(預設維持 `off`:可讀寫可連網)。刻意做成旗標、不對齊
  codex/antigravity 的預設唯讀,因為 grok 的 read-only 是 **best-effort**(受管 requirements 會蓋過、
  無 OS 後端時 fail-open 成可寫)——把會靜默失效的保證設成預設=假安全感。它**不會**打死網路研究
  (只擋子行程網路,主行程的 web 工具照常)。機制、源碼錨點、resume 行為見
  `docs/grok-cli-contract-audit.md` Part 3(單一正本,別在此重抄)。
- **`wantsWatchdog: false`**。
- **Session id 是 spawn 前預先 mint 的**(`grok-companion.mjs` `startJob` 用 `crypto.randomUUID()`,
  存進 `request.sessionId` 並在 `createJob` 持久化之後才 spawn,worker 中途死掉仍能 `-r` resume)。
  跟 `resumeSessionId`(resume 路徑)**互斥** —— 兩者不會同時送(grok 對 `--session-id` 併
  `--resume` 且無 `--fork-session` 會直接報錯);`adapter.mjs` 的 `else if` 是最後一道防線。
- **`--research` 是兩層不同強度的保證,別混為一談**:內建工具白名單(`--tools`)是**權威**
  取代(白名單外的工具直接不存在),MCP 工具只靠 `--deny MCPTool` **cooperative** 擋,細節/
  錨點見 `docs/grok-cli-contract-audit.md` Part 1(單一正本,別在此重抄)。

## 踩雷
- **fan-out 會洩漏 subagent 文字**:多 agent 跑會把每個 agent 的 text 併成一串、無法 demux
  (實測無論怎麼交代都會漏)。唯一可靠解 —— 叫 leader 用 `<<<GROK_FINAL>>>` / `<<<GROK_END>>>`
  圍住最終報告(見 `commands/task.md`),companion 只取圍欄內的;或 `--no-subagents` 關掉 fan-out。

## 細節指向
- 長任務 watch loop(B1:`--background` + `wait` 輪詢 + exit-code 狀態機 10/0/1/2):
  `commands/task.md`;liveness observability 見 `docs/adr/0002`。
- **live-shell verb**(`/grok:live` → `task --live`):前景 worker 跑的同時,透過 shared `runWorker`
  的 `onLine` hook 把每一行**即時**串到 **stderr**(無 file-tail、無 flush race);最終結果到 stdout、
  失敗時 non-zero exit(死亡可見)。CLI entry 用 `process.exitCode`(非 `process.exit()`)讓 pipe
  自然 flush,否則大量輸出會被截斷。`commands/live.md` 照抄 codex `handoff.md` 的 `run_in_background`
  模式。設計理由/分階 見 `docs/adr/0003`(Phase 2)。fleet 的
  `delegating-to-fleet` 已把可見 / 長任務預設指到 `/grok:live`(durable 仍走
  `/grok:task --background`);再改 fleet 路由仍屬 fleet work-stream,別在 grok
  work-stream 動 fleet。
