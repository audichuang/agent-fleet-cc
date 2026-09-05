> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。
> 本檔只寫 antigravity 這顆引擎的**增量**。完整結構問 `codegraph explore` / `tree`,別在這窮舉。
> agy CLI 合約(逐旗清單、輸出契約、唯讀/寫入姿態、未接的引擎表面、重跑 recipe)的**單一正本**是
> `docs/antigravity-cli-contract-audit.md` —— 別在此重抄。

# antigravity plugin — the Google Antigravity (agy) engine

## 定位
把 host(Claude Code / Codex)委派的任務交給 `agy` CLI 跑:code review、adversarial
review、debug、大 context 調查。
刻意只依賴 `agy` binary —— 撐過已日落的 gemini-cli。

## 結構角色(判斷,不是清單)
- `SKILL.md` — 引擎對**其他 host** 的自我推薦 discovery surface。commander(host Claude Code)
  這邊靠 `agents/agy-rescue.md` 那顆 proactive subagent —— fleet 的 `delegating-to-fleet`
  路由索引已隨 fleet plugin 移除(見 `docs/adr/0001` 的 superseded 註記)。
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
- **寫檔是 opt-in**:rescue/task 預設「文字進、文字出」(adapter 不送寫檔 flag);`--apply` 才綁
  job cwd 並自動套用編輯,`--dangerously-skip-permissions` 是 gated 在它之後的第二層。沒 `--apply`
  時 agy 會寫到 `~/.gemini` scratch 還回 exit 0(假成功)—— 機制見 audit doc Part 3(a)。

## 踩雷
- **verb 行為有五個文案家**:SKILL.md 的 verb 表、`commands/*.md`、README、`agents/openai.yaml` 的
  command descriptions,0.6.0 起 rescue 還多了 `agents/agy-rescue.md`。改 fg/bg 預設、flag、回傳
  形狀時全部都要對 —— 0.5.2 抓到 SKILL.md 把 review/rescue 寫反成 background-by-default,0.5.3 又在
  openai.yaml 抓到同一個錯;rescue 的 agent/router 兩份由 `agent-contract.test.mjs` 鎖住
  (含「文件旗標 ⊆ rescue.mjs parser」的 drift 檢查),其餘仍靠人眼。
- **agy 會背景自我更新**(同 session 實測 1.1.2→1.1.5)。別假設引擎版本固定;**任何「已真機驗證」
  的結論都要帶版本+日期,引用前先 `agy --version`** —— 這條紀律是 audit doc 的 evidence class 由來。
- **有兩個 wait 表面**:`/antigravity:status --wait`(`commands/status.mjs`)**和**獨立的
  `/antigravity:wait`(`commands/wait.mjs`)。改 wait 行為、或加一個 status/wait 欄位(例如
  liveness),**兩支都要動** —— 只改一支必漏(已被 review 抓過一次)。
- 測試種 active job 的「假 pid → 被 reconcile 判 failed」陷阱:見 `e2e-testing` skill,別在這重抄。
- **review / adversarial-review 的唯讀是 prompt-only best-effort,不是保證**:headless `--print`
  沒有 per-run 硬防寫。**`--sandbox` 不是寫入護欄**(它是 nsjail *terminal* 容器:擋 shell 命令、
  不擋 `write_file`,模型還能自選 `BypassSandbox:true` 繞)—— 所以**任何文案都不准把 `--sandbox`
  講成 read-only**。1.1.5 起 headless 會 honor 持久化 `settings.json` 政策,但那是
  **全域**狀態不是 per-run 旗標,結論不變。完整證據鏈/版本分期/待重驗項見 audit doc Part 3。

## 細節指向
- 引擎漂移重查(`agy --version` → `--help` 逐旗比對 → `agy changelog` 掃行為變更 → `agy models`):
  `docs/antigravity-cli-contract-audit.md` §How to keep this current。
- 引擎行為決策 / §7 行為變更 / D-* :`docs/adr/`、
  `docs/superpowers/specs/2026-07-01-antigravity-shared-runtime-migration-design.md`。
- 安裝 / smoke:`plugins/antigravity/docs/{INSTALL,SMOKE}.md`。
