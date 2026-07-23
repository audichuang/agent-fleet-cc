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
- `bin/antigravity.mjs` — dual-host CLI 入口;`scripts/lib/host-detect.mjs` 判斷跑在哪個 host。
- `commands/*.md` — slash verb 的薄殼,只 shell 同名 `scripts/commands/*.mjs`(那才是邏輯,
  `runAsMain` 自呼叫)。例外有二:`handoff.md` 沒有同名 .mjs,殼的是 `rescue.mjs --prompt-file`;
  0.6.0 起 `rescue.md` 是 inline router,經 Agent tool 轉給 `agy-rescue` subagent
  (由 subagent 去 shell `rescue.mjs`)。
- `scripts/lib/adapter.mjs` — **所有 agy 引擎知識**(argv / parseEvent / classifyError);job 生命
  週期是 vendored shared runtime,不在這。
- `agents/openai.yaml` — Codex host 的 implicit-invocation 宣告。
- `agents/agy-rescue.md` — Claude Code 的 proactive thin-forwarder subagent(agy 操作合約
  **內聯**在 agent 本體,不開 skill —— `disable-model-invocation` 的 skill 不能被 `skills:` 預載;
  `commands/rescue.md` 是 inline router,經 Agent tool 轉進來)。合約鎖在
  `tests/antigravity/agent-contract.test.mjs`。

## 進來改要遵守
- **agy 無 conversation id → `sessionId` 恆 `null`**;resume 走 `--continue` / `--conversation`,
  不是 session id(spec D-2)。
- **foreground 不即時串流**,結果在 job 完成後一次呈現(D-18);agy `--print` 本就是一次性回應。
- **`wantsWatchdog: false`** —— 靠 shared reconcile 收死 pid,不自跑 watchdog。
- **寫檔是 opt-in**:rescue/task 預設「文字進、文字出」(adapter 不送寫檔 flag)。`--apply` 才送
  `--new-project --mode accept-edits`,把 job cwd 綁成 agy project 並自動套用編輯 —— 沒它,agy 1.1
  的 `--print` 會把檔案寫到 `~/.gemini/.../scratch`(不是你的 repo)還回 exit 0(假成功,已真機驗證)。
  `--dangerously-skip-permissions` 是第二層 opt-in,gated 在 `--apply` 之後。

## 踩雷
- **verb 行為有五個文案家**:SKILL.md 的 verb 表、`commands/*.md`、README、`agents/openai.yaml` 的
  command descriptions,0.6.0 起 rescue 還多了 `agents/agy-rescue.md`。改 fg/bg 預設、flag、回傳
  形狀時全部都要對 —— 0.5.2 抓到 SKILL.md 把 review/rescue 寫反成 background-by-default,0.5.3 又在
  openai.yaml 抓到同一個錯;rescue 的 agent/router 兩份由 `agent-contract.test.mjs` 鎖住
  (含「文件旗標 ⊆ rescue.mjs parser」的 drift 檢查),其餘仍靠人眼。
- **agy 會背景自我更新**(同 session 實測 1.1.2→1.1.5;證據:`~/.gemini/antigravity-cli/updater/`)。
  別假設引擎版本固定;「已於 X 版真機驗證」的結論要帶版本+日期,引用前先 `agy --version`。
- **有兩個 wait 表面**:`/antigravity:status --wait`(`commands/status.mjs`)**和**獨立的
  `/antigravity:wait`(`commands/wait.mjs`)。改 wait 行為、或加一個 status/wait 欄位(例如
  liveness),**兩支都要動** —— 只改一支必漏(已被 review 抓過一次)。
- 測試種 active job 的「假 pid → 被 reconcile 判 failed」陷阱:見 `e2e-testing` skill,別在這重抄。
- **headless `--print` 沒有硬防寫;review 的唯讀只是 best-effort(靠 prompt)**:`--print` 模式下沒有任何
  硬擋 file write 的機制。實測(1.1.2)打臉兩件事:① `--sandbox` **在 headless 有效**,但只是 OS terminal 容器
  (nsjail,key `enableTerminalSandbox`)——擋 shell 命令、不擋 `write_file`,且模型會自選 `BypassSandbox:true` 繞;
  ② 連真實全域 settings 加 `deny: write_file(*)` 都**照寫** —— 細粒度權限的 deny/ask 清單在 `--print` 觀察到不生效
  (那套 approval 流程是給互動 TUI 的)。所以 review / adversarial-review 的唯讀**只靠 prompt「Do NOT modify files」,
  是 best-effort、不是保證** —— 別把 `--sandbox` 或 settings deny 當硬護欄(舊註解錯過,已修)。真要硬擋只能靠上游
  給 per-run 權限,agy 目前沒有。
  **1.1.5 後續**:上游 changelog 稱 headless 已改為 honor `settings.json` 的 permissions/file access
  (且 1.1.3 起未授權工具會 soft-deny 並印 stderr 提示)—— 1.1.2「連全域 deny 都照寫」的觀察可能已過時,
  重驗 deny 前別再引用它。plugin 端結論**不變**:仍無 per-run 硬擋,review 唯讀照舊是 prompt-only
  best-effort。1.1.5 真機重驗過的是:no-apply 不碰 job cwd、`--apply` 正常寫入(2026-07-22)。

## 細節指向
- 引擎漂移重查:`agy --help` 逐旗比對 `adapter.mjs` 的 `argv.push` 清單 + `agy changelog`
  (1.1.5 起有此子命令)掃行為變更;`agy models` 看模型清單。
- 引擎行為決策 / §7 行為變更 / D-* :`docs/adr/`、
  `docs/superpowers/specs/2026-07-01-antigravity-shared-runtime-migration-design.md`。
- 安裝 / smoke:`plugins/antigravity/docs/{INSTALL,SMOKE}.md`。
