> 共通規則見 repo 根 `AGENTS.md`(IRONCLAD、sync-shared、bump-version+dual-host、CI gate、
> attribution、autonomy 邊界)。本檔只寫 cc 這顆引擎的**增量**。完整結構問 `codegraph explore` / `tree`。

# cc plugin — a headless Claude Code (cc) as a delegatable engine

## 定位
把子任務交給一個 **headless Claude Code 實例**(自己的 `claude` binary)跑。auth / model 由
**profile** 決定:`native`(空 settings = 你自己的帳號 / 原生 claude)、便宜 endpoint、或任意 model。
**dual-host**:Claude Code commander 或 Codex host 都能用(後者透過 `cc-handoff` skill 顯式交棒)。

## 結構角色(判斷,不是清單)
- **無對 commander 的 self-recommend surface** —— Claude Code commander 靠 fleet 的
  `delegating-to-fleet` + model-invocable `/cc:task` 找到它(`skills/cc-handoff` 是給 **Codex host**
  的交棒入口,不是給 commander 的)。
- `scripts/cc-companion.mjs` — CLI 入口(`runCompanion(argv, deps)`,可注入 seam);只 orchestrate:
  parse → job record → 前景 `runWorker` / 背景 `worker-entry.mjs`。
- `scripts/lib/adapter.mjs` — cc 引擎**接線**(argv / parseEvent / classifyError、recursionMarker
  `CLAUDE_CC_ACTIVE`、claude binary 走 `CC_CLAUDE_BIN`);**不含** profile。job 生命週期是 vendored
  shared runtime。
- `scripts/lib/profiles.mjs` — profile 解析 / 驗證(`profiles/<name>.json` = 標準 Claude Code
  settings);選 profile 與 `--model` 覆寫在 companion。
- `scripts/lib/resolve-companion.mjs` — 從 Codex/任意 host 定位 companion,**不寫死路徑、不靠
  plugin-root env**(orca 皆不可靠),改在 cache 目錄有界搜尋 + plugin.json `name==="cc"` 驗證。

## 進來改要遵守
- **cc 的 verb 全部 model-invocable**(`task/status/wait/logs/result/cancel/setup` 都無
  `disable-model-invocation`)—— 跟 grok/codex/agy **相反**;commander 可直接 poll `/cc:status`、
  `/cc:wait`(ADR 0003 靠這個讓 `--background` 委派的死亡可見)。
- **profile / `--settings` 供 settings + env**(`native` = 你現有的 claude login;或便宜 endpoint /
  任意 model),`--model` 可再覆寫 model。單一 profile 自動採用(`setup` 自動建 `native` →
  `/cc:task` 免帶 flag);0 或 2+ 才需 `--profile <name>` / `--settings <path>` / `CC_DEFAULT_PROFILE`。
- 用 **FULL shared runtime**(前景 `runWorker`、背景 `worker-entry.mjs`)—— 同 grok。
- **dual-host**:`.codex-plugin/plugin.json` 帶自己的 version,bump 時會 **silently drift**,要手動
  同步(root AGENTS `bump-version` 節)。

## 踩雷
- **cc 不發 liveness line**:`renderStatus(jobs)` 只印原始 job status(queued / running / completed /
  failed / cancelled / timed-out),**沒有** grok/agy 那種 alive/elapsed liveness 投影 —— 死亡仍可見,
  但沒有 liveness 線(ADR 0002 / 0003)。
- cc 會 spawn 完整 Claude Code,可能 re-trigger delegation router;`CLAUDE_CC_ACTIVE` 設進 engine
  env 擋遞迴,但「keep chains flat」仍是設計指引(fleet `delegating-to-fleet`)。

## 細節指向
- **Phase 3(cc 的 live-shell verb)未做**:接 shared `runWorker` 的 `onLine` hook 即可拿到精確
  串流(同 grok `/grok:live`),見 `docs/adr/0003`。
- 從 Codex host 交棒:`skills/cc-handoff`;profile / setup:`commands/setup.md`。
