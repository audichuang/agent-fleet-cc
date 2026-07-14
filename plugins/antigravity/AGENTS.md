> 共通規則見 repo 根 `AGENTS.md`(IRONCLAD、sync-shared、bump-version+dual-host、CI gate、attribution)。
> 本檔只寫 antigravity 這顆引擎的**增量**。完整結構問 `codegraph explore` / `tree`,別在這窮舉。

# antigravity plugin — the Google Antigravity (agy) engine

## 定位
把 host(Claude Code / Codex)委派的任務交給 `agy` CLI 跑:code review、adversarial
review、debug、大 context 調查、raster 圖生成(Imagen,獨立 user-run 的 `image` verb)。
刻意只依賴 `agy` binary —— 撐過已日落的 gemini-cli。

## 結構角色(判斷,不是清單)
- `SKILL.md` — 引擎對**其他 host** 的自我推薦 discovery surface。commander(host Claude Code)
  的路由入口不在這,在 fleet 的 `delegating-to-fleet`(見 `docs/adr/0001`)。
- `bin/antigravity.mjs` — dual-host CLI 入口;`lib/host-detect.mjs` 判斷跑在哪個 host。
- `commands/*.md` — slash verb 的薄殼,只 shell 同名 `scripts/commands/*.mjs`(那才是邏輯,
  `runAsMain` 自呼叫)。
- `lib/adapter.mjs` — **所有 agy 引擎知識**(argv / parseEvent / classifyError);job 生命週期
  是 vendored shared runtime,不在這。
- `agents/openai.yaml` — subagent 宣告。

## 進來改要遵守
- **agy 無 conversation id → `sessionId` 恆 `null`**;resume 走 `--continue` / `--conversation`,
  不是 session id(spec D-2)。
- **foreground 不即時串流**,結果在 job 完成後一次呈現(D-18);agy `--print` 本就是一次性回應。
- **`wantsWatchdog: false`** —— 靠 shared reconcile 收死 pid,不自跑 watchdog。

## 踩雷
- **有兩個 wait 表面**:`/antigravity:status --wait`(`commands/status.mjs`)**和**獨立的
  `/antigravity:wait`(`commands/wait.mjs`)。改 wait 行為、或加一個 status/wait 欄位(例如
  liveness),**兩支都要動** —— 只改一支必漏(已被 review 抓過一次)。
- 測試種 active job 的「假 pid → 被 reconcile 判 failed」陷阱:見 `e2e-testing` skill,別在這重抄。

## 細節指向
- 引擎行為決策 / §7 行為變更 / D-* :`docs/adr/`、
  `docs/superpowers/specs/2026-07-01-antigravity-shared-runtime-migration-design.md`。
- 安裝 / smoke:`plugins/antigravity/docs/{INSTALL,SMOKE}.md`。
