> 共通規則見 repo 根 `AGENTS.md`(IRONCLAD、sync-shared、bump-version、CI gate、attribution)。
> 本檔只寫 grok 這顆引擎的**增量**。完整結構問 `codegraph explore` / `tree`,別在這窮舉。

# grok plugin — the xAI Grok Build (grok-4.5) engine

## 定位
把委派任務交給 `grok` CLI 一次跑完:自足的一次性子任務、structured JSON 抽取、可 fan-out 的
研究 / 廣掃。便宜(grok-4.5),適合平行 offload。

## 結構角色(判斷,不是清單)
- **無 `SKILL.md` / `README`** —— grok 沒有自我推薦 surface;commander 靠 fleet 的
  `delegating-to-fleet` 路由 + model-invocable `/grok:task` 才找得到它(見 `docs/adr/0001`)。
- `commands/*.md` — slash verb 的薄殼,每支 shell `scripts/grok-companion.mjs <verb>`。
- `scripts/grok-companion.mjs` — CLI 入口(`runCompanion(argv, deps)`,deps 可注入 seam 測);
  `bin/grok-companion` 是啟動器。
- `scripts/lib/adapter.mjs` — **所有 grok 引擎知識**(argv / parseEvent / sentinels);job 生命
  週期是 vendored shared runtime。

## 進來改要遵守
- **auth 委派給 grok CLI**(`XAI_API_KEY` 或 `~/.grok/auth.json`);companion **絕不碰 secrets、
  無 profile**。無 auth 的 headless run 會卡在裝置碼授權 → `startJob` 有 preflight 直接擋掉。
- **只有 `task` 是 model-invocable**;`cancel/logs/result/status/wait/setup` 是 user-run
  (`disable-model-invocation`)。長任務 watch loop 靠**直接 shell companion** 跑 `wait`,不靠
  model 觸發那些 verb。
- **`--json-schema` 走非串流**(單一結果物件、無 live `/grok:logs`);一般模式是 `streaming-json`
  (text / end / error 事件;thought / tool 只留在 raw log,不進正規化事件)。
- **`wantsWatchdog: false`**。

## 踩雷
- **fan-out 會洩漏 subagent 文字**:多 agent 跑會把每個 agent 的 text 併成一串、無法 demux
  (實測無論怎麼交代都會漏)。唯一可靠解 —— 叫 leader 用 `<<<GROK_FINAL>>>` / `<<<GROK_END>>>`
  圍住最終報告(見 `commands/task.md`),companion 只取圍欄內的;或 `--no-subagents` 關掉 fan-out。

## 細節指向
- 長任務 watch loop(B1:`--background` + `wait` 輪詢 + exit-code 狀態機 10/0/1/2):
  `commands/task.md`;liveness observability 見 `docs/adr/0002`。
