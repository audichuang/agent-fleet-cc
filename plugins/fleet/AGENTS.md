> 共通規則(IRONCLAD、版本/同步、CI gate、attribution、autonomy 邊界)見 repo 根 `AGENTS.md`。
> 本檔只寫 fleet 這顆 plugin 的**增量**。完整結構問 `codegraph explore` / `tree`,別在這窮舉。

# fleet plugin — the umbrella: routing + onboarding + status board

## 定位
**fleet 不是引擎**(見 `CONTEXT.md` 詞彙表):它自己不跑 job、不 spawn 任何 AI CLI 去做工,只
**讀** 四顆引擎(codex / antigravity / cc / grok)並替 commander 決定「該不該委派、派給誰」。

## 結構角色(判斷,不是清單)
- `skills/delegating-to-fleet/SKILL.md` — **整個 marketplace 唯一的委派路由正本**。commander 靠它
  自動發現所有引擎(`docs/adr/0001`);cross-engine 預設(哪個引擎算「可見」、長任務走哪支 verb)
  也只住這裡。**其他引擎的 work-stream 一律不准改它**(IRONCLAD)—— 引擎自己的檔要提到路由,
  只能寫「fleet 已把 X 指到 Y」並註明改它屬 fleet work-stream。
- `scripts/fleet-status.mjs` — 狀態板。**不 import 引擎的 lib、也不讀它們的 state 目錄**,而是用
  `ENGINE_COMMANDS` 的相對路徑(`../<engine>/scripts/...`)去 shell **各引擎自己的 `status --json`**
  再正規化成統一列。
- `scripts/fleet-doctor.mjs` — 就緒檢查。自帶 ordered probe 規則(**只有** ENOENT 算
  `binary-missing`,其餘算 `version-failed`;spec §5.3)+ 每顆引擎一支 `check<Engine>`,由
  `checkEngine` 分派。
- `scripts/lib/cli-args.mjs` — `CANONICAL` 引擎名單 + `--only` 解析 + raw-arg 字串/`--raw-args-stdin`
  切詞(slash command 把整串參數當一個 argv 丟進來時要用)。

## 進來改要遵守
- **引擎的 `status --json` 形狀是跨 plugin 硬契約**。改某顆引擎的 status 輸出或搬它的入口檔,
  fleet 會**靜默降級**(`normalizeStatus` 走 "unrecognized shape" 分支,只印無法計數的提示),
  不會爆。動引擎 status 就順手跑 `/fleet:status`。
- **加一顆引擎要動 5 處**:`cli-args.mjs` 的 `CANONICAL`、`fleet-status.mjs` 的 `ENGINE_COMMANDS`、
  `fleet-doctor.mjs` 的 `check<Engine>` + `checkEngine` 分派、`commands/setup.md` 的引導文案
  (清單 + 逐引擎修復指引)、`skills/delegating-to-fleet/SKILL.md` 的路由條目。漏一處不會紅,
  只會少一顆。
- **只有 `setup` 是 model-invocable**;`status` / `doctor` 是 user-run(`disable-model-invocation`)
  且 `.md` 裡就是 `!`-前綴直接 shell,模型不在迴路裡 —— 別把它們當可自呼叫的查詢 API。
- **doctor / status 一律唯讀,`setup` 也只准「講」不准「做」**:偵測到缺件只能**建議使用者自己跑
  `/<engine>:setup`**,絕不代跑安裝 / login / 任何 slash command(`setup.md` 逐引擎寫死了這條)。
- **`ready` ≠ 可用**:`fleet-doctor` **從不驗 auth**(每顆引擎都回 `authVerified: false`),
  `ready` 只代表本機前置條件齊了。任何文案都不准把它講成「已登入 / 現在就能跑」。
- **fleet 沒有 vendored shared runtime** —— 它是唯一不在 `sync-shared` TARGETS 裡的 plugin
  (`scripts/sync-shared.mjs`)。改 `shared/lib/` 不需要、也不會同步到這裡。

## 細節指向
- setup 設計 / probe 規則 §5.3:`docs/superpowers/specs/2026-06-18-fleet-setup-design.md`。
- status/doctor 生命週期設計:`docs/superpowers/specs/2026-06-19-fleet-p0-p1-lifecycle-design.md`。
- 委派可見性(為何預設要看得到它跑、看得到它死):`docs/adr/0002`、`docs/adr/0003`。
