# Worktree ↔ Subagent/Codex cwd 對齊契約 Design

**Goal:** 當 host(Claude Code）開出 worktree、用 subagent 逐 task 開發、再交 Codex review 時,
**強制保證** subagent 與 Codex 的工作目錄與 git 上下文都落在那個 worktree——杜絕「漏回主 repo /
跑錯專案」這類錯誤(已發生過:某次 named workflow 的 args 型別傳錯,fallback 到寫死的別專案預設值,
在錯的 repo 上準備動手)。

**Approved direction(使用者已逐項拍板):**

- 兩個**正交維度**都做,它們是不同維度的思考:
  - **維度 A — Host 調用正確性**:host 在運行時靠驗證點 + 操作紀律保證(載體:可重用 skill)。
  - **維度 B — Workflow 交互契約**:workflow / engine 在腳本層靠 code 契約強制(落在 `plugins/codex/`)。
- A、B **共用同一個「環境對齊不變量」單一事實來源(SSOT)**,差別只在「誰保證、何時保證」。
- 強制驗證點採**兩層縱深防禦**;全線 **fail-fast,零 fallback**(fallback 正是先前 bug 的根源)。

---

## Background / 問題本質

### 機制(為什麼 cwd 是唯一的開關)

(以 `plugins/codex/` 現況為據)

- Codex 的工作區完全由傳入的 `cwd` 決定:`codex-companion.mjs` 的 `resolveCommandCwd`(`:181`,
  有 `--cwd` 用之,否則 `process.cwd()`)→ `resolveWorkspaceRoot` → `git rev-parse --show-toplevel`。
- Codex app-server / broker 進程以該 `cwd` spawn(`app-server.mjs:251`、`broker-lifecycle.mjs:112`),
  env 整包繼承 host 的 `process.env`;每個 thread 也帶 `cwd`(`codex.mjs:82` `buildThreadParams`)。
- broker / job 狀態目錄以 **workspaceRoot 路徑 hash** 為鍵(`state.mjs:56-70`)→ 主 repo 與 worktree
  天然是**兩套獨立 broker / job 狀態**。
- 本 fork 硬編碼 sandbox = `danger-full-access`(`codex.mjs:67-78`,跳過 bwrap)→ Codex **直接在該 cwd
  的真實檔案系統上寫**,cwd 指哪改哪,沒有額外隔離兜底。
- git worktree 對 Codex **透明**:只要 cwd 在 worktree 內,`--show-toplevel` 回 worktree 根,分支 / HEAD /
  index / 檔案 / diff 自動都是 worktree 的。

**結論:整條「host → subagent → codex」鏈,目前靠「繼承 cwd」串起來,沒有任何一處在「強制驗證」。**
任一環節顯式傳錯就破功。

### 兩個容易混淆的事實(寫進 skill 提醒)

- **原生 `EnterWorktree` ≠ 手動 `git worktree add`**:前者開 worktree **並切換整個 session cwd**
  (輸出 "Switched to worktree …"),後續工具與 subagent 預設都在 worktree;後者只在磁碟多開目錄,
  session 仍站在主 repo,需自行進入。**先前 bug 走的是「手動 add + workflow 沒餵 cwd」這條。**
- 「session cwd 切進 worktree」**不等於**「subagent / codex 一定在 worktree」:subagent 繼承但可能內部
  跑掉;codex 經 workflow / 顯式傳參 / 殘留 `CODEX_BROKER_ENDPOINT` 時可能漏回主 repo。

---

## 核心概念:環境對齊不變量(A、B 共用 SSOT)

### 三件套真值(EXPECTED)

host 開 worktree 時鎖定,workflow 以顯式參數 `worktreePath` 往下傳:

- `WT_PATH`:worktree 絕對路徑(canonical / realpath)
- `WT_BRANCH`:worktree 分支名
- `WT_BASE`:開 worktree 當下的 HEAD commit(baseline,用來確認「從對的 base 開」)

### 硬不變量(L2,機器可驗、fail-fast)

> **⚠️ 修正先前對話的草版判定式。** 草版寫 `HEAD == WT_HEAD`,但開發過程 subagent 會 commit、HEAD 會前進,
> 第一個 commit 後就會誤判失敗。正確語義按**時機**分兩種:

**(a) 起點驗證**(剛開 worktree / 建 baseline 時)——確認從對的 base 開、沒漏掉 spec/plan commit:

```bash
a=$(realpath "$(git -C "$CWD" rev-parse --show-toplevel)")
[ "$a" = "$(realpath "$WT_PATH")" ]                        || die "跑錯樹: $a"
[ "$(git -C "$CWD" branch --show-current)" = "$WT_BRANCH" ] || die "分支不符"
[ "$(git -C "$CWD" rev-parse HEAD)" = "$WT_BASE" ]         || die "base 開錯/落後(漏 spec/plan?)"
```

**(b) 交棒過程驗證**(派 subagent / 調 codex / 跑測試 / review 前)——允許 HEAD 前進,但防 detached /
切線 / rebase 掉 baseline:

```bash
a=$(realpath "$(git -C "$CWD" rev-parse --show-toplevel)")
[ "$a" = "$(realpath "$WT_PATH")" ]                        || die "跑錯樹: $a"
[ "$(git -C "$CWD" branch --show-current)" = "$WT_BRANCH" ] || die "分支不符(detached/切線?)"
git -C "$CWD" merge-base --is-ancestor "$WT_BASE" HEAD     || die "baseline 不在歷史(被 reset/rebase 掉)"
```

### 軟對齊清單(checklist,不 gate)

git 管不到、且「不同」往往正常,硬塞 assert 只會誤報——列為提醒,非 gate:

- git-ignored 的 `.env` / 本地 config(新 worktree 不會自動有,需手動補)
- build cache:`node_modules` / `target`(新 worktree 要重裝 / 重編)
- 未提交變更不跨 worktree(要讓 codex 看到 → 先 commit / stash)
- env 污染:`GIT_DIR` / `GIT_WORK_TREE` 覆寫、殘留 `CODEX_BROKER_ENDPOINT` 指向別樹(維度 B 會硬擋)

---

## 維度 A:Host 調用正確性(可重用 skill)

**載體:** skill,寫在 `/home/audichuang/research/audi-skill/worktree-cwd-guard/SKILL.md`
(skill 名暫定 `worktree-cwd-guard`,沿用該 repo「一目錄一 SKILL.md、frontmatter name+description、內文繁中」慣例)。

**skill 規範的流程:**

1. **開 worktree**:用原生 `EnterWorktree`(**禁用**手動 `git worktree add`);開完鎖定三件套
   `WT_PATH / WT_BRANCH / WT_BASE`,並跑一次「起點驗證 (a)」。
2. **每個交棒點先跑「交棒驗證 (b)」**:
   - 派 subagent 前
   - 調 codex 前 — **且顯式帶 `--cwd "$WT_PATH"`,不靠繼承**
   - 跑測試 / e2e 前
   - codex review 前
3. **subagent 信任模型 = 不信任繼承**:每個 subagent 的 prompt **強制第一步自驗** `toplevel(cwd)==WT_PATH`
   且 `branch==WT_BRANCH`,不符就停並回報、不動任何手。skill 附**固定 prompt 範本**供貼用。
4. **失敗即停**:任一 assert 不符 → 立即停、回報實際落點、**絕不在錯的樹上動手**。
5. **常態化回報**:每個交棒後回報實際 `toplevel / branch / HEAD`——把「事後補救的 cwd 檢查」變成每步常態。

**驗證:** skill 內的 assert 片段與 prompt 範本需可直接複製執行;附一個「正例 / 反例」走查段落。

---

## 維度 B:Workflow 交互契約(`plugins/codex/`,兩層縱深)

把不變量從「靠繼承」升級成「腳本層強制」。**受 IRONCLAD 約束:只動 `plugins/codex/` + `tests/codex/`。**

- **B1 — companion 加 `--expected-worktree`(fail-fast 核心)**
  新增參數 / env `CODEX_EXPECTED_WORKTREE`。companion 在 `resolveCommandWorkspace`
  (`codex-companion.mjs:181/259`)解析出 workspaceRoot 後、動任何手之前,跑硬不變量 (b);
  不符就**立即非零退出,絕不 fallback**。直接堵死「args undefined → 套寫死預設」整類 bug。
- **B2 — workflow 模板強制顯式參數**
  named workflow 腳本頂端 `if (!args?.worktreePath) throw`——把隱式預設改成**顯式必填 + fail-fast**;
  每個調 codex 的 stage 把 `worktreePath` 往下傳(`--cwd` + `--expected-worktree`)。
- **B3 — handoff 契約**
  cc→codex 的 handoff payload 一律帶 `{ worktreePath, branch, base }`;codex 端用 B1 驗證後才動手,
  回來時回報自己實際的 workspaceRoot 供 cc 比對。

**兩層縱深:** companion 永遠驗(只要給了 expected)+ workflow 永遠傳。不管調用方是 workflow、直接調、
還是 handoff,都被接住。

---

## 錯誤處理

全線 **fail-fast,零 fallback**:A 的 assert 不符即停;B1 的 companion 不符即非零退出;B2 缺參即 throw。
任何「猜一個預設值繼續跑」的行為一律禁止。

---

## 測試策略

- **維度 B(單元)**:companion 收到不符的 `--expected-worktree` → 斷言**非零退出**且未呼叫 engine;
  workflow 缺 `worktreePath` → throw。
- **維度 B(e2e)**:用 `e2e-testing` 的 fake-engine 框架,黑箱驗證落點與退出碼(expected 不符時不動手)。
- **維度 A**:skill 的 assert 片段 / prompt 範本正確性 + 正反例走查。
- **交付 gate**:完成前跑全 `npm test`(structure + shared + cc + antigravity + codex + fleet + e2e),全綠才交。

---

## 落點與範圍

| 產物 | 位置 |
|---|---|
| 本設計文件 | `agent-fleet-cc/docs/superpowers/specs/2026-06-21-worktree-codex-cwd-contract-design.md` |
| 維度 A skill | `/home/audichuang/research/audi-skill/worktree-cwd-guard/SKILL.md` |
| 維度 B code | `agent-fleet-cc/plugins/codex/`(companion + workflow 模板)+ `tests/codex/` |

**IRONCLAD:** 不碰 `plugins/{antigravity,cc}/` 或其 tests;不改其他 engine。

---

## 非目標 / YAGNI

- **不做 hook 版維度 A**(使用者選 skill);自動攔截式 hook 列為 future。
- **不自動把未提交變更帶過 worktree**——軟清單提醒即可。
- **不改 antigravity / delegate**,也不把 codex 強推 shared runtime。

---

## Open questions(留給 user review)

1. skill 名稱 `worktree-cwd-guard` 可以嗎?還是要更口語的中文友善名?
2. 維度 B 的 `--expected-worktree` 要不要在「未提供 expected」時印一行 warning(提醒調用方沒上保險),
   還是完全靜默(只有給了才驗)?
3. e2e 是否要新增一個「worktree 落點」專屬 case,還是併進既有 codex e2e?
