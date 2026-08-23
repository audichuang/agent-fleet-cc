> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。
> 本檔只寫 grok 這顆引擎的**增量**。完整結構問 `codegraph explore` / `tree`,別在這窮舉。

# grok plugin — the xAI Grok Build (grok-4.5) engine

## 定位
把委派任務交給 `grok` CLI 一次跑完:自足的一次性子任務、structured JSON 抽取、可 fan-out 的
研究 / 廣掃。便宜(grok-4.5),適合平行 offload。

## 結構角色(判斷,不是清單)
- **無 `SKILL.md` / `README`** —— grok 沒有自我推薦 surface;commander 靠 fleet 的
  `delegating-to-fleet` 路由 + model-invocable `/grok:task` / `/grok:live` 才找得到它
  (見 `docs/adr/0001`)。`/grok:image` 雖然也是 model-invocable,但 fleet 的路由表還沒
  指過來(raster 生圖仍指 `/antigravity:image`),所以目前只是使用者手打的 convenience。
- `commands/*.md` — slash verb 的薄殼,每支 shell `scripts/grok-companion.mjs <verb>`。
- `scripts/grok-companion.mjs` — CLI 入口(`runCompanion(argv, deps)`,deps 可注入 seam 測);
  `bin/grok-companion` 是啟動器。
- `scripts/lib/adapter.mjs` — **所有 grok 引擎知識**(argv / parseEvent / sentinels);job 生命
  週期是 vendored shared runtime。

## 進來改要遵守
- **auth 委派給 grok CLI**(`XAI_API_KEY` 或 `~/.grok/auth.json`);companion **絕不碰 secrets、
  無 profile**。無 auth 的 headless run 會卡在裝置碼授權 → `startJob` 有 preflight 直接擋掉。
- **`task`、`live`、`image` 是 model-invocable**(三支 delegation entry;`image` 是純 prose 疊在
  `task` 上的生圖 verb,沒有自己的 script);`cancel/logs/result/status/wait/setup`
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
- **`image_gen` 的失敗長得像成功**:free / X Basic 這種 tier 在伺服器端被歸零,`image_gen` 直接
  短路、把「升級 SuperGrok」的推銷文當成**成功的** tool result 回來(錨點見
  `docs/grok-cli-contract-audit.md` Part 4)。所以 `/grok:image` 的成功判準是**磁碟上的檔案**
  (存在且非空),不是 grok 說它做完了。2026-08-23 對真 `grok 1.0.5` 實跑過一次(35s、exit 0、
  431KB JPEG):快樂路徑、headless 的 `image_gen` 註冊(出現在 `available_commands`)、tool 事件
  進得了 raw job log、`tool_call_update` **沒有 `toolName`** 欄位、`rawOutput` 是
  `{type:"ImageGen", path, filename, session_folder}` —— 全部核實。**唯一還沒實跑到的**是 tier
  被歸零那條分支(測試帳號有 SuperGrok),所以「短路是否真的讓 job exit 0、沒有 error event」
  仍只有源碼證據;triage 靠 grep `SuperGrok` 子字串(見 `commands/image.md`)。

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
