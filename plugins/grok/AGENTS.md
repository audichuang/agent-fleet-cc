> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。
> 本檔只寫 grok 這顆引擎的**增量**。完整結構問 `codegraph explore` / `tree`,別在這窮舉。

# grok plugin — the xAI Grok Build (grok-4.5) engine

## 定位
把委派任務交給 `grok` CLI 一次跑完:自足的一次性子任務、structured JSON 抽取、可 fan-out 的
研究 / 廣掃。便宜(grok-4.5),適合平行 offload。

## 結構角色(判斷,不是清單)
- **無 `SKILL.md` / `README`** —— grok 沒有自我推薦 surface;commander 靠 fleet 的
  `delegating-to-fleet` 路由 + model-invocable `/grok:task` / `/grok:live` 才找得到它
  (見 `docs/adr/0001`)。**生圖不在這顆**:`/grok:image` 已於 0.8.0 移除,搬去 `imagine` plugin
  (預設 `--engine grok` 直接打 xAI 的 HTTP API;另有 `--engine agy`)。理由見那顆的 `AGENTS.md`。
- `commands/*.md` — slash verb 的薄殼,每支 shell `scripts/grok-companion.mjs <verb>`。
- `scripts/grok-companion.mjs` — CLI 入口(`runCompanion(argv, deps)`,deps 可注入 seam 測);
  `bin/grok-companion` 是啟動器。
- `scripts/lib/adapter.mjs` — **所有 grok 引擎知識**(argv / parseEvent / sentinels);job 生命
  週期是 vendored shared runtime。

## 進來改要遵守
- **auth 完全委派給 grok CLI**,companion **絕不碰 secrets、無 profile、也不做 preflight**。
  1.0.5 的 headless 路徑是 **fail closed**:`authenticate` 沒解到 non-interactive 方法就直接
  bail(`xai-grok-pager/src/headless.rs:459-480`,doc comment 明寫 "failing closed";訊息在
  `:445-457` `auth_required_message`),毫秒級失敗且訊息比我們自己寫的更可用(指名
  `grok login --device-code` / `XAI_API_KEY`),`classifyError` 也照樣標成 `auth`。
  **但那個 fail-closed 只管「方法選擇」那一層** —— 一個 advertised 但已死的 cached token 仍會
  走到互動式 OAuth 並卡住(有界,但看不見)。機制、錨點與重驗食譜在
  `docs/grok-cli-contract-audit.md` 的 auth 列(reading 4)+ startup-silence 列,**別在此重抄**
  (root `AGENTS.md`:引擎知識改 audit doc)。這裡只要記住兩件會影響你改碼的事:
  headless 碰得到互動式登入,而且**加 preflight 蓋不到它**(舊的那顆只做 `existsSync`)。
  蓋它的是 opt-in 的 stall guard(`adapter.mjs` 的 `firstEventTimeoutMs`,預設不啟用)。
  **不要再加 gate**:grok 的憑證解析包含 per-model `api_key`/`env_key`、OS 解析的 home 等,
  重寫一遍只會誤拒有效設定又放行 grok 用不了的憑證(0.6.0 那顆 preflight 兩件都犯了)。
  `setup` 只**報告**看得見的來源(env keys + auth 檔),**不 gate 任何東西**。
- **`task`、`live` 是 model-invocable**(兩支 delegation entry);`cancel/logs/result/status/wait/setup`
  是 user-run(`disable-model-invocation`)。長任務 watch loop 靠**直接 shell companion** 跑 `wait`,
  不靠 model 觸發那些 verb。
- **`--json-schema` 走非串流**(單一結果物件、無 live `/grok:logs`);一般模式是 `streaming-json`
  (text / end / error 事件;thought / tool 只留在 raw log,不進正規化事件)。
- **`--read-only` 是 opt-in,不是預設**(預設維持 `off`:可讀寫可連網)。刻意做成旗標、不對齊
  codex/antigravity 的預設唯讀,因為它**既可能拒絕啟動、也可能靜默不生效**——把這種保證設成
  預設 = 假安全感。它**不會**打死網路研究(只擋子行程網路,主行程的 web 工具照常)。
  兩種失效各自的機制、宿主前置條件、源碼錨點與 resume 行為是**版本相關**的,正本在
  `docs/grok-cli-contract-audit.md` Part 3 —— 學到新東西改那份,別在此重抄(root `AGENTS.md`)。
- **`wantsWatchdog: false`**。
- **Session id 是 spawn 前預 mint、先持久化才 spawn 的**(crash-safe resume),且與 resume 路徑
  **互斥**(兩旗標絕不同送)。機制與源碼錨點見 `docs/grok-cli-contract-audit.md` Part 1 的 `-s` 列(單一正本,別在此重抄)。
- **`--research` 是兩層不同強度的保證,別混為一談**:內建工具白名單(`--tools`)是**權威**
  取代(白名單外的工具直接不存在),MCP 工具只靠 `--deny MCPTool` **cooperative** 擋,細節/
  錨點見 `docs/grok-cli-contract-audit.md` Part 1(單一正本,別在此重抄)。

## 踩雷
- **fan-out 會洩漏 subagent 文字**:多 agent 跑會把每個 agent 的 text 併成一串、無法 demux
  (實測無論怎麼交代都會漏)。唯一可靠解 —— 叫 leader 用 `<<<GROK_FINAL>>>` / `<<<GROK_END>>>`
  圍住最終報告(見 `commands/task.md`),companion 只取圍欄內的;或 `--no-subagents` 關掉 fan-out。
- **`image_gen` 的失敗長得像成功** —— 這顆已經不用它了(生圖搬去 `imagine` plugin),但如果你
  想再從 companion 走生圖:free / X Basic 那種 tier 在伺服器端被歸零,`image_gen` 會短路、把
  「升級 SuperGrok」的推銷文當成**成功的** tool result 回來,job 本身完全健康。整套實測證據與
  wire shape(`tool_call_update` 沒有 `toolName`、`rawOutput` 是
  `{type:"ImageGen", path, filename, session_folder}`)留在
  `docs/grok-cli-contract-audit.md` Part 4,標成 superseded。**這正是搬走的理由**:那條路的
  成功判準只能靠讀 raw stream 猜。

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
