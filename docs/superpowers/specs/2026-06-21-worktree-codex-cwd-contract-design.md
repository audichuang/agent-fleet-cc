# Worktree ↔ Subagent/Codex cwd 對齊契約 Design

> **v2 — 已納入 Codex 對抗式設計審查的全部發現**(blocker ×3 + major ×4 + minor ×1)。
> 主要修正:expected 改 all-or-none triplet;broker env 防線真正接上(且修正 env 名稱);
> subagent enforcement 誠實降級(hard gate 來自 host preflight + companion gate);
> `GIT_DIR/GIT_WORK_TREE` 從軟清單升級為硬 sanitize;validation 用 git hard check 不信 fallback。

**Goal:** 當 host(Claude Code）開出 git worktree、用 subagent 逐 task 開發、再交 Codex review 時,
**強制保證** Codex(engine 層）與盡力保證 subagent 的工作目錄與 git 上下文落在那個 worktree——杜絕
「漏回主 repo / 跑錯專案」這類錯誤(已發生過:某次 named workflow 的 args 型別傳錯,fallback 到寫死的
別專案預設值,差點在錯的 repo 上動手)。

**Approved direction(使用者已逐項拍板):**

- 兩個**正交維度**都做:
  - **維度 A — Host 調用正確性**:host 運行時紀律(載體:可重用 skill)。**真正的 hard gate 是
    host preflight + companion gate;subagent 自驗是 best-effort 補強,不是 enforcement。**
  - **維度 B — Workflow/Engine 契約**:engine 層在 companion 硬驗(落在 `plugins/codex/`)。
- A、B 共用同一個「環境對齊不變量」SSOT;判定用 **all-or-none triplet**`(WT_PATH, WT_BRANCH, WT_BASE)`。
- 強制驗證採**兩層縱深**:呼叫方顯式傳 triplet(host 側)+ companion 收到就硬驗(engine 側)。
- 全線 **fail-fast、零 fallback**;`expected` 模式下**清除會干擾落點的 env**。

---

## Background / 問題本質

### 機制(為什麼 cwd 是唯一的開關)

(以 `plugins/codex/` 現況為據)

- Codex 工作區由傳入 `cwd` 決定:`codex-companion.mjs` 的 `resolveCommandCwd`(`:181`,有 `--cwd` 用之,
  否則 `process.cwd()`)→ `resolveWorkspaceRoot` → `git rev-parse --show-toplevel`。
  ⚠️ **但 `resolveWorkspaceRoot`(`workspace.mjs:3`)在非 git repo 時會吞錯、把 cwd 原樣回傳**——
  它**不是**可靠的 git toplevel oracle,validation 不可信它(見維度 B)。
- Codex app-server / broker 進程以該 `cwd` spawn(`app-server.mjs:251`、`broker-lifecycle.mjs:112`),
  **env 整包繼承 host 的 `process.env`**(`process.mjs:4`);每個 thread 也帶 `cwd`(`codex.mjs:82`)。
- broker / job 狀態目錄以 **workspaceRoot 路徑 hash** 為鍵(`state.mjs:56-70`)→ 主 repo 與 worktree
  天然是兩套獨立 broker / job 狀態。
- ⚠️ **broker endpoint env 優先於 cwd**:`CodexAppServerClient.connect`(`app-server.mjs:396`)會優先採用
  env 指定的 endpoint(實際常數為 **`CODEX_COMPANION_APP_SERVER_ENDPOINT`**,動工前以源碼為準再核對一次),
  **不看 cwd**。⇒ 即使 cwd 對、assert 過,只要這個 env 殘留指向別樹 broker,Codex 仍可能在別樹動手。
- 本 fork 硬編碼 sandbox = `danger-full-access`(`codex.mjs:67-78`,跳過 bwrap）→ Codex **直接寫真實 FS**,
  fail-fast 必須**早於任何 thread start / 寫入**。
- git worktree 對 Codex 透明:cwd 在 worktree 內,`--show-toplevel` 即回 worktree 根。

**結論:整條鏈目前靠「繼承 cwd」串起,沒有一處強制驗證;且 broker env 與非 git fallback 是兩個暗門。**

### 兩個容易混淆的事實(寫進 skill 提醒)

- **原生 `EnterWorktree` ≠ 手動 `git worktree add`**:前者開 worktree **並切換 session cwd**
  (輸出 "Switched to worktree …"），後續工具與 subagent 預設都在 worktree;後者只開目錄、session 仍在主 repo。
  **先前 bug 走的是「手動 add + workflow 沒餵 cwd」這條。**
- 「session cwd 在 worktree」**不等於**「subagent / codex 一定在 worktree」。

---

## 核心概念:環境對齊不變量(A、B 共用 SSOT)

### 三件套真值(all-or-none triplet)

host 開 worktree 時鎖定,呼叫方以**顯式參數整組**往下傳(缺任一即 fail-fast,不得只傳其一):

- `WT_PATH`:worktree 絕對路徑(canonical / realpath)
- `WT_BRANCH`:worktree 分支名
- `WT_BASE`:開 worktree 當下的 HEAD commit(穩定 baseline)

> handoff / queued payload 欄位命名 **`worktreePath` / `worktreeBranch` / `worktreeBase`**——
> **刻意不叫 `base`**,以免和 review 既有的 `--base`(diff base)混淆。

### 硬不變量(L2,機器可驗、fail-fast)

**前置(每次判定都先做)——sanitize git 控制 env**,否則 `GIT_DIR/GIT_WORK_TREE` 會綁架判定:

```bash
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR   # 不然 git -C 的 toplevel/branch 會被環境劫持
top=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) \
  || die "不在 git repo(拒絕 fallback 成 cwd)"     # 直接 git hard check,不經 resolveWorkspaceRoot
```

**(a) 起點驗證**(剛開 worktree / 建 baseline）——確認從對的 base 開、沒漏 spec/plan commit:

```bash
[ "$(realpath "$top")" = "$(realpath "$WT_PATH")" ]        || die "跑錯樹: $top"
[ "$(git -C "$CWD" branch --show-current)" = "$WT_BRANCH" ] || die "分支不符"
[ "$(git -C "$CWD" rev-parse HEAD)" = "$WT_BASE" ]         || die "base 開錯/落後(漏 spec/plan?)"
```

**(b) 交棒驗證**(派 subagent / 調 codex / 跑測試 / review 前）——允許 HEAD 前進,但防 detached / 切線 / reset：

```bash
[ "$(realpath "$top")" = "$(realpath "$WT_PATH")" ]        || die "跑錯樹: $top"
[ "$(git -C "$CWD" branch --show-current)" = "$WT_BRANCH" ] || die "分支不符(detached/切線?)"
git -C "$CWD" merge-base --is-ancestor "$WT_BASE" HEAD     || die "baseline 不在歷史(被 reset/rebase 掉)"
```

### 軟對齊清單(checklist,不 gate)

> ⚠️ `GIT_DIR/GIT_WORK_TREE` **已從這裡移除**——它們會污染硬判定,升級為上面的硬 sanitize。

剩下純屬「正常會不同、無法單點斷言」的項,僅提醒:

- git-ignored 的 `.env` / 本地 config(新 worktree 不會自動有,需手動補)
- build cache:`node_modules` / `target`(新 worktree 要重裝 / 重編)
- 未提交變更不跨 worktree(要讓 codex 看到 → 先 commit / stash)

### 已知限制(Codex 點出,記錄而非假裝解決)

- **TOCTOU**:validation 與 Codex thread start 之間,branch/path 仍可能被移動或切換。緩解:把驗證盡量貼近
  thread start(維度 B 的攔截點),不消除窗口。
- **repo identity**:`path + branch + base` 無法辨識「worktree 被刪、又用同 path + 同 branch/base 重建」。
  視為已知限制;若未來要更嚴,可加 `.git/worktrees/<id>` gitdir 指紋(列 future)。
- **`--resume-last` / thread list** 在 foreign broker 或錯誤 state root 下,可能續到別 workspace 的 thread。
  維度 B 的「expected 模式清 env」可緩解;完整解需 broker handshake(future)。

---

## 維度 A:Host 調用正確性(可重用 skill)

**載體:** skill,寫在 `/home/audichuang/research/audi-skill/worktree-cwd-guard/SKILL.md`
(沿用該 repo「一目錄一 SKILL.md、frontmatter name+description、內文繁中」慣例)。

**真正的 hard gate(誠實表述):**
1. **host preflight** — host 在派 subagent / 調 codex 前,自己跑 L2(b)。因為 subagent 繼承 host cwd,
   host 確認自己在 worktree,就是 subagent cwd 的真正保證來源。
2. **companion gate** — 見維度 B(B1),engine 層硬驗。

**subagent 自驗 = best-effort 補強(非 enforcement):**
每個 subagent 的 prompt 附**固定範本**,要求第一步自驗 `toplevel(cwd)==WT_PATH` 且 `branch==WT_BRANCH`,
不符就停並回報。明說:這是**抓「subagent 內部 `cd` 跑掉」的盡力補強,不是強制機制**;prompt 不能保證被遵守,
真正擋線的是上面兩個 hard gate。

**skill 規範的流程:**
1. 用原生 `EnterWorktree`(**禁用**手動 `git worktree add`);鎖定 triplet `WT_PATH/WT_BRANCH/WT_BASE`,
   跑一次「起點驗證 (a)」。
2. 每個交棒點 host 先跑「交棒驗證 (b)」:派 subagent 前、調 codex 前(顯式帶整組 triplet,不靠繼承)、
   跑測試/e2e 前、codex review 前。
3. 派 subagent 時附自驗 prompt 範本(best-effort 補強)。
4. 失敗即停、回報實際落點、絕不在錯的樹上動手。
5. 常態化回報每個交棒後實際 `toplevel / branch / HEAD`。

**hook 仍為 non-goal**(使用者選 skill 不選 hook)。

---

## 維度 B:Engine 契約(`plugins/codex/`,companion 硬驗)

**受 IRONCLAD 約束:只動 `plugins/codex/` + `tests/codex/`。**

- **B1 — companion expected-triplet gate(核心 hard gate)**
  companion 接受 **all-or-none triplet**:`--expected-worktree --expected-branch --expected-base`
  (或單一 JSON env)。給了任一就必須三個都給,否則 fail-fast。
  在 `resolveCommandWorkspace`(`:181/:259`)之後、**早於 `withAppServer` / thread start / 任何寫入**:
  - 先 sanitize `GIT_DIR/GIT_WORK_TREE`,用 **git hard check**(不信 `resolveWorkspaceRoot` 的 fallback)跑 L2(b);
  - **`expected` 模式下清除/忽略 `CODEX_COMPANION_APP_SERVER_ENDPOINT`**(動工前再核對實際常數名),
    強制用 cwd 解出的 broker,杜絕「assert 過卻連去別樹 broker」;
  - 不符 → **立即非零退出,絕不 fallback**。
- **B1b — background worker 二次驗**
  worker spawn 目前只傳 `--cwd/--job-id`、queued request 只存 cwd/model/prompt/write/resume
  (`codex-companion.mjs:687/727/912`)。把 triplet **寫入 queued request**,`task-worker` 啟動後、
  執行前**再跑一次 B1 的驗證**(背景路徑不能漏接 CLI 契約)。
- **B2 — 呼叫方顯式傳 triplet(調用契約,主要落 host 側)**
  「缺 triplet 即 fail-fast」的責任在**呼叫方**:host named workflow(**不在 codex plugin、不受 IRONCLAD**)、
  以及維度 A 的 skill。codex plugin 內的 command templates(markdown 吃 `$ARGUMENTS`,如 `task.md`、`handoff.md`)
  **不會自動補 `--cwd`/triplet**;若要讓 slash command 也走契約,需顯式改 command template 接受並轉傳這些旗標
  (列為選配)。**codex plugin 這側的真防線是 B1,不依賴 B2。**
- **B3 — handoff payload + template**
  cc→codex handoff 帶 `{ worktreePath, worktreeBranch, worktreeBase }`;codex 端經 B1 驗後才動手,
  回來時回報自己實際的 workspaceRoot 供 cc 比對。對應改 `commands/handoff.md` 模板(在 IRONCLAD 範圍內)。
- **(future)broker handshake 驗 workspaceRoot** — broker 連上後回報自身 workspaceRoot,companion 比對不符即拒連。
  最強(連 foreign broker 都擋),但需改 broker 協議;本期不做,列 future。

---

## 錯誤處理

全線 **fail-fast、零 fallback**:A 的 assert 不符即停;B1/B1b 不符即非零退出且未呼叫 engine;
呼叫方缺 triplet 即報錯。任何「猜預設值繼續跑」一律禁止。

---

## 測試策略

- **維度 B(單元)**:
  - companion 收到不符的 triplet → 斷言**非零退出**且**未呼叫 engine**(早於 thread start)。
  - 只傳部分 triplet → fail-fast(all-or-none)。
  - `expected` 模式下設了 `CODEX_COMPANION_APP_SERVER_ENDPOINT` → 斷言被清除/忽略。
  - 設了 `GIT_DIR/GIT_WORK_TREE` → 斷言判定不被劫持(sanitize 生效)。
  - 非 git repo 的 cwd → 斷言 hard check 直接失敗(不 fallback 成 cwd)。
  - background:triplet 入 queued request → `task-worker` 啟動後二次驗;不符即終止 job。
- **維度 B(e2e)**:用 `e2e-testing` 的 fake-engine 框架黑箱驗落點與退出碼。
  - **foreign-broker smoke(Need to verify)**:Codex 指出「real app-server 是否完全尊重 per-thread cwd」
    本 repo 無法證明;需一個對真 Codex 的 smoke,確認連到別樹 broker 時會被 B1 的清 env 擋下。
- **SSOT 防 drift(minor)**:A 的 shell 片段與 B 的 JS 實作**共用同一組 test vectors / fixture cases**
  (同一批正反例餵兩邊),避免兩份不變量邏輯分叉。
- **維度 A**:skill 的 assert 片段 / prompt 範本正確性 + 正反例走查。
- **交付 gate**:完成前跑全 `npm test`(structure + shared + cc + antigravity + codex + fleet + e2e),全綠才交。

---

## 落點與範圍

| 產物 | 位置 |
|---|---|
| 本設計文件 | `agent-fleet-cc/docs/superpowers/specs/2026-06-21-worktree-codex-cwd-contract-design.md` |
| 維度 A skill | `/home/audichuang/research/audi-skill/worktree-cwd-guard/SKILL.md` |
| 維度 B code | `agent-fleet-cc/plugins/codex/`(companion gate + worker 二次驗 + `commands/handoff.md`)+ `tests/codex/` |
| B2 呼叫契約(host 側) | host named workflow / 維度 A skill —— **不在** codex plugin、不受 IRONCLAD |

**IRONCLAD:** 不碰 `plugins/{antigravity,cc}/` 或其 tests;不改其他 engine。

---

## 非目標 / YAGNI

- **不做 hook 版維度 A**(使用者選 skill);自動攔截式 hook 列 future。
- **不做 broker handshake 驗 workspaceRoot**(本期);列 future。
- **不做 repo-identity gitdir 指紋**(本期);列已知限制 / future。
- **不自動把未提交變更帶過 worktree**——軟清單提醒即可。
- **不改 antigravity / delegate**,也不把 codex 強推 shared runtime。

---

## Open questions(留給 user review)

1. skill 名稱 `worktree-cwd-guard` 可以嗎?還是要更口語的中文友善名?
2. 要不要連 codex plugin 的 slash command templates(`task.md`/`handoff.md`)也改成顯式接 triplet 旗標
   (B2 選配),還是本期只做 B1/B1b/B3、command 契約留待之後?
3. e2e 的 foreign-broker smoke 需要真 Codex(非 fake-engine);本期就建,還是先標 Need-to-verify、留 follow-up?
