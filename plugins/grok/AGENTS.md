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
- **`--read-only` 是 opt-in,不是預設**。預設不塞 `--sandbox` → grok 解析成 `off`(完全無沙箱、
  可讀寫可連網,`config.rs:1132`),維持 0.4.0 前行為。`--read-only` 才送 `--sandbox read-only`。
  **為何 opt-in 而非對齊 codex/antigravity 的預設唯讀**:read-only 是 **best-effort、非硬保證** ——
  (a) 受管 `requirements.toml` profile 會蓋過它(`resolve_profile` 優先序 requirement > CLI,
  `config.rs:1123`);(b) 沒有 OS 後端可套時**降級成可寫並 warn**,不硬失敗(`lib.rs:143`;只有
  read-deny profile 才 exit,`requires_read_deny(ReadOnly)`=false,`lib.rs:359`)。把可能靜默失效的
  保證設成預設會給假安全感,所以做成刻意加固的旗標。**注意**:read-only 只擋 FS 寫入 +
  **子行程**網路;grok 主行程仍上網,in-process `web_search`/`web_fetch` **照常可用**(`lib.rs:10`,
  `streaming_local_terminal.rs:916`)—— 不會打死網路研究。resume 一個**已存不同 profile** 的 session
  加 `--read-only` 會 exit(1)(`SandboxStartup::Conflict`,`cli.rs:883`;無存檔 profile 的舊 session
  則直接套用)。所有 flag/輸出欄位對源碼的錨點見 `docs/grok-cli-contract-audit.md`(含 Codex 複查紀錄)。
- **`wantsWatchdog: false`**。

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
