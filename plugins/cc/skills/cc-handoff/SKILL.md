---
name: cc-handoff
description: Hand a subtask FROM a Codex host TO a headless Claude Code (cc) worker and return the result. Use ONLY when the user explicitly assigns a subtask to Claude ("hand this to Claude", "run this with cc", "交給 Claude 跑") — never as automatic offloading.
---

# cc-handoff — 把子任務交給 Claude Code worker

當使用者在 prompt 裡**明確指派**某段工作給 Claude（例如「這部分交給 Claude 跑」）時,用本流程把它 handoff 給 headless Claude Code（cc),前景同步拿回結果再繼續。**非明確指派時不要自行外包。**

## 步驟

### 0. 定位 cc-companion（主路徑:PATH;退路:搜尋）

先試 PATH 的 launcher:

```bash
if command -v cc-companion >/dev/null 2>&1; then
  CC=(cc-companion)                 # PATH launcher(主路徑)— bash array,安全帶空白路徑
else
  # 退路:tier 優先,在已知 cache 根下依序找 cc plugin(cc-companion.mjs + 相鄰 .codex-plugin name=cc)。
  # 第一個命中的 base 勝。-maxdepth 5:cache/<mkt>/cc/<ver>/scripts/cc-companion.mjs 從 base 起是第 5 層
  # (orca 的 $CODEX_HOME/.tmp/plugins/plugins/cc/scripts/… 是第 3 層,5 也涵蓋)。
  CC=()
  for base in "${CODEX_HOME:-/nonexistent}/.tmp/plugins/plugins" "${CODEX_HOME:-/nonexistent}/plugins/cache" \
              "$HOME/.codex/plugins/cache" "$HOME/.claude/plugins/cache"; do
    [ -d "$base" ] || continue
    while IFS= read -r f; do
      root="$(dirname "$(dirname "$f")")"
      if grep -q '"name"[[:space:]]*:[[:space:]]*"cc"' "$root/.codex-plugin/plugin.json" 2>/dev/null \
         || grep -q '"name"[[:space:]]*:[[:space:]]*"cc"' "$root/.claude-plugin/plugin.json" 2>/dev/null; then
        CC=(node "$f"); break
      fi
    done < <(find "$base" -maxdepth 5 -type f -name cc-companion.mjs 2>/dev/null)
    [ ${#CC[@]} -gt 0 ] && break
  done
  [ ${#CC[@]} -gt 0 ] || { echo "cc plugin 未安裝或 cc-companion 不在預期路徑"; exit 1; }
fi
```

### 1. 釘住工作目錄與環境（V-2 / V-3）

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
# 必設 CC_PLUGIN_DATA —— 否則被 codex 環境的 CLAUDE_PLUGIN_DATA 拖走,profile 找不到
export CC_PLUGIN_DATA="${CC_PLUGIN_DATA:-$HOME/.claude/plugins/data/cc}"
```

### 2. 備妥 prompt（temp file,絕對路徑）

把交給 Claude 的子任務寫成**完整、自足**的指令(檔案、約束、完成定義都講清楚),寫進 temp file:

```bash
TMP="$(mktemp /tmp/cc-handoff.XXXXXX.md)"
cat > "$TMP" <<'EOF'
[完整子任務指令]
EOF
```

### 3. 記錄改檔前狀態（V-5 delegated-write)

```bash
BEFORE="$(cd "$PROJECT_ROOT" && git status --porcelain --untracked-files=all 2>/dev/null)"
```

### 4. 同步 spawn（在專案根 cwd,傳絕對 prompt 路徑）

```bash
OUT="$(cd "$PROJECT_ROOT" && "${CC[@]}" task --prompt-file "$TMP" --json 2>/tmp/cc-handoff.err)"
RC=$?
```

- 預設權限可寫（`bypassPermissions`）。只有使用者要求「不要用 bypass 權限」時,在 `task` 後加 `--read-only`（語意:改用 claude 預設權限模式,**非**保證禁寫)。
- 不帶 `--profile`(單一 profile auto-select)。本流程**不**用背景模式。

### 5. 讀回結果（先解析 JSON,失敗再分類；V-4）

- `$OUT` 應是**單行 JSON**;先 `JSON.parse`,取 `status`/`resultText`/`error`/`errorKind`。
- 若 `$OUT` 不是合法 JSON:
  - stdout 開頭是 `cc: ...` → **前置 Profile/Usage error**(根本沒跑 claude)。指引使用者跑 `"${CC[@]}" setup`(自動建 native profile)或設 `CC_DEFAULT_PROFILE`,**可安全重試**。
  - `/tmp/cc-handoff.err` 有 stack → **runtime crash**:回報錯誤,**不**重跑。
- 若 `status == "completed"`:把 `resultText` 帶回繼續。
- 否則(已執行但非 completed):回報 `error`/`errorKind`,**不要**換 profile 重跑(失敗 job 可能已有 side effect)。

### 6. 回報改了哪些檔（V-5)

```bash
AFTER="$(cd "$PROJECT_ROOT" && git status --porcelain --untracked-files=all 2>/dev/null)"
```

比對 `$BEFORE` 與 `$AFTER`,把 claude 改動/新增的檔列給使用者(cc 預設可寫、無二次確認)。非 git workspace 則明說「無法可靠列舉改了哪些檔」,並提醒使用者:此 handoff 預設可寫,若要唯讀請加 `--read-only`。

### 7. 清理

```bash
rm -f "$TMP" /tmp/cc-handoff.err
```

> 本 skill 只寫「每個動作怎麼用」,不含「如何替 claude 組 prompt」的方法論(claude 不像 GPT-5.5 需要官方 prompting guide)。profile 怎麼建是 `setup` 的事 —— 找不到 / 0 profile 時指引使用者跑 `"${CC[@]}" setup` 或設 `CC_DEFAULT_PROFILE`,**不**引用 Claude-only 的 `/cc:setup`(因 codex 宿主沒有 slash command)。
> skill body 是給 codex(GPT-5.5)讀的**操作手冊**,本身不可執行;真正會被執行的是它指引 codex 去跑的 resolver 片段與 cc-companion 呼叫。
