# Phase 2B — Delegate 移植到共享地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** delegate 跑在 ProcessAdapter + shared core 上,companion 對齊機器層 CLI 合約(§2),vendor+drift check 上線,delegate 全套測試與 conformance 十劇本全綠。

**Architecture:** ClaudeAdapter(引擎知識)+ vendored shared(job runtime)。companion 重構為薄 CLI:task/wait/logs/status/result/cancel/setup 七動詞,`--json` 輸出統一 schema 投影。舊 lib 五檔(state/claude/worker/env/job-control)刪除,行為守護由 tests/shared 與更新後的 companion 測試接手。

**Tech Stack:** Node ≥22.3、`node --test`、零外部依賴。

**Spec:** `docs/specs/2026-06-12-phase2-shared-foundation-design.md`(§2 CLI 合約、§3 schema、§5 地基、§8 step 2)。
**前置:** Plan A 已收工(main `0970c26`);本 plan 在 `phase2b-delegate` 分支執行。
**計畫鏈:** A(已完成)→ **B(本檔)** → C(antigravity)→ D(codex+fleet)。

---

## 基線(Task 0 填寫)

- 既有測試基線(Task 0 記錄,`npm test` exit=0,五套全綠,共 717 tests):
  - structure: tests=2 pass=2 fail=0
  - shared: tests=76 pass=76 fail=0
  - delegate: tests=91 pass=91 fail=0
  - antigravity: tests=243 pass=243 fail=0
  - codex: tests=305 pass=305 fail=0
- 已知 flaky:`tests/codex/runtime.test.mjs` 曾偶發(expected design-challenger got thr_2),單跑/重跑綠,非本工作引入——審查者遇到時重跑一次確認,不算新失敗。本次基線跑未觸發,codex 全綠。

## 鐵律(每個 task 都適用)

- **可動**:`plugins/delegate/`、`tests/delegate/`、`shared/lib/`、`tests/shared/`、`scripts/`、`.github/workflows/ci.yml`、`.claude-plugin/marketplace.json`(僅 delegate 版號)、本 plan 檔。
- **不可動**:`plugins/codex/`、`plugins/antigravity/`、`tests/codex/`、`tests/antigravity/`。
- `tests/fleet-structure.test.mjs` 僅當因 execute-plan 刪除或版號 bump 而紅時,允許做對應的最小更新(這是 spec 規定的行為變更),並在 commit message 說明。
- tests/shared 既有測試不得弱化;新增可以。
- 測試紅燈 = 找真因修實作;只有「spec 規定的行為變更」(execute-plan 刪除、`--resume-id` 改名、job 佈局目錄化、預設輸出格式)允許更新對應測試斷言,且每一筆都要能指到 spec 條款。
- 不准 push、不准開 PR。

## File Structure(終局)

```
shared/lib/
├── args.mjs                    # ← Task 1 自 delegate 升入(統一旗標解析)
├── core/job-control.mjs        # ← Task 2 自 delegate 升入(cancelJob)
└── (其餘 Plan A 已落地,不動)
scripts/sync-shared.mjs         # ← Task 3 vendor 同步
plugins/delegate/scripts/
├── delegate-companion.mjs      # 重構:七動詞 + --json(Task 6-9)
├── worker-entry.mjs            # detached worker CLI 入口(Task 6)
└── lib/
    ├── adapter.mjs             # ClaudeAdapter + dataRoot/workspaceStateDir(Task 4)
    ├── profiles.mjs            # 留(引擎特定,不動)
    ├── render.mjs              # 更新吃統一 schema(Task 9)
    ├── shared/                 # vendored(scripts/sync-shared.mjs 產物,不准手改)
    └── ~~args/state/claude/worker/env/job-control.mjs~~  # Task 9 刪
tests/delegate/
├── adapter.test.mjs            # 新(Task 4)
├── delegate.conformance.test.mjs  # 新(Task 5)
├── fake-claude.mjs             # 擴充十模式(Task 5)
├── companion-task.test.mjs     # 更新(Task 6)
├── companion-wait-logs.test.mjs   # 新(Task 8)
├── companion-control.test.mjs  # 更新(Task 7)
├── plugin-structure.test.mjs   # 更新(Task 10)
├── profiles.test.mjs / render.test.mjs / helpers.mjs  # 留(render 小更新)
└── ~~args/claude/env/state/job-control/worker.test.mjs~~  # Task 9 刪(行為守護已由 tests/shared 接手)
```

## 既有測試處置表(Task 9 執行,審查逐筆核對)

| 檔 | 處置 | 行為守護去向 |
|---|---|---|
| args.test.mjs | 刪 | Task 1 遷移至 tests/shared/args.test.mjs |
| state.test.mjs | 刪 | CAS/prune/list → tests/shared(Plan A);resolveDataRoot/workspaceStateDir → Task 4 adapter.test.mjs |
| job-control.test.mjs | 刪 | cancelJob 案例 → Task 2 tests/shared/job-control.test.mjs;reconcile 案例 → tests/shared/reconcile.test.mjs(Plan A 已覆蓋) |
| claude.test.mjs | 刪 | buildClaudeArgs → Task 4 adapter.test.mjs;runClaudeTurn 行為(noise/hang/EPIPE/onChild/ENOENT)→ tests/shared/worker.test.mjs + Task 5 conformance |
| env.test.mjs | 刪 | tests/shared/env.test.mjs(Plan A) |
| worker.test.mjs | 刪 | tests/shared/worker.test.mjs(Plan A) |
| companion-task/control | 更新 | 本 plan Task 6/7 |
| profiles/render/plugin-structure | 留/小更新 | — |

---

### Task 0: Pre-flight — 基線與分支

**Files:** Modify: 本 plan 檔(回填基線)

- [x] **Step 1: 確認分支與乾淨樹**

```bash
cd /home/audichuang/research/agent-fleet-cc && git branch --show-current && git status --short
```

Expected: `phase2b-delegate`、無輸出(乾淨)。

- [x] **Step 2: 重驗全套基線**

```bash
npm test > /tmp/phase2b-baseline.txt 2>&1; echo "exit=$?"; node -e "const s=require('fs').readFileSync('/tmp/phase2b-baseline.txt','utf8');for(const l of s.split('\n'))if(/^# (tests|pass|fail)/.test(l.trim()))console.log(l.trim())"
```

Expected: exit=0。若 `tests/codex/runtime.test.mjs` 偶發紅,重跑一次確認後記入基線節為 known-flaky,不擋工。把五套 pass 數記入本檔「基線」節。

- [x] **Step 3: 回填基線並 commit**

```bash
git add docs/plans/2026-06-12-phase2b-delegate.md && git commit -m "docs(plan): phase-2b baseline recorded"
```

---

### Task 1: args 升入 shared

**Files:**
- Create: `shared/lib/args.mjs`(自 `plugins/delegate/scripts/lib/args.mjs` 原樣升入)
- Create: `tests/shared/args.test.mjs`(自 `tests/delegate/args.test.mjs` 遷移,import 改指 shared)
- 注意:delegate 舊檔此 task **不刪**(companion 還在用),Task 9 統一清理。

- [x] **Step 1: 遷移測試(import 指向 shared)**

把 `tests/delegate/args.test.mjs` 的 4 個測試複製為 `tests/shared/args.test.mjs`,僅改 import:

```js
// tests/shared/args.test.mjs — 第一行 import 改為:
import { parseArgs, UsageError } from "../../shared/lib/args.mjs";
```

其餘測試內容逐字保留(4 tests:value/bool/positional、`--` 停止解析、unknown flag throws、缺 value throws)。

- [x] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/args.test.mjs`
Expected: FAIL — `Cannot find module .../shared/lib/args.mjs`

- [x] **Step 3: 原樣升入**

```bash
cp plugins/delegate/scripts/lib/args.mjs shared/lib/args.mjs
```

檔頭加一行註解:`// 統一旗標解析(spec §5:三 companion 共用同一套,杜絕再分岔)。升入自 delegate。`

- [x] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/args.test.mjs`
Expected: PASS(4 tests)

- [x] **Step 5: Commit**

```bash
git add shared/lib/args.mjs tests/shared/args.test.mjs
git commit -m "feat(shared): promote unified flag parser from delegate"
```

---

### Task 2: cancelJob 升入 shared

**Files:**
- Create: `shared/lib/core/job-control.mjs`
- Create: `tests/shared/job-control.test.mjs`(自 `tests/delegate/job-control.test.mjs` 的 cancelJob 案例遷移)

cancel 是兩段式殺(spec §5):cancelJob 對 **worker pid** 發單一 SIGTERM(worker 與引擎 child 各自是獨立 process group,殺 -workerPgid 殺不到 child 群);worker 的 `installCancelForwarder` 收到 SIGTERM 後以 `killGroupWithGrace` 殺整個引擎 child 群(含孫子)。cancelJob 的職責是 CAS-先行 + 安全 pid + 單發 SIGTERM。

- [x] **Step 1: 遷移 cancelJob 測試**

把 `tests/delegate/job-control.test.mjs` 中以下 7 個案例複製為 `tests/shared/job-control.test.mjs`,import 改為 shared 路徑,job 建立改用 `createJobRecord({engine:"delegate"})` + `createJob`(目錄式佈局):

- `cancelJob claims terminal BEFORE signalling, and never signals a finalized job`
- `cancelJob CAS-loser: job reads as running but lock already taken — must not signal`
- `cancelJob on unknown job reports cleanly`
- `cancelJob never signals unsafe pids even when JSON is polluted`
- `cancelJob re-reads pid after CAS win (queued job that just turned running)`
- `cancelJob prefers the fresh-merged pid over a stale snapshot pid`
- 新增一個:`cancelJob uses injectable killImpl with plain SIGTERM to the worker pid`(斷言 killImpl 收到 `(pid, "SIGTERM")` 且 pid 為正整數,非負 pgid——兩段式殺的第一段)

import 樣板:

```js
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { createJob, readJob, writeJob, finalizeJob, lockFilePath } from "../../shared/lib/core/state-store.mjs";
import { cancelJob } from "../../shared/lib/core/job-control.mjs";
```

- [x] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/job-control.test.mjs`
Expected: FAIL — `Cannot find module .../job-control.mjs`

- [x] **Step 3: 實作(自 delegate job-control.mjs 的 cancelJob 升入,store 呼叫改 shared)**

```js
// shared/lib/core/job-control.mjs
// cancel 兩段式殺的第一段(spec §5):CAS 先行、安全 pid、對 worker 發單一
// SIGTERM。第二段(引擎 child 的 process-group kill)由 worker 的
// installCancelForwarder 完成 — worker 與 child 各自 detached 成獨立 pgid,
// 從外面殺 -workerPid 殺不到 child 群。
import { TERMINAL_STATUSES } from "./job.mjs";
import { readJob, finalizeJob } from "./state-store.mjs";
import { safePid, isPidAlive } from "./reconcile.mjs";

// 順序是教訓(codex-plugin-cc):先 claim 終態,只有 CAS winner 可以 signal。
// loser 絕不 signal — 那個 pid 可能已被重用。
export function cancelJob(stateDir, jobId, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const killImpl = deps.killImpl ?? ((pid, sig) => process.kill(pid, sig));
  const job = readJob(stateDir, jobId);
  if (!job) return { ok: false, message: `No job ${jobId} in this workspace.` };
  if (TERMINAL_STATUSES.has(job.status)) {
    return { ok: false, message: `Job ${jobId} already ${job.status}.` };
  }
  deps.beforeFinalize?.(); // 測試縫:注入 worker 交錯
  if (!finalizeJob(stateDir, jobId, { status: "cancelled" })) {
    const latest = readJob(stateDir, jobId);
    return {
      ok: false,
      message: `Job ${jobId} already ${latest?.status ?? "finalized"}.`,
    };
  }
  // CAS 贏了才重讀 pid:queued 可能剛轉 running,finalizeJob 的 fresh-merge
  // 保住了 worker 的 pid stamp — post-finalize 的 JSON 才是準的。
  const pidToKill = safePid(readJob(stateDir, jobId)?.pid ?? job.pid);
  if (pidToKill && isAlive(pidToKill)) {
    try {
      killImpl(pidToKill, "SIGTERM");
    } catch {}
  }
  return { ok: true, message: `Cancelled ${jobId}.` };
}
```

- [x] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/job-control.test.mjs tests/shared/state-store-cas.test.mjs`
Expected: PASS(7 + 既有 6)

- [x] **Step 5: Commit**

```bash
git add shared/lib/core/job-control.mjs tests/shared/job-control.test.mjs
git commit -m "feat(shared): promote cancelJob (CAS-first, two-stage kill contract)"
```

---

### Task 3: vendor 機制 — sync-shared + drift check

**Files:**
- Create: `scripts/sync-shared.mjs`
- Modify: `package.json`(加 `sync-shared` script)
- Modify: `.github/workflows/ci.yml`(加 drift step)
- 產物: `plugins/delegate/scripts/lib/shared/`(首個 vendored 副本)

- [ ] **Step 1: 寫 sync 腳本**

```js
// scripts/sync-shared.mjs
// vendor:shared/lib → 各 plugin 的 scripts/lib/shared/(安裝只快取 plugin
// 子目錄,共享 lib 必須 vendor 進去 — 藍圖已驗證的快取行為)。
// CI 跑本腳本後 git diff --exit-code:vendored 副本與 source 不同步即紅燈。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(root, "shared", "lib");
// Plan C/D 把 antigravity、codex 加進來
const TARGETS = ["delegate"].map((p) =>
  path.join(root, "plugins", p, "scripts", "lib", "shared"),
);

for (const target of TARGETS) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(SOURCE, target, { recursive: true });
  const banner = path.join(target, "VENDORED.md");
  fs.writeFileSync(
    banner,
    "# VENDORED — do not edit\n\nSynced from `shared/lib/` by `scripts/sync-shared.mjs`.\nEdit the source and re-run `npm run sync-shared`.\n",
  );
  console.log(`synced shared/lib -> ${path.relative(root, target)}`);
}
```

- [ ] **Step 2: 接上 npm script 並執行**

`package.json` scripts 加一行:

```json
    "sync-shared": "node scripts/sync-shared.mjs",
```

Run: `npm run sync-shared && ls plugins/delegate/scripts/lib/shared/core/`
Expected: 印出 synced 行;ls 列出 job.mjs、events.mjs、state-store.mjs、reconcile.mjs、env.mjs、wait.mjs、job-control.mjs

- [ ] **Step 3: CI 加 drift step**

`.github/workflows/ci.yml` 在 `- run: npm test` 之前插入:

```yaml
      - name: Vendored shared lib must match source (drift check)
        run: npm run sync-shared && git diff --exit-code
```

- [ ] **Step 4: 驗證 drift check 邏輯(本地模擬)**

```bash
echo "// drift" >> plugins/delegate/scripts/lib/shared/core/job.mjs
npm run sync-shared && git diff --exit-code -- plugins/delegate/scripts/lib/shared && echo DRIFT-CHECK-OK
```

Expected: `DRIFT-CHECK-OK`(sync 把手改覆蓋回去,diff 乾淨)。

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-shared.mjs package.json .github/workflows/ci.yml plugins/delegate/scripts/lib/shared/
git commit -m "feat(vendor): sync-shared script + CI drift check + first vendored copy (delegate)"
```

---

### Task 4: ClaudeAdapter

**Files:**
- Create: `plugins/delegate/scripts/lib/adapter.mjs`
- Test: `tests/delegate/adapter.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/delegate/adapter.test.mjs
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { validateProcessAdapter } from "../../plugins/delegate/scripts/lib/shared/adapter-api.mjs";
import {
  makeClaudeAdapter,
  buildClaudeArgs,
  resolveDataRoot,
  workspaceStateDir,
} from "../../plugins/delegate/scripts/lib/adapter.mjs";
import { writeProfile, makeDataRoot } from "./helpers.mjs";

test("adapter satisfies the ProcessAdapter contract", () => {
  assert.deepEqual(validateProcessAdapter(makeClaudeAdapter()), []);
});

test("buildClaudeArgs composes the headless invocation", () => {
  const args = buildClaudeArgs({ settingsPath: "/p/s.json" });
  assert.deepEqual(args, [
    "-p", "--output-format", "stream-json", "--verbose",
    "--settings", "/p/s.json", "--permission-mode", "bypassPermissions",
  ]);
  assert.deepEqual(
    buildClaudeArgs({ settingsPath: "/p/s.json", permissionMode: "default", resumeSessionId: "s9", model: "deepseek-chat" }).slice(-4),
    ["--model", "deepseek-chat", "-r", "s9"],
  );
});

test("buildInvocation resolves profile env at spawn time (secrets stay out of job.json)", () => {
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "p1", {
    env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "tok" },
  });
  const adapter = makeClaudeAdapter();
  const inv = adapter.buildInvocation({
    job: { request: { settingsPath, permissionMode: "bypassPermissions" } },
    prompt: "do it",
  });
  assert.equal(inv.argv[0], "claude");
  assert.ok(inv.argv.includes("--settings"));
  assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(inv.stdinPayload, "do it");
});

test("binaryArgv override (conformance/test seam) replaces the claude binary", () => {
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "p1", { env: {} });
  const inv = makeClaudeAdapter().buildInvocation({
    job: { request: { settingsPath, binaryArgv: ["/usr/bin/node", "/tmp/fake.mjs"] } },
    prompt: "x",
  });
  assert.deepEqual(inv.argv.slice(0, 2), ["/usr/bin/node", "/tmp/fake.mjs"]);
});

test("parseEvent: session + result mapped, junk and irrelevant events → null", () => {
  const a = makeClaudeAdapter();
  assert.deepEqual(a.parseEvent('{"type":"system","session_id":"s1"}'), { kind: "session", sessionId: "s1" });
  const r = a.parseEvent('{"type":"result","result":"done","is_error":false,"usage":{"input_tokens":10,"output_tokens":5}}');
  assert.deepEqual(r, { kind: "result", text: "done", isError: false, usage: { inputTokens: 10, outputTokens: 5 } });
  assert.equal(a.parseEvent("not json"), null);
  assert.equal(a.parseEvent('{"type":"assistant","message":"..."}'), null);
});

test("extractResult: ok requires result event, non-string result is stringified", () => {
  const a = makeClaudeAdapter();
  const events = [
    { type: "engine-event", kind: "session", sessionId: "s1" },
    { type: "engine-event", kind: "result", text: "hi", isError: false, usage: { inputTokens: 1, outputTokens: 2 } },
  ];
  assert.deepEqual(a.extractResult(events, 0), {
    ok: true, resultText: "hi", sessionId: "s1", usage: { inputTokens: 1, outputTokens: 2 },
  });
  assert.equal(a.extractResult([], 0).ok, false);
  assert.equal(a.extractResult([{ type: "engine-event", kind: "result", text: "x", isError: true }], 0).ok, false);
});

test("classifyError buckets", () => {
  const a = makeClaudeAdapter();
  assert.equal(a.classifyError("401 unauthorized invalid x-api-key", 1), "auth");
  assert.equal(a.classifyError("getaddrinfo ENOTFOUND my.endpoint", 1), "endpoint");
  assert.equal(a.classifyError("claude: command not found", 127), "not-installed");
  assert.equal(a.classifyError("boom", 1), "unknown");
});

test("resumeArgs + recursion marker + paths", () => {
  const a = makeClaudeAdapter();
  assert.deepEqual(a.resumeArgs("s1"), ["-r", "s1"]);
  assert.equal(a.recursionMarker, "CLAUDE_DELEGATE_ACTIVE");
  assert.equal(a.engine, "delegate");
  assert.equal(a.wantsWatchdog, false);
  assert.equal(resolveDataRoot({ DELEGATE_PLUGIN_DATA: "/d" }), "/d");
  const dir = workspaceStateDir("/root", "/home/u/proj");
  assert.ok(dir.startsWith(path.join("/root", "state", "proj-")));
  assert.equal(workspaceStateDir("/root", "/home/u/proj"), dir); // 穩定
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/delegate/adapter.test.mjs`
Expected: FAIL — `Cannot find module .../adapter.mjs`

- [ ] **Step 3: 實作**

```js
// plugins/delegate/scripts/lib/adapter.mjs
// ClaudeAdapter:delegate 的全部引擎知識住這裡(spec §2/§5)。
// job runtime(state/worker/cancel)在 vendored shared,本檔不碰 I/O 生命週期。
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveProfile } from "./profiles.mjs";

export const RECURSION_MARKER = "CLAUDE_DELEGATE_ACTIVE";

// delegate 特有路徑邏輯(自舊 state.mjs 遷入,行為不變)
export function resolveDataRoot(env = process.env) {
  if (env.DELEGATE_PLUGIN_DATA) return env.DELEGATE_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), ".claude", "plugins", "data", "delegate");
}

export function workspaceStateDir(dataRoot, cwd) {
  const slug =
    path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32) || "ws";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

export function buildClaudeArgs({
  settingsPath,
  permissionMode = "bypassPermissions",
  resumeSessionId,
  model,
} = {}) {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--settings", settingsPath,
    "--permission-mode", permissionMode,
  ];
  if (model) args.push("--model", model);
  if (resumeSessionId) args.push("-r", resumeSessionId);
  return args;
}

export function makeClaudeAdapter() {
  return {
    name: "claude",
    engine: "delegate",
    recursionMarker: RECURSION_MARKER,
    wantsWatchdog: false,
    // request 只存 settingsPath/旗標 — profile env(含 AUTH_TOKEN)在 spawn
    // 時才從 profile 檔讀,秘密永不落進 job.json。
    buildInvocation({ job, prompt }) {
      const request = job.request ?? {};
      const profile = resolveProfile({ settingsPath: request.settingsPath });
      const head =
        request.binaryArgv ??
        [process.env.DELEGATE_CLAUDE_BIN ?? "claude"];
      const argv = [
        ...head,
        ...buildClaudeArgs({
          settingsPath: request.settingsPath,
          permissionMode: request.permissionMode,
          resumeSessionId: request.resumeSessionId,
          model: request.model,
        }),
      ];
      return { argv, env: profile.env, stdinPayload: prompt };
    },
    parseEvent(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return null; // junk — 容錯跳行,永不 fatal
      }
      if (typeof event.session_id === "string" && event.type !== "result") {
        return { kind: "session", sessionId: event.session_id };
      }
      if (event.type === "result") {
        const usage = event.usage
          ? {
              inputTokens: event.usage.input_tokens ?? null,
              outputTokens: event.usage.output_tokens ?? null,
            }
          : null;
        return {
          kind: "result",
          text:
            typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result ?? ""),
          isError: Boolean(event.is_error),
          usage,
        };
      }
      return null; // assistant/tool 事件不進 events(log 檔有完整行)
    },
    extractResult(events) {
      const session = events.find((e) => e.kind === "session");
      const result = events.find((e) => e.kind === "result");
      return {
        ok: Boolean(result) && !result.isError,
        resultText: result?.text ?? null,
        sessionId: session?.sessionId ?? null,
        usage: result?.usage ?? null,
      };
    },
    classifyError(stderrTail, exitCode) {
      const s = String(stderrTail ?? "");
      if (/401|unauthorized|invalid.*key|token expired/i.test(s)) return "auth";
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(s)) return "endpoint";
      if (exitCode === 127 || /command not found|ENOENT/i.test(s)) return "not-installed";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["-r", sessionId];
    },
  };
}
```

注意:`parseEvent` 的 session 分支對 `type:"result"` 行讓位給 result 分支(result 行也帶 session_id,但 result 事件優先)— 測試的兩個案例已鎖此行為。

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/delegate/adapter.test.mjs`
Expected: PASS(8 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/delegate/scripts/lib/adapter.mjs tests/delegate/adapter.test.mjs
git commit -m "feat(delegate): ClaudeAdapter — engine knowledge behind the ProcessAdapter contract"
```

---

### Task 5: fake-claude 十模式 + conformance 接線

**Files:**
- Modify: `tests/delegate/fake-claude.mjs`(擴充;**既有模式 success/noise/fail/hang/early-exit/env-echo 保留**,companion 測試還在用)
- Create: `tests/delegate/delegate.conformance.test.mjs`

- [ ] **Step 1: 擴充 fake-claude(追加十劇本模式)**

在既有 switch/分支之後追加以下模式(沿用既有 `out()`/`sessionId` helper;conformance 斷言值必須逐字對齊 `tests/shared/conformance/conformance.mjs`):

```js
// tests/delegate/fake-claude.mjs — 追加模式(FAKE_CLAUDE_MODE)
// conformance 對齊:斷言值與 tests/shared/conformance/conformance.mjs 逐字一致
if (mode === "conf-ok") {
  out({ type: "system", session_id: "fake-session-1" });
  out({ type: "result", result: `echo:${stdin.trim().slice(0, 40)}`, is_error: false,
        usage: { input_tokens: 7, output_tokens: 3 } });
  process.exit(0);
}
if (mode === "conf-resume") {
  out({ type: "system", session_id: "fake-session-1" });
  out({ type: "result", result: process.argv.includes("-r") ? "resumed" : "fresh", is_error: false });
  process.exit(0);
}
if (mode === "conf-midway-drop") {
  out({ type: "system", session_id: "fake-session-2" });
  process.exit(1);
}
if (mode === "conf-noise") {
  process.stdout.write("plain noise\n{broken json\n");
  out({ type: "result", result: "survived noise", is_error: false });
  process.exit(0);
}
if (mode === "conf-hang") {
  out({ type: "system", session_id: "s" });
  setInterval(() => {}, 1000);
}
if (mode === "conf-instant-exit") process.exit(7);
if (mode === "conf-huge-output") {
  const big = "x".repeat(64 * 1024);
  for (let i = 0; i < 4; i += 1) out({ type: "assistant", chunk: big });
  out({ type: "result", result: `huge:${big.length * 4}`, is_error: false });
  process.exit(0);
}
if (mode === "conf-auth-expire-midway") {
  out({ type: "system", session_id: "s" });
  process.stderr.write("token expired: 401 mid-stream\n");
  process.exit(1);
}
if (mode === "conf-grandchild") {
  const { spawn } = await import("node:child_process");
  const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  out({ type: "grandchild", pid: gc.pid });
  setInterval(() => {}, 1000);
}
```

(若既有檔案結構是先讀完 stdin 再分支,把 `conf-instant-exit` 跟既有 `early-exit` 一樣放在 stdin 讀取之前;其餘 conf 模式在 stdin 讀完後分支。grandchild 模式需要檔案是 top-level await 可用的 .mjs——已是。)

- [ ] **Step 2: 寫 conformance 接線**

```js
// tests/delegate/delegate.conformance.test.mjs
import "./helpers.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConformanceSuite } from "../shared/conformance/conformance.mjs";
import { makeClaudeAdapter } from "../../plugins/delegate/scripts/lib/adapter.mjs";
import { makeDataRoot, writeProfile } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, "fake-claude.mjs");

// conformance 的 makeAdapter({mode, resumeSessionId}) 工廠:把抽象 mode 映到
// fake-claude 的 conf-* 模式,profile env 走真實 resolveProfile 路徑。
function makeAdapter({ mode = "ok", resumeSessionId = null } = {}) {
  const dataRoot = makeDataRoot();
  const settingsPath = writeProfile(dataRoot, "conf", {
    env: { FAKE_CLAUDE_MODE: `conf-${mode}` },
  });
  const base = makeClaudeAdapter();
  return {
    ...base,
    buildInvocation({ job, prompt }) {
      return base.buildInvocation({
        job: {
          ...job,
          request: {
            ...job.request,
            settingsPath,
            resumeSessionId,
            binaryArgv: [process.execPath, FAKE_CLAUDE],
          },
        },
        prompt,
      });
    },
  };
}

runConformanceSuite({ makeAdapter });
```

- [ ] **Step 3: 跑 conformance 確認十劇本全綠**

Run: `node --test tests/delegate/delegate.conformance.test.mjs`
Expected: PASS(10 scenarios)。若 scenario 9 的 errorKind 不是 `auth`,真因在 adapter 的 classifyError 對 stderr 樣式不認——修 adapter,不改 conformance。

- [ ] **Step 4: 既有 delegate 測試未被破壞**

Run: `node --test tests/delegate/claude.test.mjs tests/delegate/companion-task.test.mjs`
Expected: PASS(舊模式 success/noise/... 仍在,既有測試不受擴充影響)

- [ ] **Step 5: Commit**

```bash
git add tests/delegate/fake-claude.mjs tests/delegate/delegate.conformance.test.mjs
git commit -m "test(delegate): ClaudeAdapter passes the 10-scenario conformance suite"
```

---

### Task 6: worker-entry + companion task 子指令重構

**Files:**
- Create: `plugins/delegate/scripts/worker-entry.mjs`
- Modify: `plugins/delegate/scripts/delegate-companion.mjs`(task 子指令 + startJob)
- Modify: `tests/delegate/companion-task.test.mjs`(更新至新合約)

機器層合約(spec §2.1)在 delegate 的落地:

| 旗標 | 行為 |
|---|---|
| `<prompt...>` 或 `--prompt-file <path>` | 二擇一;都給時 `--prompt-file` 優先;都缺 → UsageError |
| 預設(無 `--background`)/ `--wait` | 前景:in-process `runWorker`,等終態 |
| `--background` | 寫 job + detached spawn `worker-entry.mjs`,立即回 |
| `--json` | launch 形態 `{engine:"delegate",jobId,status:"queued"}`(bg);result 形態(fg 完成)`{engine,jobId,status,resultText,sessionId,exitCode,error,errorKind,durationMs}` |
| `--model <id>` | 透傳 `claude -p --model`(request.model) |
| `--read-only` / `--write` | request.permissionMode = `default` / `bypassPermissions`(預設沿革 bypass) |
| `--resume-job <id>` / `--resume-last` | 取代 `--resume-id`(舊名移除);語意不變(讀 source job 的 settingsPath+sessionId) |
| `--profile/--settings/--timeout-ms` | 不變 |

- [ ] **Step 1: 更新 companion-task 測試至新合約**

對 `tests/delegate/companion-task.test.mjs` 做以下變更(每筆都對應 spec 條款):

1. 佈局斷言:`jobs/<id>.json` → `jobs/<id>/job.json`、`<id>.prompt.txt` → `<id>/prompt.txt`(spec §3 目錄式)。helpers 不變。
2. `--resume-id` 全部改 `--resume-job`(spec §2.1);加一個 `--resume-id now fails with UsageError (renamed to --resume-job)` 測試。
3. 新增測試(完整碼):

```js
test("--prompt-file reads the prompt from a file (workflow seam)", async () => {
  const { dataRoot, cwd } = setupWorkspace(); // 沿用檔內既有 helper 模式
  const promptPath = path.join(cwd, "p.md");
  fs.writeFileSync(promptPath, "from file");
  const code = await runCompanion(["task", "--prompt-file", promptPath, "--profile", "p1"], deps());
  assert.equal(code, 0);
  const job = listJobs(workspaceStateDir(dataRoot, cwd))[0];
  assert.equal(
    fs.readFileSync(promptFilePath(workspaceStateDir(dataRoot, cwd), job.id), "utf8"),
    "from file",
  );
});

test("--json on background launch emits the unified launch projection", async () => {
  const { out, lines } = captureOut();
  await runCompanion(["task", "x", "--profile", "p1", "--background", "--json"], deps({ out }));
  const payload = JSON.parse(lines.join("\n"));
  assert.equal(payload.engine, "delegate");
  assert.equal(payload.status, "queued");
  assert.match(payload.jobId, /^delegate-/);
});

test("--json on foreground completion emits the unified result projection", async () => {
  const { out, lines } = captureOut();
  const code = await runCompanion(["task", "hello", "--profile", "p1", "--json"], deps({ out }));
  assert.equal(code, 0);
  const payload = JSON.parse(lines.join("\n"));
  assert.equal(payload.engine, "delegate");
  assert.equal(payload.status, "completed");
  assert.ok(typeof payload.resultText === "string");
  assert.ok("sessionId" in payload && "durationMs" in payload && "errorKind" in payload);
});

test("--read-only maps to permission-mode default in the spawned argv", async () => {
  // 透過 fake-claude env-echo 或注入 spawnImpl 捕 argv,斷言含
  // ["--permission-mode","default"];--write 與預設則為 bypassPermissions
});
```

4. job id 斷言:`dlg-` 前綴 → `delegate-`(統一 schema 的 `newJobId(engine)`;spec §3)。
5. `execute-plan` 的兩個測試此 task 先不動(Task 9 刪)。
6. 既有行為測試(recursion guard、背景 e2e cancel、env 重建、traversal 防護、owner-only 權限)全部保留——更新路徑斷言後必須照樣綠。

- [ ] **Step 2: 跑更新後測試確認失敗**

Run: `node --test tests/delegate/companion-task.test.mjs`
Expected: FAIL(新旗標未實作、佈局還是平鋪)

- [ ] **Step 3: 寫 worker-entry 並重構 companion 的 task/startJob**

```js
// plugins/delegate/scripts/worker-entry.mjs
// detached worker CLI 入口:node worker-entry.mjs <stateDir> <jobId>
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { makeClaudeAdapter } from "./lib/adapter.mjs";

const [stateDir, jobId] = process.argv.slice(2);
const forwarder = installCancelForwarder({ forceExitMs: 7000 });
runWorker({
  stateDir,
  jobId,
  adapter: makeClaudeAdapter(),
  deps: { onChild: forwarder.onChild },
}).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
```

companion 重構要點(完整置換 `cmdTask`/`startJob`;import 改 vendored shared):

```js
// delegate-companion.mjs — 重構後的核心(節錄:cmdTask + startJob + 投影)
import { parseArgs, UsageError } from "./lib/shared/args.mjs";
import { createJobRecord } from "./lib/shared/core/job.mjs";
import {
  createJob, readJob, listJobs, pruneJobs, promptFilePath, logFilePath,
} from "./lib/shared/core/state-store.mjs";
import { reconcileDeadPids } from "./lib/shared/core/reconcile.mjs";
import { cancelJob } from "./lib/shared/core/job-control.mjs";
import { waitForJob } from "./lib/shared/core/wait.mjs";
import { readEvents } from "./lib/shared/core/events.mjs";
import { jobDir } from "./lib/shared/core/state-store.mjs";
import { runWorker, installCancelForwarder } from "./lib/shared/runtime/worker.mjs";
import { makeClaudeAdapter, resolveDataRoot, workspaceStateDir } from "./lib/adapter.mjs";
import { resolveProfile, listProfiles, ProfileError } from "./lib/profiles.mjs";
import { renderStatus, renderResult } from "./lib/render.mjs";

const TASK_FLAGS = {
  valueFlags: ["profile", "settings", "resume-job", "timeout-ms", "prompt-file", "model"],
  boolFlags: ["background", "wait", "resume-last", "json", "read-only", "write"],
};

function resultProjection(job) {
  return {
    engine: "delegate", jobId: job.id, status: job.status,
    resultText: job.resultText ?? null, sessionId: job.sessionId ?? null,
    exitCode: job.exitCode ?? null, error: job.error ?? null,
    errorKind: job.errorKind ?? null, durationMs: job.durationMs ?? null,
  };
}

async function cmdTask({ argv, env, out, cwd, dataRoot, stateDir, deps }) {
  const { flags, positionals } = parseArgs(argv, TASK_FLAGS);
  let prompt;
  if (flags["prompt-file"]) {
    try {
      prompt = fs.readFileSync(path.resolve(cwd, flags["prompt-file"]), "utf8");
    } catch {
      throw new UsageError(`prompt file not readable: ${flags["prompt-file"]}`);
    }
  } else {
    prompt = positionals.join(" ").trim();
  }
  if (!prompt) throw new UsageError("task requires a prompt or --prompt-file");
  return startJob({ prompt, flags, env, out, cwd, dataRoot, stateDir, deps });
}

async function startJob({ prompt, flags, env, out, cwd, dataRoot, stateDir, deps }) {
  const source = resolveResumeSource({ flags, stateDir }); // --resume-job/--resume-last(沿舊邏輯,讀 flags["resume-job"])
  let settingsPath, profileName;
  if (source) {
    resolveProfile({ settingsPath: source.request?.settingsPath ?? source.settingsPath });
    settingsPath = source.request?.settingsPath ?? source.settingsPath;
    profileName = source.request?.profile ?? source.profile;
  } else {
    const profile = resolveProfile({ dataRoot, profile: flags.profile, settingsPath: flags.settings, env });
    settingsPath = profile.path;
    profileName = profile.name;
  }
  const permissionMode = flags["read-only"]
    ? "default"
    : (env.DELEGATE_PERMISSION_MODE ?? "bypassPermissions");
  const record = createJobRecord({
    engine: "delegate",
    title: prompt.slice(0, 120),
    cwd,
    timeoutMs: parseTimeoutMs(flags["timeout-ms"], env),
    request: {
      profile: profileName, settingsPath, permissionMode,
      model: flags.model ?? null,
      resumeSessionId: source?.sessionId ?? null,
      resumedFrom: source?.id ?? null,
    },
  });
  createJob(stateDir, record, prompt);
  pruneJobs(stateDir);

  if (flags.background) {
    const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker-entry.mjs");
    const child = (deps.workerSpawnImpl ?? spawn)(
      process.execPath, [workerPath, stateDir, record.id],
      { detached: true, stdio: "ignore", env: { ...env } },
    );
    child.unref();
    if (flags.json) {
      out(JSON.stringify({ engine: "delegate", jobId: record.id, status: "queued" }));
    } else {
      out(`Started background job ${record.id} (profile=${record.request.profile}).`);
      out(`Check: status | wait ${record.id} | result ${record.id} | cancel ${record.id}`);
    }
    return 0;
  }

  const forwarder = installCancelForwarder({});
  try {
    await runWorker({
      stateDir, jobId: record.id, adapter: makeClaudeAdapter(),
      deps: { spawnImpl: deps.claudeSpawnImpl, baseEnv: env, onChild: forwarder.onChild },
    });
  } finally {
    forwarder.dispose();
  }
  const finished = readJob(stateDir, record.id);
  out(flags.json ? JSON.stringify(resultProjection(finished)) : renderResult(finished, readLogTail(stateDir, record.id)));
  return finished.status === "completed" ? 0 : 1;
}
```

實作細節:`resolveResumeSource` 沿舊邏輯但讀 `flags["resume-job"]`;`readLogTail` 路徑改 `logFilePath`(目錄式);binary 的 DELEGATE_CLAUDE_BIN 改由 adapter 內部讀(`deps.binary` 縫移除——測試經 `DELEGATE_CLAUDE_BIN` env 或 `claudeSpawnImpl` 注入)。`USAGE` 字串同步更新七動詞。

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/delegate/companion-task.test.mjs tests/delegate/adapter.test.mjs`
Expected: PASS(含背景 e2e:REAL detached worker-entry 跑 fake claude、跨進程 cancel)

- [ ] **Step 5: Commit**

```bash
git add plugins/delegate/scripts/worker-entry.mjs plugins/delegate/scripts/delegate-companion.mjs tests/delegate/companion-task.test.mjs
git commit -m "feat(delegate): companion task on shared runtime — prompt-file/json/model/read-only/resume-job"
```

---

### Task 7: companion status/result/cancel 重構

**Files:**
- Modify: `plugins/delegate/scripts/delegate-companion.mjs`(三個子指令)
- Modify: `tests/delegate/companion-control.test.mjs`

- [ ] **Step 1: 更新測試**

`companion-control.test.mjs` 的 6 個既有測試更新佈局/前綴斷言(同 Task 6 規則),並新增:

```js
test("status --json emits an array of core-field projections", async () => {
  const { out, lines } = captureOut();
  await runCompanion(["status", "--json"], deps({ out }));
  const arr = JSON.parse(lines.join("\n"));
  assert.ok(Array.isArray(arr));
  if (arr.length) {
    assert.ok("engine" in arr[0] && "jobId" in arr[0] && "status" in arr[0]);
  }
});

test("result --json emits the unified result projection; cancel --json emits {ok,message}", async () => {
  // 建一個 completed job 後:result <id> --json → resultProjection 欄位齊;
  // cancel <id> --json(對 running job)→ {ok:true,message:"Cancelled ..."}
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/delegate/companion-control.test.mjs`
Expected: FAIL(--json 未實作 / import 還指舊 lib)

- [ ] **Step 3: 重構三個子指令**

```js
function cmdStatus({ argv, out, stateDir }) {
  const { flags } = parseArgs(argv, { boolFlags: ["json"] });
  reconcileDeadPids(stateDir);
  const jobs = listJobs(stateDir);
  out(flags.json ? JSON.stringify(jobs.map(resultProjection)) : renderStatus(jobs));
  return 0;
}

function cmdResult({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["last", "json"] });
  reconcileDeadPids(stateDir);
  const job = positionals[0]
    ? readJob(stateDir, safeJobId(positionals[0]))
    : listJobs(stateDir)[0];
  if (!job) {
    out(flags.json ? JSON.stringify({ error: "no jobs" }) : "No delegate jobs in this workspace.");
    return 1;
  }
  out(flags.json
    ? JSON.stringify(resultProjection(job))
    : renderResult(job, job.status === "completed" ? "" : readLogTail(stateDir, job.id)));
  return job.status === "completed" ? 0 : 1;
}

function cmdCancel({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["json"] });
  if (!positionals[0]) throw new UsageError("cancel requires a job id");
  const result = cancelJob(stateDir, safeJobId(positionals[0]));
  out(flags.json ? JSON.stringify(result) : result.message);
  return result.ok ? 0 : 1;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/delegate/companion-control.test.mjs`
Expected: PASS(8 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/delegate/scripts/delegate-companion.mjs tests/delegate/companion-control.test.mjs
git commit -m "feat(delegate): status/result/cancel on shared store with unified --json projections"
```

---

### Task 8: companion wait/logs 動詞

**Files:**
- Modify: `plugins/delegate/scripts/delegate-companion.mjs`(+cmdWait、+cmdLogs、USAGE)
- Create: `tests/delegate/companion-wait-logs.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/delegate/companion-wait-logs.test.mjs
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
// 沿 companion-task.test.mjs 的 helper 模式(runCompanion/deps/captureOut/setupWorkspace)

test("wait blocks until terminal state and exits 0; --json emits result projection", async () => {
  // 1) task --background(fake-claude conf-ok 經 profile env)拿 jobId
  // 2) wait <jobId> --timeout-s 30 --json → exit 0,payload.status === "completed"
});

test("wait on a still-running job with tiny timeout exits 10 and reports running", async () => {
  // fake-claude conf-hang;wait <jobId> --timeout-s 1 → exit 10(timeout 專用碼,非錯誤)
  // stdout 含 status:"running"(--json)
  // 之後 cancel 該 job 清理
});

test("wait streams event heartbeats to stdout while blocking (non-json)", async () => {
  // 非 --json 模式:stdout 至少出現一行 engine-event 透傳(spawned/engine-event 的 type 名)
});

test("logs prints events.ndjson tail; --follow follows to terminal then exits", async () => {
  // 完成的 job:logs <jobId> → 印出 job-created/spawned/.../finalized 各行
  // logs <jobId> --follow 對 running job:終態後自行退出
});

test("wait/logs on unknown job exit 1 with a clear message", async () => {});
```

(測試骨架照上述意圖寫完整——五個測試都要有真斷言;沿用檔內既有 e2e helper 跑真 detached worker。)

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/delegate/companion-wait-logs.test.mjs`
Expected: FAIL — unknown command `wait`

- [ ] **Step 3: 實作兩個動詞**

```js
const WAIT_TIMEOUT_EXIT = 10; // 超時不是錯誤:專用碼讓編排者乾淨 re-entry(spec §2.3)

async function cmdWait({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, {
    valueFlags: ["timeout-s"], boolFlags: ["json"],
  });
  if (!positionals[0]) throw new UsageError("wait requires a job id");
  const jobId = safeJobId(positionals[0]);
  if (!readJob(stateDir, jobId)) {
    out(flags.json ? JSON.stringify({ error: `no job ${jobId}` }) : `No job ${jobId} in this workspace.`);
    return 1;
  }
  const timeoutS = flags["timeout-s"] ? Number(flags["timeout-s"]) : 540;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    throw new UsageError(`--timeout-s must be a positive number, got: ${flags["timeout-s"]}`);
  }
  reconcileDeadPids(stateDir);
  const { done, job } = await waitForJob({
    stateDir, jobId, timeoutMs: timeoutS * 1000,
    onEvent: (e) => { if (!flags.json) out(`[${e.ts}] ${e.type}${e.kind ? ":" + e.kind : ""}`); },
  });
  out(flags.json ? JSON.stringify(resultProjection(job)) : renderResult(job, ""));
  if (!done) return WAIT_TIMEOUT_EXIT;
  return job.status === "completed" ? 0 : 1;
}

async function cmdLogs({ argv, out, stateDir }) {
  const { flags, positionals } = parseArgs(argv, { boolFlags: ["follow"] });
  if (!positionals[0]) throw new UsageError("logs requires a job id");
  const jobId = safeJobId(positionals[0]);
  if (!readJob(stateDir, jobId)) {
    out(`No job ${jobId} in this workspace.`);
    return 1;
  }
  const dir = jobDir(stateDir, jobId);
  for (const e of readEvents(dir)) out(JSON.stringify(e));
  if (!flags.follow) return 0;
  // --follow:複用 waitForJob 的增量 drain 直到終態(輪詢成本 O(file)/poll,
  // checkpoint 已知;delegate 量級可接受,優化留待真實需求)
  const { job } = await waitForJob({
    stateDir, jobId, timeoutMs: 24 * 60 * 60 * 1000,
    onEvent: (e) => out(JSON.stringify(e)),
  });
  return TERMINAL_STATUSES.has(job?.status) ? 0 : 1;
}
```

(`TERMINAL_STATUSES` 自 `./lib/shared/core/job.mjs` import;switch 加 `case "wait"`/`case "logs"`;USAGE 更新。注意:`logs --follow` 會重印 readEvents 已印過的行嗎?不會——`waitForJob` 的 drain 從 index 0 重數,所以 follow 模式跳過第一段 `for (const e of readEvents(dir))`,直接走 waitForJob 讓它從頭 emit。實作以此為準:`--follow` 時不先靜態印,全部交給 waitForJob 的 onEvent。)

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/delegate/companion-wait-logs.test.mjs`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add plugins/delegate/scripts/delegate-companion.mjs tests/delegate/companion-wait-logs.test.mjs
git commit -m "feat(delegate): wait/logs re-entry verbs (orchestrator contract §2.3)"
```

---

### Task 9: 刪 execute-plan + 清理舊 lib

**Files:**
- Delete: `plugins/delegate/commands/execute-plan.md`
- Modify: `plugins/delegate/scripts/delegate-companion.mjs`(刪 execute-plan 子指令 + `EXECUTE_PLAN_TEMPLATE`;USAGE 更新)
- Delete: `plugins/delegate/scripts/lib/{args,state,claude,worker,env,job-control}.mjs`(六檔)
- Delete: `tests/delegate/{args,state,claude,worker,env,job-control}.test.mjs`(六檔,處置表見 plan 開頭)
- Modify: `plugins/delegate/scripts/lib/render.mjs` + `tests/delegate/render.test.mjs`(欄位適配統一 schema)
- Modify: `tests/delegate/companion-task.test.mjs`(刪 execute-plan 的 2 個測試)

- [ ] **Step 1: 刪指令與子指令**

```bash
git rm plugins/delegate/commands/execute-plan.md
```

companion:刪 `case "execute-plan"`、`cmdExecutePlan`、`EXECUTE_PLAN_TEMPLATE`;USAGE 改為:

```
usage: delegate-companion <command> [...]
  setup
  task [<prompt...>] [--prompt-file <path>] [--profile <name>|--settings <path>] [--wait|--background] [--json] [--model <id>] [--read-only|--write] [--resume-job <id>|--resume-last] [--timeout-ms <n>]
  wait <job-id> [--timeout-s <n>] [--json]
  logs <job-id> [--follow]
  status [--json]
  result [<job-id>|--last] [--json]
  cancel <job-id> [--json]
```

- [ ] **Step 2: 刪舊 lib 與舊測試(處置表逐筆)**

```bash
git rm plugins/delegate/scripts/lib/args.mjs plugins/delegate/scripts/lib/state.mjs \
       plugins/delegate/scripts/lib/claude.mjs plugins/delegate/scripts/lib/worker.mjs \
       plugins/delegate/scripts/lib/env.mjs plugins/delegate/scripts/lib/job-control.mjs
git rm tests/delegate/args.test.mjs tests/delegate/state.test.mjs tests/delegate/claude.test.mjs \
       tests/delegate/worker.test.mjs tests/delegate/env.test.mjs tests/delegate/job-control.test.mjs
```

確認無殘餘 import:

```bash
node -e "
const fs=require('fs'),path=require('path');
const bad=[];
function scan(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);
  if(fs.statSync(p).isDirectory()){if(!p.includes('lib/shared'))scan(p);continue;}
  if(!/\.mjs$/.test(f))continue;
  const s=fs.readFileSync(p,'utf8');
  for(const m of ['lib/state.mjs','lib/claude.mjs','lib/worker.mjs','lib/env.mjs','lib/job-control.mjs','lib/args.mjs'])
    if(s.includes(m))bad.push(p+' -> '+m);}}
scan('plugins/delegate/scripts');scan('tests/delegate');
console.log(bad.length?bad.join('\n'):'NO-STALE-IMPORTS');"
```

Expected: `NO-STALE-IMPORTS`

- [ ] **Step 3: render 適配統一 schema**

`render.mjs`:`job.prompt`/`promptPreview` 改 `job.title`、`resultText` 不變、加 `errorKind` 顯示(failed 行尾 `[auth]` 式標注);`render.test.mjs` 對應更新(兩個測試,改用 `createJobRecord` 形狀的 job 物件)。

- [ ] **Step 4: companion-task 移除 execute-plan 測試後全套跑**

Run: `node --test tests/delegate/*.test.mjs`
Expected: 全 PASS(13 檔 → 9 檔:adapter、conformance、companion-task、companion-control、companion-wait-logs、profiles、render、plugin-structure、helpers 不算)

- [ ] **Step 5: Commit**

```bash
git add -A plugins/delegate tests/delegate
git commit -m "feat(delegate)!: drop execute-plan and legacy lib — runtime fully on vendored shared"
```

---

### Task 10: 人類層 md、版號、structure 測試

**Files:**
- Modify: `plugins/delegate/commands/task.md`
- Modify: `plugins/delegate/.claude-plugin/plugin.json`(0.1.1 → 0.2.0)
- Modify: `.claude-plugin/marketplace.json`(delegate 0.2.0)
- Modify: `tests/delegate/plugin-structure.test.mjs`
- Modify: `tests/fleet-structure.test.mjs`(僅當紅;最小更新)

- [ ] **Step 1: 更新 plugin-structure 測試**

- 「every command md exists」清單移除 execute-plan
- 「task and execute-plan document the no-profile selection flow」改為只驗 task.md
- 新增:`task.md documents --prompt-file/--json/--resume-job/--read-only and never mentions execute-plan or --resume-id`

Run: `node --test tests/delegate/plugin-structure.test.mjs`
Expected: FAIL(md 還是舊的)

- [ ] **Step 2: 重寫 task.md**

frontmatter `argument-hint` 更新:

```
"<prompt> [--prompt-file <path>] [--profile <name>|--settings <path>] [--background] [--json] [--model <id>] [--read-only] [--resume-job <job>|--resume-last] [--timeout-ms <n>]"
```

內文:Profile selection 一節原樣保留(0.1.1 的流程,spec §2.5 裁定不下沉);移除所有 execute-plan 參照;補一句「長任務建議 `--background`,之後用 `/delegate:status` 或讓編排者用 companion 的 `wait <id>` 等待」。

- [ ] **Step 3: 版號 bump 兩處**

`plugins/delegate/.claude-plugin/plugin.json` 與 `.claude-plugin/marketplace.json` 的 delegate 版號都改 `0.2.0`。

Run: `node --test tests/delegate/plugin-structure.test.mjs tests/fleet-structure.test.mjs`
Expected: PASS。fleet-structure 若因 execute-plan/版號紅,做最小對應更新並在 commit message 引 spec §4。

- [ ] **Step 4: Commit**

```bash
git add plugins/delegate/commands plugins/delegate/.claude-plugin .claude-plugin/marketplace.json tests/delegate/plugin-structure.test.mjs tests/fleet-structure.test.mjs
git commit -m "feat(delegate): v0.2.0 — task.md machine-contract flags, drop execute-plan from command surface"
```

---

### Task 11: 終局驗證

**Files:** Modify: 本 plan 檔(勾 checkbox)

- [ ] **Step 1: drift check 本地重演**

```bash
npm run sync-shared && git diff --exit-code && echo DRIFT-OK
```

Expected: `DRIFT-OK`(Task 1/2 升入 shared 的 args/job-control 已被 sync 帶進 vendored 副本;若 diff 非空表示有人手改了 vendored——修 source 重 sync)。

- [ ] **Step 2: 全套 npm test**

```bash
npm test > /tmp/phase2b-final.txt 2>&1; echo "exit=$?"; node -e "const s=require('fs').readFileSync('/tmp/phase2b-final.txt','utf8');for(const l of s.split('\n'))if(/^# (tests|pass|fail)/.test(l.trim()))console.log(l.trim())"
```

Expected: exit=0,五套全綠;codex/antigravity pass 數與 Task 0 基線完全一致(它們一個檔都不准動)。

- [ ] **Step 3: 鐵律終驗**

```bash
git diff main..HEAD --stat -- plugins/codex plugins/antigravity tests/codex tests/antigravity | head -3
```

Expected: 空輸出。

- [ ] **Step 4: 勾掉本 plan 全部 checkbox 並 commit**

```bash
git add docs/plans/2026-06-12-phase2b-delegate.md
git commit -m "feat(delegate): phase 2B complete — delegate on shared foundation"
```

- [ ] **Step 5: 收工回報**

回報:分支名、npm test 末行統計、`git log --oneline main..HEAD`。push/PR 留使用者。真實端點冒煙(deepseek profile 真 job)為人工關卡,不在本 plan。

---

## Self-Review 紀錄

- Spec 覆蓋:§2.1 旗標全表(Task 6:prompt-file/wait/json/model/read-only/resume-job;Task 8:wait/logs 動詞)、§2.2 投影(resultProjection)、§3 目錄式佈局與 `delegate-` id(Task 6 斷言)、§5 vendor+drift(Task 3)、cancel 兩段式(Task 2 註解+測試)、§8 step 2 全項(execute-plan 刪除、--resume-id 改名、舊 lib 清理)。
- 機器層合約中 `--write` 旗標:接受但為 no-op 同義詞(預設即 bypass)——Task 6 的 TASK_FLAGS 含 write,行為由 read-only 反向定義,plan 如此設計避免雙旗標衝突矩陣。
- 刻意不在本 plan:fleet skill、真實冒煙(人工關卡)、antigravity/codex 的 wait/logs(Plan C/D)。
- 型別一致:resultProjection 欄位 ↔ spec §2.2;adapter usage 欄位 ↔ shared worker 的 `result.usage ?? null`;conformance 斷言值 ↔ fake-claude conf-* 輸出已逐字對齊。

---

## Phase 2B 最終審查 follow-ups(Task 3/4 對抗式審查,2026-06-17)

5 視角對抗審查 + 對抗式驗證結論:Task 3(vendor)+ Task 4(adapter)合規、conformance-ready(10 劇本逐一追蹤皆會過)、鐵律未碰 codex/antigravity、全套綠。**0 blocking。** 一個 confirmed should-fix 與數個 minor 皆為 latent / 跨任務,鍵結到對應後續 task:

**→ Task 5(conformance)實作時注意:**
- `conf-instant-exit`(`process.exit(7)`)必須放在「讀 stdin」之前(比照既有 `early-exit`),否則 EPIPE 行為不一致。Task 5 step 1 註解已提及,審查再次確認為 conformance 風險。

**→ Task 6(companion 重構)一併處理(confirmed should-fix 的正確歸宿):**
- adapter `buildInvocation` 目前 `resolveProfile({ settingsPath: request.settingsPath })` 只轉 settingsPath。by-name profile 解析依設計是 companion 的職責(adapter 只消費已解析路徑),但若 request 無 settingsPath,resolveProfile 落入 by-name 分支會因 `dataRoot=undefined` 丟原始 `TypeError` 而非 `ProfileError`(**latent**:companion 一律存明確 `profile.path`,目前不可達;job 仍達終態,不變量不破)。Task 6 建 companion 解析流時:(a) 確保 adapter 收到的 settingsPath 為已解析的 `profile.path`;(b) 考慮在 `buildInvocation` 對缺 settingsPath 給明確 precondition 錯誤。
- 連帶:`buildClaudeArgs` 在 settingsPath undefined 時會 push `--settings null`(同根因,目前被上述 TypeError 遮蔽);Task 6 確立 settingsPath 來源後一併避免。

**→ 低優先強化(任一後續 task 順手可做,非必須,皆 minor):**
- `classifyError` 正則為子字串比對(`'401'` 命中 `'1401'` 等);僅在**已失敗** job 上 mislabel errorKind、不會翻轉成敗。可加 word boundary(`\b401\b` 等),不影響 conf-auth-expire-midway。
- `extractResult(events)` 丟掉合約宣告的第二參數 `exitCode`(claude stream-json 的 `is_error` 已涵蓋);可改 `extractResult(events, _exitCode)` 或加註解澄清,無行為變更。
- `binaryArgv`(來自 request)無 `Array.isArray` 型別檢查;stateDir 0700 / job.json 0600 已限本人,低風險。
- `parseEvent` 的 `Boolean(is_error)` 與接受空 `session_id` — 沿襲前身 `claude.mjs` 行為,真實 claude 不會觸發,非回歸。
- `sync-shared` 的 `VENDORED.md` 於 `cpSync` 後寫;cpSync 中途失敗會留不完整副本,但 CI drift check 會抓到(可接受)。
