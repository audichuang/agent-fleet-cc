# Phase 2A — Shared Core(job runtime 地基 + conformance)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `shared/lib`(core / runtime / adapter-api)與 conformance suite,純新增、不動三個既有 plugin,`npm test` 全綠收工。

**Architecture:** Ports & Adapters——core 是零 I/O 假設的 job 狀態機與 store(目錄式 per-job、O_EXCL CAS 終態),runtime 是吃 EngineAdapter 的通用 worker(process-group spawn/kill、env 消毒強制),conformance 是參數化十劇本套件,先以 reference adapter 驗框架自身。

**Tech Stack:** Node ≥22.3(建議 24,見 ci.yml 註解)、`node --test`、零外部依賴。

**Spec:** `docs/specs/2026-06-12-phase2-shared-foundation-design.md`(§2.3 wait/logs、§3 schema、§5 不變量、§7 測試)。
**計畫鏈:** 本檔是 Phase 2 四份串行 plan 的第一份(A:shared core → B:delegate 移植 → C:antigravity 移植 → D:codex + fleet + 收尾)。B/C/D 在 A 收工後各自撰寫。
**串行鐵則:** task 依序執行,每個 task 最後一步全套測試綠才進下一個。

---

## 基線(Task 0 填寫)

- 既有測試基線:(Task 0 記錄)
- node 版本:(Task 0 記錄)
- auth 探測:(Task 0 記錄;失敗不擋 A–C,只影響 Phase 2D 的人工冒煙關卡)

## File Structure

```
shared/lib/
├── core/
│   ├── job.mjs           # 狀態機常數、newJobId、createJobRecord(統一 schema 工廠)
│   ├── events.mjs        # events.ndjson append/read,五種事件型別
│   ├── state-store.mjs   # 目錄式 per-job store:CRUD、CAS 終態、prune
│   ├── reconcile.mjs     # safePid / isPidAlive / reconcileDeadPids(lock 修復)
│   ├── env.mjs           # buildEngineEnv:deny-prefix 消毒 + 遞迴標記(強制縫)
│   └── wait.mjs          # waitForJob:poll 到終態/超時,events 心跳回呼
├── runtime/
│   ├── spawn.mjs         # spawnEngine(detached=自成 pgid)、killProcessGroup
│   └── worker.mjs        # runWorker(吃 adapter 驅動全生命週期)、installCancelForwarder
├── adapter-api.mjs       # ProcessAdapter 合約 validator
└── adapter-api.md        # 合約散文:雙形態、五不變量
tests/shared/
├── job.test.mjs / events.test.mjs / state-store.test.mjs / state-store-cas.test.mjs
├── prune.test.mjs / reconcile.test.mjs / env.test.mjs / wait.test.mjs
├── spawn.test.mjs / adapter-api.test.mjs / worker.test.mjs
├── adversarial-races.test.mjs            # Task 13 攻擊測試
└── conformance/
    ├── fake-engine.mjs                   # 可腳本化假引擎(FAKE_ENGINE_MODE)
    ├── reference-adapter.mjs             # 玩具 adapter,驗 suite 自身
    ├── conformance.mjs                   # runConformanceSuite(參數化十劇本)
    └── reference.conformance.test.mjs    # 十劇本 × reference adapter
```

設計鐵則(來自 spec):core 零引擎知識;`exitCode` 可為 null;事件必寫;cancel 殺 process group;finalize 冪等且 first-terminal-writer-wins;prune 的 unlink 順序是 load-bearing(json → lock → 目錄)。

---

### Task 0: Pre-flight — 基線、環境、分支

**Files:**
- Modify: `docs/plans/2026-06-12-phase2a-shared-core.md`(回填上方「基線」節)

- [ ] **Step 1: 重驗既有測試基線**

```bash
cd /home/audichuang/research/agent-fleet-cc && node --version && npm test 2>&1 | tail -20
```

Expected: 四套全 pass(上次基線:structure 2 + delegate 91 + antigravity 243 + codex 305 = 641)。若 codex 套件出現 unref'd-timer cancel(node ≥22.22 上游不相容,見 `.github/workflows/ci.yml` 註解),改用 Node 24 重跑;仍有環境性失敗則把失敗清單原文記入本檔「基線」節作 known-fail 白名單——審查者以白名單為準。

- [ ] **Step 2: auth 探測(記錄,不擋工)**

```bash
codex login status 2>&1 | head -3; ls ~/.claude/plugins/data/delegate/profiles/ 2>/dev/null; command -v agy && agy --version 2>&1 | head -1
```

Expected: 各引擎狀態記入「基線」節(例:codex logged in / deepseek.json 存在 / agy x.y.z)。**勿印出 profile 檔案內容**(含 key)。任何 fail 只標紅 Phase 2D 的人工冒煙關卡。

- [ ] **Step 3: 切實作分支**

```bash
git checkout -b phase2-shared-foundation && git branch --show-current
```

Expected: `phase2-shared-foundation`

- [ ] **Step 4: 回填基線並 commit**

```bash
git add docs/plans/2026-06-12-phase2a-shared-core.md && git commit -m "docs(plan): phase-2a baseline recorded"
```

---

### Task 1: core/job.mjs — 狀態機常數與統一 schema 工廠

**Files:**
- Create: `shared/lib/core/job.mjs`
- Test: `tests/shared/job.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/job.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  newJobId,
  createJobRecord,
} from "../../shared/lib/core/job.mjs";

test("six-state machine sets", () => {
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ["queued", "running"]);
  assert.deepEqual(
    [...TERMINAL_STATUSES].sort(),
    ["cancelled", "completed", "failed", "timed-out"],
  );
});

test("newJobId: prefixed, sortable, unique", () => {
  const a = newJobId("dlg", 1000);
  const b = newJobId("dlg", 2000);
  assert.match(a, /^dlg-[a-z0-9]+-[0-9a-f]{6}$/);
  assert.ok(a < b, "timestamp segment must sort");
  assert.notEqual(newJobId("dlg", 1000), newJobId("dlg", 1000));
});

test("createJobRecord: unified core fields, engine extras under request", () => {
  const job = createJobRecord({
    engine: "delegate",
    title: "fix the bug",
    cwd: "/tmp/ws",
    timeoutMs: 60000,
    request: { profile: "deepseek", model: "deepseek-chat" },
  });
  assert.equal(job.engine, "delegate");
  assert.equal(job.status, "queued");
  assert.equal(job.title, "fix the bug");
  assert.equal(job.model, "deepseek-chat"); // 攤平自 request.model
  assert.equal(job.usage, null);
  assert.equal(job.exitCode, null); // session 型引擎可永遠 null
  assert.equal(job.sessionId, null);
  assert.deepEqual(job.request, { profile: "deepseek", model: "deepseek-chat" });
  assert.ok(job.id.startsWith("delegate-"));
  assert.ok(job.createdAt && job.updatedAt);
});

test("createJobRecord rejects unknown engine-less record", () => {
  assert.throws(() => createJobRecord({}), /engine/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/job.test.mjs`
Expected: FAIL — `Cannot find module .../shared/lib/core/job.mjs`

- [ ] **Step 3: 最小實作**

```js
// shared/lib/core/job.mjs
import crypto from "node:crypto";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
]);

export function newJobId(prefix, now = Date.now()) {
  return `${prefix}-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

// 統一 Job schema 工廠(spec §3)。核心欄位攤平;引擎特定參數整包進 request。
export function createJobRecord({
  engine,
  title = "",
  cwd = process.cwd(),
  timeoutMs = null,
  request = {},
  now = new Date(),
} = {}) {
  if (!engine) throw new Error("createJobRecord requires an engine name");
  const iso = now.toISOString();
  return {
    id: newJobId(engine, now.getTime()),
    engine,
    status: "queued",
    createdAt: iso,
    updatedAt: iso,
    title,
    cwd,
    pid: null,
    sessionId: null,
    exitCode: null, // session 型引擎無單一退出碼 — 永遠允許 null
    error: null,
    errorKind: null,
    phase: null,
    resultText: null,
    durationMs: null,
    timeoutMs,
    model: request.model ?? null,
    usage: null, // { inputTokens, outputTokens } | null — 成本遙測
    request,
  };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/job.test.mjs`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/job.mjs tests/shared/job.test.mjs
git commit -m "feat(shared): job state machine constants and unified schema factory"
```

---

### Task 2: core/events.mjs — 觀測脊椎

**Files:**
- Create: `shared/lib/core/events.mjs`
- Test: `tests/shared/events.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/events.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EVENT_TYPES,
  appendEvent,
  readEvents,
  eventsFilePath,
} from "../../shared/lib/core/events.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-events-"));

test("five canonical event types", () => {
  assert.deepEqual(EVENT_TYPES, [
    "job-created",
    "spawned",
    "engine-event",
    "result",
    "finalized",
  ]);
});

test("appendEvent writes one NDJSON line with ts and type", () => {
  const dir = tmp();
  appendEvent(dir, "job-created", { engine: "delegate" });
  appendEvent(dir, "engine-event", { raw: '{"type":"result"}' });
  const lines = fs.readFileSync(eventsFilePath(dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.type, "job-created");
  assert.equal(first.engine, "delegate");
  assert.ok(first.ts);
});

test("appendEvent rejects unknown type", () => {
  assert.throws(() => appendEvent(tmp(), "weird", {}), /unknown event type/);
});

test("readEvents tolerates junk lines and missing file", () => {
  const dir = tmp();
  assert.deepEqual(readEvents(dir), []);
  appendEvent(dir, "result", { ok: true });
  fs.appendFileSync(eventsFilePath(dir), "not-json\n");
  appendEvent(dir, "finalized", { status: "completed" });
  const events = readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[1].status, "completed");
});

test("readEvents supports offset for incremental tail", () => {
  const dir = tmp();
  appendEvent(dir, "job-created", {});
  appendEvent(dir, "result", {});
  const all = readEvents(dir);
  const tail = readEvents(dir, { afterIndex: 0 });
  assert.equal(all.length, 2);
  assert.deepEqual(tail, all.slice(1));
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/events.test.mjs`
Expected: FAIL — `Cannot find module .../events.mjs`

- [ ] **Step 3: 最小實作**

```js
// shared/lib/core/events.mjs
import fs from "node:fs";
import path from "node:path";

// 正規化事件最小集(spec §3)。狀態真相在 job.json;這裡是觀測脊椎。
export const EVENT_TYPES = [
  "job-created",
  "spawned",
  "engine-event",
  "result",
  "finalized",
];
const TYPE_SET = new Set(EVENT_TYPES);

export function eventsFilePath(jobDir) {
  return path.join(jobDir, "events.ndjson");
}

export function appendEvent(jobDir, type, data = {}) {
  if (!TYPE_SET.has(type)) throw new Error(`unknown event type: ${type}`);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
  fs.appendFileSync(eventsFilePath(jobDir), line + "\n", { mode: 0o600 });
}

export function readEvents(jobDir, { afterIndex = -1 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(eventsFilePath(jobDir), "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && TYPE_SET.has(parsed.type)) events.push(parsed);
    } catch {
      // junk line — 容錯跳過,永不 fatal
    }
  }
  return events.slice(afterIndex + 1);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/events.test.mjs`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/events.mjs tests/shared/events.test.mjs
git commit -m "feat(shared): normalized event log (observability spine)"
```

---

### Task 3: core/state-store.mjs — 目錄式 store 基礎

**Files:**
- Create: `shared/lib/core/state-store.mjs`
- Test: `tests/shared/state-store.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/state-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { readEvents } from "../../shared/lib/core/events.mjs";
import {
  jobDir,
  jobFilePath,
  promptFilePath,
  logFilePath,
  createJob,
  readJob,
  writeJob,
  listJobs,
} from "../../shared/lib/core/state-store.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-store-"));

test("createJob lays out per-job directory with 0600 artifacts", () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "delegate", title: "t" });
  createJob(stateDir, record, "do the thing");
  assert.equal(readJob(stateDir, record.id).title, "t");
  assert.equal(fs.readFileSync(promptFilePath(stateDir, record.id), "utf8"), "do the thing");
  const mode = fs.statSync(jobFilePath(stateDir, record.id)).mode & 0o777;
  assert.equal(mode, 0o600);
  const events = readEvents(jobDir(stateDir, record.id));
  assert.equal(events[0].type, "job-created");
  assert.equal(events[0].engine, "delegate");
});

test("writeJob stamps updatedAt atomically; readJob null on missing/corrupt", () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "delegate" });
  createJob(stateDir, record, "p");
  const before = readJob(stateDir, record.id).updatedAt;
  writeJob(stateDir, { ...record, phase: "working" });
  const after = readJob(stateDir, record.id);
  assert.equal(after.phase, "working");
  assert.ok(after.updatedAt >= before);
  assert.equal(readJob(stateDir, "nope"), null);
  fs.writeFileSync(jobFilePath(stateDir, record.id), "{broken");
  assert.equal(readJob(stateDir, record.id), null);
});

test("listJobs scans job dirs, skips corrupt, sorts newest first", () => {
  const stateDir = tmp();
  const a = createJobRecord({ engine: "delegate", now: new Date(1000) });
  const b = createJobRecord({ engine: "delegate", now: new Date(2000) });
  createJob(stateDir, a, "a");
  createJob(stateDir, b, "b");
  fs.mkdirSync(path.join(stateDir, "jobs", "junk-dir"), { recursive: true });
  const jobs = listJobs(stateDir);
  assert.deepEqual(jobs.map((j) => j.id), [b.id, a.id]);
  assert.equal(logFilePath(stateDir, a.id), path.join(stateDir, "jobs", a.id, "log"));
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/state-store.test.mjs`
Expected: FAIL — `Cannot find module .../state-store.mjs`

- [ ] **Step 3: 最小實作**

```js
// shared/lib/core/state-store.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TERMINAL_STATUSES } from "./job.mjs";
import { appendEvent } from "./events.mjs";

// 目錄式佈局(spec §3):jobs/<id>/{job.json,prompt.txt,events.ndjson,log}
export function jobsRoot(stateDir) {
  return path.join(stateDir, "jobs");
}
export function jobDir(stateDir, jobId) {
  return path.join(jobsRoot(stateDir), jobId);
}
export function jobFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "job.json");
}
export function promptFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "prompt.txt");
}
export function logFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "log");
}
export function lockFilePath(stateDir, jobId) {
  return path.join(jobDir(stateDir, jobId), "terminal.lock");
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  // 0600/0700:job 目錄含 prompt/result/log — 一律 owner-only。
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createJob(stateDir, record, prompt) {
  const dir = jobDir(stateDir, record.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(promptFilePath(stateDir, record.id), prompt, { mode: 0o600 });
  writeJsonAtomic(jobFilePath(stateDir, record.id), record);
  appendEvent(dir, "job-created", { engine: record.engine, jobId: record.id });
  return record;
}

export function writeJob(stateDir, job) {
  writeJsonAtomic(jobFilePath(stateDir, job.id), {
    ...job,
    updatedAt: new Date().toISOString(),
  });
}

export function readJob(stateDir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFilePath(stateDir, jobId), "utf8"));
  } catch {
    return null;
  }
}

export function listJobs(stateDir) {
  let entries;
  try {
    entries = fs.readdirSync(jobsRoot(stateDir));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of entries) {
    const job = readJob(stateDir, name);
    if (job) jobs.push(job); // 壞目錄/in-flight — 跳過,永不 fatal
  }
  return jobs.sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/state-store.test.mjs`
Expected: PASS(3 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/state-store.mjs tests/shared/state-store.test.mjs
git commit -m "feat(shared): per-job directory state store (CRUD layer)"
```

---

### Task 4: state-store CAS — first-terminal-writer-wins

**Files:**
- Modify: `shared/lib/core/state-store.mjs`(追加 CAS 區段)
- Test: `tests/shared/state-store-cas.test.mjs`

CAS 不變量沿地基母體 delegate(`plugins/delegate/scripts/lib/state.mjs`)逐條保留:lock 內容記 intended status 供修復;finalize 前後雙重讀;fresh-merge 保住 worker 的 pid stamp;`markJobRunning` 寫後重查 lock。

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/state-store-cas.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import {
  createJob,
  readJob,
  writeJob,
  finalizeJob,
  markJobRunning,
  readTerminalLock,
  lockFilePath,
  jobFilePath,
} from "../../shared/lib/core/state-store.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cas-"));
const mkJob = (stateDir) => {
  const record = createJobRecord({ engine: "delegate" });
  createJob(stateDir, record, "p");
  return record;
};

test("finalizeJob requires a terminal status", () => {
  const s = tmp();
  const j = mkJob(s);
  assert.throws(() => finalizeJob(s, j.id, { status: "running" }), /terminal/);
});

test("first terminal writer wins; loser returns false and cannot overwrite", () => {
  const s = tmp();
  const j = mkJob(s);
  assert.equal(finalizeJob(s, j.id, { status: "completed", resultText: "ok" }), true);
  assert.equal(finalizeJob(s, j.id, { status: "cancelled" }), false);
  const final = readJob(s, j.id);
  assert.equal(final.status, "completed");
  assert.equal(final.resultText, "ok");
  assert.deepEqual(readTerminalLock(s, j.id), { status: "completed" });
});

test("finalize fresh-merges fields written after first read (worker pid stamp)", () => {
  const s = tmp();
  const j = mkJob(s);
  writeJob(s, { ...readJob(s, j.id), pid: 4242, status: "running" });
  assert.equal(finalizeJob(s, j.id, { status: "cancelled" }), true);
  assert.equal(readJob(s, j.id).pid, 4242); // cancelJob 之後靠它找 pid
});

test("markJobRunning loses to a claimed lock (pre and post write)", () => {
  const s = tmp();
  const a = mkJob(s);
  assert.equal(finalizeJob(s, a.id, { status: "cancelled" }), true);
  assert.equal(markJobRunning(s, a.id, { pid: 1 }), null); // pre-check

  const b = mkJob(s);
  const result = markJobRunning(s, b.id, { pid: 2 }, {
    beforeRecheck() {
      // 殘餘競態:寫 running 與重查之間,lock 出現
      fs.writeFileSync(
        lockFilePath(s, b.id),
        JSON.stringify({ status: "cancelled" }),
        { flag: "wx", mode: 0o600 },
      );
    },
  });
  assert.equal(result, null); // 呼叫端絕不可在 null 時 spawn
});

test("legacy/garbage lock content yields { status: null } not a crash", () => {
  const s = tmp();
  const j = mkJob(s);
  fs.writeFileSync(lockFilePath(s, j.id), "12345"); // JSON.parse("12345") 是合法 JSON
  assert.deepEqual(readTerminalLock(s, j.id), { status: null });
});

test("finalize after prune removed job.json undoes its own lock", () => {
  const s = tmp();
  const j = mkJob(s);
  // 模擬 prune 已刪 job.json(prune 順序:json 先於 lock)
  fs.unlinkSync(jobFilePath(s, j.id));
  assert.equal(finalizeJob(s, j.id, { status: "failed" }), false);
  assert.equal(fs.existsSync(lockFilePath(s, j.id)), false); // undo 自己的 claim
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/state-store-cas.test.mjs`
Expected: FAIL — `finalizeJob is not a function`(等 export)

- [ ] **Step 3: 在 state-store.mjs 追加 CAS 區段**

```js
// shared/lib/core/state-store.mjs — 追加在檔尾

// Cross-process CAS:O_EXCL lock,first terminal writer wins。lock 內容記
// intended status,讓修復路徑(reconcile)能在 winner 死於 claim 與寫 JSON
// 之間時把轉移補完。
function claimTerminalTransition(stateDir, jobId, status) {
  fs.mkdirSync(jobDir(stateDir, jobId), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      lockFilePath(stateDir, jobId),
      JSON.stringify({ pid: process.pid, status, at: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// null = 無 lock;{ status } = 已被 claim。內容可能是垃圾 — JSON.parse("12345")
// 是合法 JSON(數字),guard 必須驗「物件且帶已知終態」。
export function readTerminalLock(stateDir, jobId) {
  let raw;
  try {
    raw = fs.readFileSync(lockFilePath(stateDir, jobId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && TERMINAL_STATUSES.has(parsed.status)) {
      return { status: parsed.status };
    }
  } catch {}
  return { status: null };
}

export function finalizeJob(stateDir, jobId, patch) {
  if (!TERMINAL_STATUSES.has(patch.status)) {
    throw new Error(`finalizeJob requires a terminal status, got ${patch.status}`);
  }
  // 終態 JSON 表示有人已贏過 CAS — 即使 lock 被 prune 掉也要拒絕,
  // 讓 stale finalizer 永遠無法復活已 prune 的 job。
  const existing = readJob(stateDir, jobId);
  if (!existing || TERMINAL_STATUSES.has(existing.status)) return false;
  if (!claimTerminalTransition(stateDir, jobId, patch.status)) return false;
  // claim 後重讀:prune 若在中間刪了 JSON,undo 自己的 lock 並退出。
  // 安全性依賴 prune 的 unlink 順序(json 先於 lock,見 pruneJobs)。
  const fresh = readJob(stateDir, jobId);
  if (!fresh) {
    try {
      fs.unlinkSync(lockFilePath(stateDir, jobId));
    } catch {}
    return false;
  }
  // fresh-merge 保住第一次讀之後寫入的欄位(如 worker 的 pid stamp)—
  // cancelJob 靠它找到要 signal 的 pid。
  writeJob(stateDir, { ...fresh, ...patch });
  return true;
}

// queued → running,防著並發 canceller。回傳 running job;null 表示
// job 不在/已終態/lock 已被 claim — 呼叫端絕不可在 null 時 spawn。
// hooks.beforeRecheck 是測試縫。
export function markJobRunning(stateDir, jobId, patch = {}, hooks = {}) {
  if (readTerminalLock(stateDir, jobId)) return null;
  const job = readJob(stateDir, jobId);
  if (!job || TERMINAL_STATUSES.has(job.status)) return null;
  writeJob(stateDir, { ...job, ...patch, status: "running" });
  hooks.beforeRecheck?.();
  if (readTerminalLock(stateDir, jobId)) return null;
  return readJob(stateDir, jobId);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/state-store-cas.test.mjs tests/shared/state-store.test.mjs`
Expected: PASS(6 + 3 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/state-store.mjs tests/shared/state-store-cas.test.mjs
git commit -m "feat(shared): O_EXCL CAS terminal transitions (first-terminal-writer-wins)"
```

---

### Task 5: pruneJobs — 目錄式 prune,unlink 順序是 load-bearing

**Files:**
- Modify: `shared/lib/core/state-store.mjs`(追加 pruneJobs)
- Test: `tests/shared/prune.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/prune.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import {
  createJob,
  finalizeJob,
  pruneJobs,
  listJobs,
  jobDir,
} from "../../shared/lib/core/state-store.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-prune-"));

function mkTerminal(stateDir, ts) {
  const r = createJobRecord({ engine: "delegate", now: new Date(ts) });
  createJob(stateDir, r, "p");
  finalizeJob(stateDir, r.id, { status: "completed" });
  return r;
}

test("prune keeps newest terminal jobs up to max minus active", () => {
  const s = tmp();
  const old1 = mkTerminal(s, 1000);
  const old2 = mkTerminal(s, 2000);
  const keep = mkTerminal(s, 3000);
  const active = createJobRecord({ engine: "delegate", now: new Date(4000) });
  createJob(s, active, "p"); // queued — 不可被 prune
  pruneJobs(s, { max: 2 }); // 2 - 1 active = 保 1 個 terminal
  const ids = listJobs(s).map((j) => j.id).sort();
  assert.deepEqual(ids, [active.id, keep.id].sort());
  assert.equal(fs.existsSync(jobDir(s, old1.id)), false); // 整目錄消失
  assert.equal(fs.existsSync(jobDir(s, old2.id)), false);
});

test("prune never removes active jobs even when over max", () => {
  const s = tmp();
  const a = createJobRecord({ engine: "delegate" });
  createJob(s, a, "p");
  pruneJobs(s, { max: 0 });
  assert.equal(listJobs(s).length, 1);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/prune.test.mjs`
Expected: FAIL — `pruneJobs is not a function`

- [ ] **Step 3: 實作(追加檔尾)**

```js
// shared/lib/core/state-store.mjs — 追加在檔尾
import { ACTIVE_STATUSES } from "./job.mjs"; // ← 併入檔頭既有 import:
// import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./job.mjs";

export function pruneJobs(stateDir, { max = 50 } = {}) {
  const jobs = listJobs(stateDir);
  const activeCount = jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const terminal = jobs
    .filter((j) => TERMINAL_STATUSES.has(j.status))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const keep = Math.max(0, max - activeCount);
  for (const job of terminal.slice(keep)) {
    // unlink 順序是 load-bearing:job.json 必須先於 terminal.lock 消失。
    // finalizeJob 在 claim 後 re-read JSON,靠「lock 可被 prune ⇒ JSON 已不在」
    // 偵測並 undo post-prune claim。目錄最後整個移除。
    try {
      fs.unlinkSync(jobFilePath(stateDir, job.id));
    } catch {}
    try {
      fs.unlinkSync(lockFilePath(stateDir, job.id));
    } catch {}
    fs.rmSync(jobDir(stateDir, job.id), { recursive: true, force: true });
  }
}
```

(實作時把 `ACTIVE_STATUSES` 併進檔頭既有的 `./job.mjs` import,不要重複 import 行。)

- [ ] **Step 4: 跑 shared 全套確認通過**

Run: `node --test tests/shared/*.test.mjs`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/state-store.mjs tests/shared/prune.test.mjs
git commit -m "feat(shared): directory-wise prune preserving CAS unlink-order invariant"
```

---

### Task 6: core/reconcile.mjs — 死 PID 探活與 lock 修復

**Files:**
- Create: `shared/lib/core/reconcile.mjs`
- Test: `tests/shared/reconcile.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/reconcile.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import {
  createJob,
  readJob,
  writeJob,
  finalizeJob,
  lockFilePath,
} from "../../shared/lib/core/state-store.mjs";
import {
  safePid,
  reconcileDeadPids,
} from "../../shared/lib/core/reconcile.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-rec-"));

test("safePid rejects group-kill footguns", () => {
  assert.equal(safePid(0), null);
  assert.equal(safePid(-1), null);
  assert.equal(safePid(1), null);
  assert.equal(safePid("12abc"), null);
  assert.equal(safePid("4242"), 4242);
  assert.equal(safePid(4242), 4242);
});

test("running job with dead pid is reconciled to failed via CAS", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  const reconciled = reconcileDeadPids(s, { isAlive: () => false });
  assert.deepEqual(reconciled, [j.id]);
  const final = readJob(s, j.id);
  assert.equal(final.status, "failed");
  assert.match(final.error, /reconciled dead pid/);
});

test("live worker is left alone", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: process.pid });
  assert.deepEqual(reconcileDeadPids(s, { isAlive: () => true }), []);
  assert.equal(readJob(s, j.id).status, "running");
});

test("claimed lock with dead finalizer converges JSON from lock content", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });
  // 模擬 finalizer 死於 claim 與寫 JSON 之間
  fs.writeFileSync(
    lockFilePath(s, j.id),
    JSON.stringify({ pid: 1, status: "cancelled" }),
    { mode: 0o600 },
  );
  const reconciled = reconcileDeadPids(s, { isAlive: () => false });
  assert.deepEqual(reconciled, [j.id]);
  assert.equal(readJob(s, j.id).status, "cancelled"); // 用 lock 的 intended status
});

test("terminal jobs are never touched", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  finalizeJob(s, j.id, { status: "completed" });
  assert.deepEqual(reconcileDeadPids(s, { isAlive: () => false }), []);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/reconcile.test.mjs`
Expected: FAIL — `Cannot find module .../reconcile.mjs`

- [ ] **Step 3: 最小實作**

```js
// shared/lib/core/reconcile.mjs
import { TERMINAL_STATUSES } from "./job.mjs";
import {
  listJobs,
  readJob,
  writeJob,
  finalizeJob,
  readTerminalLock,
} from "./state-store.mjs";

// 只 signal 真實單一程序 pid。process.kill() 樂於接受 0/負數/數字字串並
// signal 整個 process group(kill(-1) = 所有程序)— 被污染的 job JSON
// 永遠不可有這個能力。
export function safePid(pid) {
  const n = typeof pid === "string" && /^\d+$/.test(pid) ? Number(pid) : pid;
  return Number.isInteger(n) && n > 1 ? n : null;
}

export function isPidAlive(pid) {
  const n = safePid(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function reconcileDeadPids(stateDir, deps = {}) {
  const isAlive = deps.isAlive ?? isPidAlive;
  const reconciled = [];
  for (const job of listJobs(stateDir)) {
    if (TERMINAL_STATUSES.has(job.status)) continue;
    const pid = safePid(job.pid);
    const lock = readTerminalLock(stateDir, job.id);
    if (lock) {
      // 終態被 claim 但 JSON 沒跟上(finalizer 死了,或 worker 的 running 寫
      // 覆蓋了)。替 winner 補完:直接 writeJob 是對的 — lock 已存在表示
      // CAS 早就贏了;此操作冪等。
      if (pid && isAlive(pid)) continue; // 活著的 worker 會自己收斂
      writeJob(stateDir, {
        ...job,
        status: lock.status ?? "failed",
        error: job.error ?? "finalizer died mid-transition (repaired from lock)",
      });
      reconciled.push(job.id);
      continue;
    }
    if (job.status !== "running" || !pid) continue;
    if (isAlive(pid)) continue;
    if (
      finalizeJob(stateDir, job.id, {
        status: "failed",
        error: "worker process died (reconciled dead pid)",
      })
    ) {
      reconciled.push(job.id);
    }
  }
  return reconciled;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/reconcile.test.mjs`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/reconcile.mjs tests/shared/reconcile.test.mjs
git commit -m "feat(shared): dead-pid reconcile with lock-repair convergence"
```

---

### Task 7: core/env.mjs — 強制 env 消毒縫(spec §5 防遞迴上移)

**Files:**
- Create: `shared/lib/core/env.mjs`
- Test: `tests/shared/env.test.mjs`

來源邏輯:`plugins/delegate/scripts/lib/env.mjs`(buildDelegateEnv)一般化——deny prefixes、preserved keys、遞迴標記全部參數化,worker 在 spawn 前強制套用(Task 11)。

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/env.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngineEnv,
  DENY_PREFIXES,
} from "../../shared/lib/core/env.mjs";

test("strips inherited provider/runtime vars by deny prefix", () => {
  const env = buildEngineEnv({
    baseEnv: {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "leak",
      CLAUDE_PROJECT_DIR: "/x",
      CLAUDECODE: "1",
      HOME: "/home/u",
    },
    recursionMarker: "FLEET_TEST_ACTIVE",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/u");
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("CLAUDE_PROJECT_DIR" in env, false);
  assert.equal("CLAUDECODE" in env, false);
});

test("CLAUDE_CONFIG_DIR survives by default (ecosystem reuse)", () => {
  const env = buildEngineEnv({
    baseEnv: { CLAUDE_CONFIG_DIR: "/custom" },
    recursionMarker: "M",
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/custom");
});

test("engineEnv injects after strip and coerces primitives; recursion marker set", () => {
  const env = buildEngineEnv({
    baseEnv: { ANTHROPIC_BASE_URL: "inherited-evil" },
    engineEnv: {
      ANTHROPIC_BASE_URL: "https://profile-endpoint",
      RETRIES: 3,
      SKIP_ME: null,
      ALSO_SKIP: { nested: true },
    },
    recursionMarker: "CLAUDE_DELEGATE_ACTIVE",
  });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://profile-endpoint");
  assert.equal(env.RETRIES, "3");
  assert.equal("SKIP_ME" in env, false);
  assert.equal("ALSO_SKIP" in env, false);
  assert.equal(env.CLAUDE_DELEGATE_ACTIVE, "1");
});

test("recursionMarker is required — adapters cannot opt out", () => {
  assert.throws(() => buildEngineEnv({ baseEnv: {} }), /recursionMarker/);
  assert.deepEqual(DENY_PREFIXES, ["ANTHROPIC_", "CLAUDE_", "CLAUDECODE"]);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/env.test.mjs`
Expected: FAIL — `Cannot find module .../env.mjs`

- [ ] **Step 3: 最小實作**

```js
// shared/lib/core/env.mjs
// 引擎 env 是重建的,不是繼承的(delegate「env 完全重建」的一般化,spec §5)。
// 剝掉主 session 注入的 provider/runtime 變數 → 疊加 adapter/profile 顯式 env
// → 設遞迴守衛標記。worker 在 spawn 前強制走這裡,adapter 不可繞過。
export const DENY_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CLAUDECODE"];
// 刻意保留:使用者級 skills/subagents 活在(可能自訂的)config dir 下,
// 剝掉它會毀掉生態重用;模型路由隔離仍由 strip + 顯式注入保證。
export const DEFAULT_PRESERVED = new Set(["CLAUDE_CONFIG_DIR"]);

export function buildEngineEnv({
  baseEnv = process.env,
  engineEnv = {},
  recursionMarker,
  preserveKeys = DEFAULT_PRESERVED,
  denyPrefixes = DENY_PREFIXES,
} = {}) {
  if (!recursionMarker) {
    throw new Error("buildEngineEnv requires a recursionMarker (recursion guard is not optional)");
  }
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (denyPrefixes.some((p) => key.startsWith(p)) && !preserveKeys.has(key)) {
      continue;
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(engineEnv)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    env[key] = String(value);
  }
  env[recursionMarker] = "1";
  return env;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/env.test.mjs`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/env.mjs tests/shared/env.test.mjs
git commit -m "feat(shared): mandatory env sanitization seam with recursion guard"
```

---

### Task 8: core/wait.mjs — waitForJob(編排 re-entry 的 core 函式)

**Files:**
- Create: `shared/lib/core/wait.mjs`
- Test: `tests/shared/wait.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/wait.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { appendEvent } from "../../shared/lib/core/events.mjs";
import {
  createJob,
  finalizeJob,
  jobDir,
} from "../../shared/lib/core/state-store.mjs";
import { waitForJob } from "../../shared/lib/core/wait.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wait-"));

test("resolves done=true when job reaches terminal state, streaming new events", async () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  const seen = [];
  setTimeout(() => {
    appendEvent(jobDir(s, j.id), "engine-event", { raw: "tick" });
    finalizeJob(s, j.id, { status: "completed", resultText: "done" });
  }, 30);
  const out = await waitForJob({
    stateDir: s,
    jobId: j.id,
    timeoutMs: 5000,
    pollMs: 10,
    onEvent: (e) => seen.push(e.type),
  });
  assert.equal(out.done, true);
  assert.equal(out.job.status, "completed");
  assert.ok(seen.includes("engine-event")); // 心跳:新事件有透傳
});

test("resolves done=false on timeout with current job snapshot", async () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  const out = await waitForJob({ stateDir: s, jobId: j.id, timeoutMs: 50, pollMs: 10 });
  assert.equal(out.done, false);
  assert.equal(out.job.status, "queued");
});

test("missing job resolves done=true with job=null (nothing to wait for)", async () => {
  const out = await waitForJob({ stateDir: tmp(), jobId: "ghost", timeoutMs: 50, pollMs: 10 });
  assert.equal(out.done, true);
  assert.equal(out.job, null);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/wait.test.mjs`
Expected: FAIL — `Cannot find module .../wait.mjs`

- [ ] **Step 3: 最小實作**

```js
// shared/lib/core/wait.mjs
import { TERMINAL_STATUSES } from "./job.mjs";
import { readEvents } from "./events.mjs";
import { readJob, jobDir } from "./state-store.mjs";

// 編排 re-entry 動詞的核心(spec §2.3):poll 到終態或超時,把新增 events
// 透傳給 onEvent 當進度心跳。超時不是錯誤 — 回 done:false 由呼叫端再 wait。
export function waitForJob({
  stateDir,
  jobId,
  timeoutMs,
  pollMs = 500,
  onEvent = () => {},
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  nowImpl = Date.now,
}) {
  const deadline = nowImpl() + timeoutMs;
  let emitted = -1;
  const drain = () => {
    const fresh = readEvents(jobDir(stateDir, jobId), { afterIndex: emitted });
    for (const event of fresh) {
      emitted += 1;
      onEvent(event);
    }
  };
  return (async () => {
    for (;;) {
      const job = readJob(stateDir, jobId);
      drain();
      if (!job) return { done: true, job: null };
      if (TERMINAL_STATUSES.has(job.status)) return { done: true, job };
      if (nowImpl() >= deadline) return { done: false, job };
      await sleepImpl(pollMs);
    }
  })();
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/wait.test.mjs`
Expected: PASS(3 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/core/wait.mjs tests/shared/wait.test.mjs
git commit -m "feat(shared): waitForJob re-entry primitive with event heartbeat"
```

---

### Task 9: runtime/spawn.mjs — process group spawn 與 kill

**Files:**
- Create: `shared/lib/runtime/spawn.mjs`
- Create: `tests/shared/fixtures/grandchild-spawner.mjs`(測試 fixture)
- Test: `tests/shared/spawn.test.mjs`

- [ ] **Step 1: 寫測試 fixture(會生孫子的腳本)**

```js
// tests/shared/fixtures/grandchild-spawner.mjs
// 生一個孫子程序後常駐 — 用來驗 kill(-pgid) 連孫子一起殺。
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
process.stdout.write(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }) + "\n");
setInterval(() => {}, 1000); // 自己也常駐
```

- [ ] **Step 2: 寫失敗測試**

```js
// tests/shared/spawn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnEngine,
  killProcessGroup,
} from "../../shared/lib/runtime/spawn.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "grandchild-spawner.mjs");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
};

test("spawnEngine detaches into its own process group; pgid kill reaps grandchildren", async () => {
  const child = spawnEngine({
    argv: [process.execPath, FIXTURE],
    env: { ...process.env },
    cwd: process.cwd(),
  });
  const line = await new Promise((resolve) => {
    child.stdout.once("data", (chunk) => resolve(chunk.toString()));
  });
  const { childPid, grandchildPid } = JSON.parse(line);
  assert.equal(childPid, child.pid);
  assert.ok(alive(grandchildPid));
  killProcessGroup(child.pid, "SIGKILL");
  assert.ok(await waitGone(childPid), "child must die");
  assert.ok(await waitGone(grandchildPid), "grandchild must die (zombie engines burn API money)");
});

test("killProcessGroup never throws on dead/invalid pgid", () => {
  killProcessGroup(99999999, "SIGTERM");
  killProcessGroup(null, "SIGTERM");
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `node --test tests/shared/spawn.test.mjs`
Expected: FAIL — `Cannot find module .../spawn.mjs`

- [ ] **Step 4: 最小實作**

```js
// shared/lib/runtime/spawn.mjs
import { spawn } from "node:child_process";

// process seam(spec §5):detached:true 讓引擎 child 自成 process group
// (pgid = child.pid)。引擎會帶起孫子(claude -p 的 MCP server 等),
// cancel/timeout 殺 -pgid 才不會留殭屍引擎燒 API 錢。
export function spawnEngine({ argv, env, cwd, spawnImpl = spawn }) {
  const [bin, ...args] = argv;
  return spawnImpl(bin, args, {
    cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function killProcessGroup(pid, signal = "SIGTERM", killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    killImpl(-pid, signal); // 負 pid = 整個 process group
  } catch {}
}

// TERM 先禮後兵,grace 後 KILL。timer unref — 不留住 event loop。
export function killGroupWithGrace(pid, { graceMs = 5000, scheduleImpl = setTimeout, killImpl = process.kill } = {}) {
  killProcessGroup(pid, "SIGTERM", killImpl);
  scheduleImpl(() => killProcessGroup(pid, "SIGKILL", killImpl), graceMs)?.unref?.();
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `node --test tests/shared/spawn.test.mjs`
Expected: PASS(2 tests;第一個測試真實驗證孫子死光)

- [ ] **Step 6: Commit**

```bash
git add shared/lib/runtime/spawn.mjs tests/shared/spawn.test.mjs tests/shared/fixtures/grandchild-spawner.mjs
git commit -m "feat(shared): process-group spawn/kill (grandchildren must die)"
```

---

### Task 10: adapter-api — ProcessAdapter 合約

**Files:**
- Create: `shared/lib/adapter-api.mjs`
- Create: `shared/lib/adapter-api.md`
- Test: `tests/shared/adapter-api.test.mjs`

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/adapter-api.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProcessAdapter } from "../../shared/lib/adapter-api.mjs";

const valid = {
  name: "fake",
  engine: "fake",
  recursionMarker: "FAKE_ACTIVE",
  wantsWatchdog: false,
  buildInvocation: ({ job, prompt }) => ({ argv: ["true"], env: {}, stdinPayload: prompt }),
  parseEvent: (line) => null,
  extractResult: (events, exitCode) => ({ ok: true, resultText: "", sessionId: null }),
  classifyError: (stderrTail, exitCode) => "unknown",
  resumeArgs: (sessionId) => [],
};

test("a complete adapter validates", () => {
  assert.deepEqual(validateProcessAdapter(valid), []);
});

test("missing members are reported by name", () => {
  const { parseEvent, ...broken } = valid;
  const problems = validateProcessAdapter({ ...broken, recursionMarker: "" });
  assert.ok(problems.some((p) => p.includes("parseEvent")));
  assert.ok(problems.some((p) => p.includes("recursionMarker")));
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/adapter-api.test.mjs`
Expected: FAIL — `Cannot find module .../adapter-api.mjs`

- [ ] **Step 3: 實作 validator 與合約文件**

```js
// shared/lib/adapter-api.mjs
// ProcessAdapter 合約(spec §2/§5;藍圖 §5.2)。SessionAdapter 是第二合法
// 形態,無限期延後 — 但形態無關五不變量已寫死於 adapter-api.md,
// conformance 驗的是不變量,日後落地不得重簽。
const REQUIRED_STRINGS = ["name", "engine", "recursionMarker"];
const REQUIRED_FUNCTIONS = [
  "buildInvocation", // ({job, prompt}) → { argv, env, stdinPayload }
  "parseEvent",      // (rawLine) → 正規化事件 | null(容錯跳行)
  "extractResult",   // (events, exitCode) → { ok, resultText, sessionId, usage? }
  "classifyError",   // (stderrTail, exitCode) → errorKind 字串
  "resumeArgs",      // (sessionId) → 額外 argv 片段
];

export function validateProcessAdapter(adapter) {
  const problems = [];
  if (!adapter || typeof adapter !== "object") return ["adapter must be an object"];
  for (const key of REQUIRED_STRINGS) {
    if (typeof adapter[key] !== "string" || !adapter[key]) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  if (typeof adapter.wantsWatchdog !== "boolean") {
    problems.push("wantsWatchdog must be a boolean (reconcile policy declaration)");
  }
  for (const key of REQUIRED_FUNCTIONS) {
    if (typeof adapter[key] !== "function") {
      problems.push(`${key} must be a function`);
    }
  }
  return problems;
}
```

```markdown
<!-- shared/lib/adapter-api.md -->
# EngineAdapter 合約

雙形態:ProcessAdapter(一次性程序)現行;SessionAdapter(常駐 broker)延後。

## 形態無關五不變量(conformance 驗證對象;日後 SessionAdapter 不得重簽)

1. job 必達終態(completed | failed | cancelled | timed-out),永不卡 running。
2. 事件必寫 events.ndjson(job-created / spawned / engine-event / result / finalized)。
3. cancel 必殺乾淨:整個 process group,孫子不留。
4. result 必冪等:重複讀取同一 job 的 result 永遠一致。
5. exitCode 可為 null(session 型引擎無單一退出碼)。

## ProcessAdapter 成員

| 成員 | 型別 | 職責 |
|---|---|---|
| name / engine | string | 顯示名 / 統一 schema 的 engine 值 |
| recursionMarker | string | buildEngineEnv 強制注入的遞迴守衛變數名 |
| wantsWatchdog | boolean | reconcile 雙保險的 watchdog 開關宣告(藍圖 §5.7) |
| buildInvocation({job, prompt}) | fn | → { argv, env, stdinPayload } — env 只放顯式注入(profile 等),消毒由 worker 強制 |
| parseEvent(rawLine) | fn | → 正規化事件 \| null;junk 行回 null,永不 throw |
| extractResult(events, exitCode) | fn | → { ok, resultText, sessionId, usage? } |
| classifyError(stderrTail, exitCode) | fn | → errorKind('auth' \| 'not-installed' \| 'endpoint' \| 'unknown' …) |
| resumeArgs(sessionId) | fn | → 追加 argv 片段(claude:`-r <id>`;agy:`--conversation <id>`) |
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/adapter-api.test.mjs`
Expected: PASS(2 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/adapter-api.mjs shared/lib/adapter-api.md tests/shared/adapter-api.test.mjs
git commit -m "feat(shared): ProcessAdapter contract validator + form-agnostic invariants doc"
```

---

### Task 11: runtime/worker.mjs — 通用 detached worker

**Files:**
- Create: `shared/lib/runtime/worker.mjs`
- Test: `tests/shared/worker.test.mjs`

職責(吃 adapter 驅動完整生命週期):讀 prompt → CAS 標 running → `buildEngineEnv` 強制消毒 → `spawnEngine` → 逐行 log + `parseEvent` → `extractResult`/`classifyError` → CAS finalize + result/finalized events。cancel 經 SIGTERM 轉發成 pgid kill。timeout 政策在 worker(`job.timeoutMs`)。

- [ ] **Step 1: 寫失敗測試**

```js
// tests/shared/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import { readEvents } from "../../shared/lib/core/events.mjs";
import {
  createJob,
  readJob,
  finalizeJob,
  jobDir,
  logFilePath,
} from "../../shared/lib/core/state-store.mjs";
import { runWorker } from "../../shared/lib/runtime/worker.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-worker-"));

// 假 child:stdout/stderr 必須是真 stream(readline 吃 Readable),
// EventEmitter 模擬 data 事件不可靠。
function fakeChild({ lines = [], exitCode = 0, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write() {}, end() {}, on() {} };
  child.kill = () => {};
  child.emitAll = () => {
    for (const line of lines) child.stdout.write(line + "\n");
    if (stderr) child.stderr.write(stderr);
    child.stderr.end();
    // 'close' 必須等 stdout 被 readline 消費完(模擬真實 child_process 的
    // close-after-stdio 語意),否則尾行事件會漏。
    child.stdout.on("end", () => setImmediate(() => child.emit("close", exitCode, null)));
    child.stdout.end();
  };
  return child;
}

function makeAdapter(overrides = {}) {
  return {
    name: "fake",
    engine: "fake",
    recursionMarker: "FAKE_ACTIVE",
    wantsWatchdog: false,
    buildInvocation: ({ prompt }) => ({
      argv: ["fake-bin"],
      env: { FAKE_PROFILE: "x" },
      stdinPayload: prompt,
    }),
    parseEvent: (line) => {
      try {
        const e = JSON.parse(line);
        return e && e.type ? e : null;
      } catch {
        return null;
      }
    },
    extractResult: (events) => {
      const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
      return r
        ? { ok: true, resultText: r.text, sessionId: r.session ?? null }
        : { ok: false, resultText: null, sessionId: null };
    },
    classifyError: () => "unknown",
    resumeArgs: () => [],
    ...overrides,
  };
}

function setup({ lines, exitCode, stderr, adapter } = {}) {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake", timeoutMs: 5000 });
  createJob(stateDir, record, "the prompt");
  const child = fakeChild({ lines, exitCode, stderr });
  const spawnImpl = (bin, args, opts) => {
    setImmediate(() => child.emitAll());
    return child;
  };
  return { stateDir, record, child, spawnImpl, adapter: adapter ?? makeAdapter() };
}

test("happy path: completed with resultText, sessionId, events, log", async () => {
  const { stateDir, record, spawnImpl, adapter } = setup({
    lines: ['{"type":"noise"}', "junk", '{"type":"result","kind":"result","text":"hi","session":"s-1"}'],
  });
  // adapter 把帶 kind:result 的行映成 engine-event
  adapter.parseEvent = (line) => {
    try {
      const e = JSON.parse(line);
      if (e.kind === "result") return { kind: "result", text: e.text, session: e.session };
      return e && e.type ? { kind: "noise" } : null;
    } catch {
      return null;
    }
  };
  adapter.extractResult = (events) => {
    const r = events.find((e) => e.type === "engine-event" && e.kind === "result");
    return r ? { ok: true, resultText: r.text, sessionId: r.session } : { ok: false };
  };
  const code = await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });
  assert.equal(code, 0);
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "hi");
  assert.equal(job.sessionId, "s-1");
  assert.equal(job.exitCode, 0);
  assert.ok(job.durationMs >= 0);
  const types = readEvents(jobDir(stateDir, record.id)).map((e) => e.type);
  assert.ok(types.includes("spawned"));
  assert.ok(types.includes("result"));
  assert.equal(types[types.length - 1], "finalized");
  assert.match(fs.readFileSync(logFilePath(stateDir, record.id), "utf8"), /junk/);
});

test("nonzero exit → failed with classifyError kind and stderr tail", async () => {
  const adapter = makeAdapter({ classifyError: () => "auth" });
  const { stateDir, record, spawnImpl } = setup({ lines: [], exitCode: 1, stderr: "401 unauthorized", adapter });
  await runWorker({ stateDir, jobId: record.id, adapter, deps: { spawnImpl } });
  const job = readJob(stateDir, record.id);
  assert.equal(job.status, "failed");
  assert.equal(job.errorKind, "auth");
  assert.match(job.error, /401/);
});

test("worker loses CAS to a canceller — exits 0, spawns nothing", async () => {
  const { stateDir, record, adapter } = setup({});
  finalizeJob(stateDir, record.id, { status: "cancelled" });
  let spawned = false;
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl: () => ((spawned = true), fakeChild()) },
  });
  assert.equal(code, 0);
  assert.equal(spawned, false);
  assert.equal(readJob(stateDir, record.id).status, "cancelled");
});

test("env is force-sanitized: inherited ANTHROPIC_* stripped, marker set, adapter env kept", async () => {
  let seenEnv = null;
  const { stateDir, record, adapter, child } = setup({ lines: [] });
  const spawnImpl = (bin, args, opts) => {
    seenEnv = opts.env;
    setImmediate(() => child.emitAll());
    return child;
  };
  await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { spawnImpl, baseEnv: { ANTHROPIC_API_KEY: "leak", PATH: "/bin" } },
  });
  assert.equal("ANTHROPIC_API_KEY" in seenEnv, false);
  assert.equal(seenEnv.FAKE_ACTIVE, "1");
  assert.equal(seenEnv.FAKE_PROFILE, "x");
  assert.equal(seenEnv.PATH, "/bin");
});

test("missing prompt file → failed, never spawns", async () => {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "fake" });
  createJob(stateDir, record, "p");
  fs.unlinkSync(path.join(jobDir(stateDir, record.id), "prompt.txt"));
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter: makeAdapter(),
    deps: { spawnImpl: () => fakeChild() },
  });
  assert.equal(code, 1);
  assert.equal(readJob(stateDir, record.id).status, "failed");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `node --test tests/shared/worker.test.mjs`
Expected: FAIL — `Cannot find module .../worker.mjs`

- [ ] **Step 3: 實作**

```js
// shared/lib/runtime/worker.mjs
// 通用 detached worker(藍圖 §5.1):吃 adapter,驅動完整生命週期。
// foreground 路徑 in-process await;background 路徑由 companion 以
// `node worker-cli 入口 <stateDir> <jobId>` detached 執行(Plan B 接線)。
import fs from "node:fs";
import readline from "node:readline";
import { buildEngineEnv } from "../core/env.mjs";
import { appendEvent } from "../core/events.mjs";
import {
  readJob,
  markJobRunning,
  finalizeJob,
  promptFilePath,
  logFilePath,
  jobDir,
} from "../core/state-store.mjs";
import { spawnEngine, killGroupWithGrace } from "./spawn.mjs";

const STDERR_TAIL_BYTES = 4096;

// cancel 以 SIGTERM 到 worker;貴的是引擎 child(及其孫子)— 轉發成
// process-group kill,否則殭屍引擎在 bypassPermissions 下繼續改檔燒錢。
export function installCancelForwarder({
  proc = process,
  graceMs = 5000,
  forceExitMs = null,
  killImpl,
  exitImpl = (code) => process.exit(code),
  scheduleImpl = setTimeout,
} = {}) {
  let childPid = null;
  let terminated = false;
  const killSequence = (pid) =>
    killGroupWithGrace(pid, { graceMs, scheduleImpl, ...(killImpl ? { killImpl } : {}) });
  const handler = () => {
    terminated = true;
    if (childPid) killSequence(childPid);
    if (forceExitMs !== null) {
      // 孫子可能繼承 stdio pipes 讓 close 永不發生;SIGTERM 我們的人已經
      // finalize 過 job,自我硬退出是安全的。
      scheduleImpl(() => exitImpl(0), forceExitMs)?.unref?.();
    }
  };
  proc.once("SIGTERM", handler);
  return {
    onChild(child) {
      childPid = child.pid;
      if (terminated) killSequence(childPid); // SIGTERM 先於 spawn 到達
    },
    dispose() {
      proc.removeListener("SIGTERM", handler);
    },
  };
}

export async function runWorker({ stateDir, jobId, adapter, deps = {} }) {
  const startedAt = Date.now();
  const job = readJob(stateDir, jobId);
  if (!job) return 1;
  let prompt;
  try {
    prompt = fs.readFileSync(promptFilePath(stateDir, jobId), "utf8");
  } catch {
    finalizeJob(stateDir, jobId, { status: "failed", error: "prompt file missing" });
    return 1;
  }

  // CAS 守住 queued→running:輸給 canceller 就什麼都不准 spawn — exit 0 是
  // 正確結果,不是錯誤。
  const running = markJobRunning(stateDir, jobId, { pid: deps.pid ?? process.pid });
  if (!running) return 0;

  let invocation;
  try {
    invocation = adapter.buildInvocation({ job: running, prompt });
  } catch (error) {
    finalizeJob(stateDir, jobId, {
      status: "failed",
      error: String(error?.message ?? error),
      errorKind: "adapter",
    });
    return 1;
  }
  // 消毒是強制縫(spec §5):adapter 的 env 只算「顯式注入」,繼承剝除與
  // 遞迴標記由這裡保證,adapter 不可繞過。
  const env = buildEngineEnv({
    baseEnv: deps.baseEnv ?? process.env,
    engineEnv: invocation.env ?? {},
    recursionMarker: adapter.recursionMarker,
  });

  const dir = jobDir(stateDir, jobId);
  const logStream = fs.createWriteStream(logFilePath(stateDir, jobId), {
    flags: "a",
    mode: 0o600,
  });
  const events = [];
  const outcome = await new Promise((resolve) => {
    const state = {
      exitCode: null,
      signal: null,
      stderrTail: "",
      stdinError: null,
      spawnError: null,
      timedOut: false,
    };
    let child;
    try {
      child = spawnEngine({
        argv: invocation.argv,
        env,
        cwd: running.cwd,
        ...(deps.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
      });
    } catch (error) {
      state.spawnError = String(error?.message ?? error);
      resolve(state);
      return;
    }
    appendEvent(dir, "spawned", { pid: child.pid });
    deps.onChild?.(child);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    const timeoutMs = running.timeoutMs ?? 60 * 60 * 1000;
    const timer = setTimeout(() => {
      state.timedOut = true;
      killGroupWithGrace(child.pid, { graceMs: deps.graceMs ?? 5000 });
    }, timeoutMs);
    timer.unref?.();

    child.stdin.on("error", (error) => {
      state.stdinError = state.stdinError ?? error;
    });
    try {
      child.stdin.write(invocation.stdinPayload ?? "");
      child.stdin.end();
    } catch (error) {
      state.stdinError = state.stdinError ?? error;
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      logStream.write(line + "\n");
      let parsed;
      try {
        parsed = adapter.parseEvent(line);
      } catch {
        parsed = null; // parseEvent 永不 fatal
      }
      if (parsed) {
        const event = { ...parsed, raw: line };
        events.push({ type: "engine-event", ...event });
        appendEvent(dir, "engine-event", event);
      }
    });
    child.stderr.on("data", (chunk) => {
      state.stderrTail = (state.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => {
      state.spawnError = state.spawnError ?? String(error?.message ?? error);
      finish();
    });
    child.on("close", (code, signal) => {
      state.exitCode = code;
      state.signal = signal ?? null;
      finish();
    });
  });
  logStream.end();

  let result = { ok: false, resultText: null, sessionId: null, usage: null };
  try {
    result = { ...result, ...adapter.extractResult(events, outcome.exitCode) };
  } catch {}
  const failed =
    Boolean(outcome.spawnError) ||
    Boolean(outcome.stdinError) ||
    outcome.exitCode !== 0 ||
    !result.ok;
  const status = outcome.timedOut ? "timed-out" : failed ? "failed" : "completed";
  let error = null;
  let errorKind = null;
  if (status !== "completed") {
    error = outcome.stdinError
      ? `stdin: ${outcome.stdinError.code ?? outcome.stdinError.message}`
      : (outcome.spawnError || outcome.stderrTail || "engine exited nonzero").slice(-500);
    try {
      errorKind = outcome.timedOut
        ? "timeout"
        : adapter.classifyError(outcome.stderrTail, outcome.exitCode);
    } catch {
      errorKind = "unknown";
    }
  }
  appendEvent(dir, "result", { ok: result.ok, status });
  const won = finalizeJob(stateDir, jobId, {
    status,
    exitCode: outcome.exitCode,
    sessionId: result.sessionId ?? running.sessionId ?? null,
    resultText: result.resultText,
    usage: result.usage ?? null,
    durationMs: Date.now() - startedAt,
    error,
    errorKind,
  });
  // 輸掉 CAS(canceller 先 finalize)時,finalized event 必須記真實終態,
  // 不能記 worker 自己算的 status — 否則 events 會跟 job.json 說兩套話。
  const finalStatus = won ? status : (readJob(stateDir, jobId)?.status ?? status);
  appendEvent(dir, "finalized", { status: finalStatus, by: won ? "worker" : "lost-cas" });
  return 0;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `node --test tests/shared/worker.test.mjs`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/lib/runtime/worker.mjs tests/shared/worker.test.mjs
git commit -m "feat(shared): generic adapter-driven worker with mandatory env seam"
```

---

### Task 12: conformance suite — 十劇本 × reference adapter

**Files:**
- Create: `tests/shared/conformance/fake-engine.mjs`
- Create: `tests/shared/conformance/reference-adapter.mjs`
- Create: `tests/shared/conformance/conformance.mjs`
- Test: `tests/shared/conformance/reference.conformance.test.mjs`

- [ ] **Step 1: 寫 fake engine(可腳本化假引擎)**

```js
// tests/shared/conformance/fake-engine.mjs
// FAKE_ENGINE_MODE 控制行為的假引擎。協議:stdout 一行一個 JSON。
const mode = process.env.FAKE_ENGINE_MODE ?? "ok";
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const stdin = await new Promise((resolve) => {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => resolve(buf));
  process.stdin.on("error", () => resolve(buf));
});

switch (mode) {
  case "ok":
    say({ kind: "session", id: "fake-session-1" });
    say({ kind: "result", ok: true, text: `echo:${stdin.trim().slice(0, 40)}` });
    process.exit(0);
  case "resume": // resumeArgs 會帶 --resume <id>;驗收它有被傳遞
    say({ kind: "session", id: "fake-session-1" });
    say({
      kind: "result",
      ok: true,
      text: process.argv.includes("--resume") ? "resumed" : "fresh",
    });
    process.exit(0);
  case "midway-drop":
    say({ kind: "session", id: "fake-session-2" });
    process.exit(1); // 結果行還沒吐就斷線
  case "noise":
    process.stdout.write("plain noise\n{broken json\n");
    say({ kind: "result", ok: true, text: "survived noise" });
    process.exit(0);
  case "hang":
    say({ kind: "session", id: "s" });
    setInterval(() => {}, 1000); // 永不退出 — 等 timeout 來殺
    break;
  case "instant-exit":
    process.exit(7); // 一行都不吐
  case "huge-output": {
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i < 4; i += 1) say({ kind: "chunk", data: big });
    say({ kind: "result", ok: true, text: `huge:${big.length * 4}` });
    process.exit(0);
  }
  case "auth-expire-midway":
    say({ kind: "session", id: "s" });
    process.stderr.write("token expired: 401 mid-stream\n");
    process.exit(1);
  case "grandchild": {
    const { spawn } = await import("node:child_process");
    const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    say({ kind: "grandchild", pid: gc.pid });
    setInterval(() => {}, 1000); // 自己也掛著等 cancel
    break;
  }
  default:
    process.exit(2);
}
```

- [ ] **Step 2: 寫 reference adapter**

```js
// tests/shared/conformance/reference-adapter.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_ENGINE = path.join(here, "fake-engine.mjs");

export function makeReferenceAdapter({ mode = "ok", resumeSessionId = null } = {}) {
  return {
    name: "reference",
    engine: "reference",
    recursionMarker: "FAKE_ENGINE_ACTIVE",
    wantsWatchdog: false,
    buildInvocation({ job, prompt }) {
      const argv = [process.execPath, FAKE_ENGINE];
      if (resumeSessionId) argv.push(...this.resumeArgs(resumeSessionId));
      return { argv, env: { FAKE_ENGINE_MODE: mode }, stdinPayload: prompt };
    },
    parseEvent(line) {
      try {
        const e = JSON.parse(line);
        return e && e.kind ? e : null;
      } catch {
        return null;
      }
    },
    extractResult(events) {
      const session = events.find((e) => e.kind === "session");
      const result = events.find((e) => e.kind === "result");
      return {
        ok: Boolean(result?.ok),
        resultText: result?.text ?? null,
        sessionId: session?.id ?? null,
        usage: null,
      };
    },
    classifyError(stderrTail) {
      if (/401|expired/.test(stderrTail)) return "auth";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["--resume", sessionId];
    },
  };
}
```

- [ ] **Step 3: 寫參數化 conformance runner**

```js
// tests/shared/conformance/conformance.mjs
// 參數化合約測試(spec §7:十劇本)。任何 adapter + fake fixture 進來,
// 自動驗形態無關五不變量。Plan B/C 的 claude/agy adapter 直接重用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../../shared/lib/core/job.mjs";
import { readEvents } from "../../../shared/lib/core/events.mjs";
import {
  createJob,
  readJob,
  finalizeJob,
  jobDir,
} from "../../../shared/lib/core/state-store.mjs";
import { runWorker } from "../../../shared/lib/runtime/worker.mjs";
import { killProcessGroup } from "../../../shared/lib/runtime/spawn.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-conf-"));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
};

async function runScenario({ makeAdapter, mode, timeoutMs = 8000, prompt = "hello", onChild }) {
  const stateDir = tmp();
  const record = createJobRecord({ engine: "conformance", timeoutMs });
  createJob(stateDir, record, prompt);
  const adapter = makeAdapter({ mode });
  const code = await runWorker({
    stateDir,
    jobId: record.id,
    adapter,
    deps: { graceMs: 200, ...(onChild ? { onChild } : {}) },
  });
  return { stateDir, record, code, job: readJob(stateDir, record.id) };
}

function assertInvariants(stateDir, record, job) {
  assert.ok(
    ["completed", "failed", "cancelled", "timed-out"].includes(job.status),
    `invariant 1: terminal state reached, got ${job.status}`,
  );
  const types = readEvents(jobDir(stateDir, record.id)).map((e) => e.type);
  for (const required of ["job-created", "spawned", "finalized"]) {
    assert.ok(types.includes(required), `invariant 2: ${required} event written`);
  }
}

export function runConformanceSuite({ makeAdapter }) {
  test("scenario 1 — normal completion", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "ok" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "completed");
    assert.match(job.resultText, /^echo:/);
    assert.equal(job.sessionId, "fake-session-1");
  });

  test("scenario 2 — midway drop fails the JOB, not the runner", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "midway-drop" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, 1);
  });

  test("scenario 3 — stream noise is tolerated", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "noise" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "completed");
    assert.equal(job.resultText, "survived noise");
  });

  test("scenario 4 — hang hits timeout and reaps the group", async () => {
    const { stateDir, record, job } = await runScenario({
      makeAdapter,
      mode: "hang",
      timeoutMs: 400,
    });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "timed-out");
  });

  test("scenario 5 — instant exit with no output", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "instant-exit" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, 7);
  });

  test("scenario 6 — cancel race: first terminal writer wins, worker never overwrites", async () => {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "conformance", timeoutMs: 8000 });
    createJob(stateDir, record, "p");
    const adapter = makeAdapter({ mode: "hang" });
    const workerDone = runWorker({
      stateDir,
      jobId: record.id,
      adapter,
      deps: {
        graceMs: 100,
        onChild(child) {
          // canceller 搶先 finalize,然後殺群(模擬 cancelJob 的順序)
          assert.equal(finalizeJob(stateDir, record.id, { status: "cancelled" }), true);
          killProcessGroup(child.pid, "SIGKILL");
        },
      },
    });
    await workerDone;
    const job = readJob(stateDir, record.id);
    assert.equal(job.status, "cancelled", "cancel must never be overwritten by the worker");
    assertInvariants(stateDir, record, job);
  });

  test("scenario 7 — resume args reach the engine", async () => {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "conformance", timeoutMs: 8000 });
    createJob(stateDir, record, "continue please");
    const adapter = makeAdapter({ mode: "resume", resumeSessionId: "fake-session-1" });
    await runWorker({ stateDir, jobId: record.id, adapter, deps: {} });
    assert.equal(readJob(stateDir, record.id).resultText, "resumed");
  });

  test("scenario 8 — huge output (≈256KB) survives streaming", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "huge-output" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "completed");
    assert.equal(job.resultText, `huge:${64 * 1024 * 4}`);
  });

  test("scenario 9 — auth expiring mid-job classifies as auth", async () => {
    const { stateDir, record, job } = await runScenario({ makeAdapter, mode: "auth-expire-midway" });
    assertInvariants(stateDir, record, job);
    assert.equal(job.status, "failed");
    assert.equal(job.errorKind, "auth");
  });

  test("scenario 10 — cancel reaps grandchildren (no zombie engines)", async () => {
    const stateDir = tmp();
    const record = createJobRecord({ engine: "conformance", timeoutMs: 8000 });
    createJob(stateDir, record, "p");
    const adapter = makeAdapter({ mode: "grandchild" });
    let grandchildPid = null;
    let childPid = null;
    const workerDone = runWorker({
      stateDir,
      jobId: record.id,
      adapter,
      deps: {
        graceMs: 100,
        onChild(child) {
          childPid = child.pid;
          child.stdout.on("data", (chunk) => {
            const m = String(chunk).match(/"pid":(\d+)/);
            if (m && !grandchildPid) {
              grandchildPid = Number(m[1]);
              finalizeJob(stateDir, record.id, { status: "cancelled" });
              killProcessGroup(child.pid, "SIGTERM");
            }
          });
        },
      },
    });
    await workerDone;
    assert.ok(grandchildPid, "fixture must report its grandchild");
    assert.ok(await waitGone(childPid), "child reaped");
    assert.ok(await waitGone(grandchildPid), "grandchild reaped — zombies burn API money");
    assert.equal(readJob(stateDir, record.id).status, "cancelled");
  });
}
```

- [ ] **Step 4: 寫 reference 接線測試並跑**

```js
// tests/shared/conformance/reference.conformance.test.mjs
import { runConformanceSuite } from "./conformance.mjs";
import { makeReferenceAdapter } from "./reference-adapter.mjs";

runConformanceSuite({ makeAdapter: makeReferenceAdapter });
```

Run: `node --test tests/shared/conformance/reference.conformance.test.mjs`
Expected: PASS(10 scenarios)。劇本 4/6/10 含真實 spawn 與 kill,單檔耗時 < 10s。

- [ ] **Step 5: Commit**

```bash
git add tests/shared/conformance/
git commit -m "test(shared): parameterized 10-scenario conformance suite + reference adapter"
```

---

### Task 13: 競態對抗審查 — 攻擊 first-terminal-writer-wins

**Files:**
- Test: `tests/shared/adversarial-races.test.mjs`

spec §7:以攻擊視角專門構造違反劇本。三個攻擊全綠 = 不變量守住;任何紅燈 = 先修 core 再固化該劇本。**執行本 task 的 agent 額外責任:讀完 state-store.mjs 後,再自行構造至少一個本檔未列的交錯劇本**(提示方向:writeJob 與 claimTerminalTransition 之間、listJobs 掃描中途的目錄移除、同 pid 重用)。構造成功即在本檔加測試並修 core;構造失敗在 commit message 記錄嘗試過什麼。

- [ ] **Step 1: 寫三個攻擊測試**

```js
// tests/shared/adversarial-races.test.mjs
// 對抗式審查(spec §7):每個測試都是一次「構造違反」的嘗試。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../shared/lib/core/job.mjs";
import {
  createJob,
  readJob,
  writeJob,
  finalizeJob,
  markJobRunning,
  pruneJobs,
  lockFilePath,
  jobFilePath,
  jobDir,
} from "../../shared/lib/core/state-store.mjs";
import { reconcileDeadPids } from "../../shared/lib/core/reconcile.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-attack-"));

test("attack 1 — cancel vs natural completion double-finalize: loser must not corrupt winner's fields", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 4242 });
  // 兩個 finalizer 競速:worker(completed+resultText)先,canceller 後
  assert.equal(
    finalizeJob(s, j.id, { status: "completed", resultText: "precious", sessionId: "s9" }),
    true,
  );
  assert.equal(finalizeJob(s, j.id, { status: "cancelled" }), false);
  const job = readJob(s, j.id);
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "precious"); // cancel 永不蓋掉真實結果
  assert.equal(job.sessionId, "s9");
  assert.equal(job.pid, 4242); // fresh-merge 保住 worker stamp
});

test("attack 2 — finalize claiming exactly during prune's unlink window", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  // 重現 prune 的中間態:json 已刪、lock 未刪、目錄還在
  finalizeJob(s, j.id, { status: "completed" });
  fs.unlinkSync(jobFilePath(s, j.id)); // prune step 1
  // stale finalizer 此刻闖入 — 終態 JSON 不在了,但它絕不可復活 job
  assert.equal(finalizeJob(s, j.id, { status: "failed" }), false);
  assert.equal(readJob(s, j.id), null);
  // prune 完成剩餘步驟後,一切乾淨
  fs.unlinkSync(lockFilePath(s, j.id));
  fs.rmSync(jobDir(s, j.id), { recursive: true, force: true });
  assert.equal(fs.existsSync(jobDir(s, j.id)), false);
});

test("attack 3 — claim-then-die plus a racing markJobRunning: reconcile must converge to lock status", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  // canceller claim 了 lock 然後死亡(JSON 沒寫)。同時 worker 嘗試標 running。
  fs.writeFileSync(
    lockFilePath(s, j.id),
    JSON.stringify({ pid: 1, status: "cancelled" }),
    { mode: 0o600 },
  );
  assert.equal(markJobRunning(s, j.id, { pid: 99999 }), null, "worker must refuse to start");
  // JSON 仍是 queued(transient)— reconcile 用 lock 內容收斂,即使 pid 欄是死的
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 }); // 最壞情況:殘餘 running 寫
  const repaired = reconcileDeadPids(s, { isAlive: () => false });
  assert.deepEqual(repaired, [j.id]);
  assert.equal(readJob(s, j.id).status, "cancelled", "lock's intended status wins");
  // 收斂必須冪等
  assert.deepEqual(reconcileDeadPids(s, { isAlive: () => false }), []);
});
```

- [ ] **Step 2: 跑攻擊測試**

Run: `node --test tests/shared/adversarial-races.test.mjs`
Expected: PASS(3 attacks repelled)。任何 FAIL = 真 bug:用 superpowers:systematic-debugging 修 core,**不准改測試遷就實作**。

- [ ] **Step 3: 自行構造第四個攻擊(agent 的對抗責任,見 task 開頭)**

讀 `shared/lib/core/state-store.mjs` 全文,構造一個未列劇本。構造出違反 → 加測試 + 修 core;構造不出 → 在 commit message 記錄嘗試的交錯(至少兩種)。

- [ ] **Step 4: 跑 shared 全套**

Run: `node --test tests/shared/*.test.mjs tests/shared/conformance/*.test.mjs`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add tests/shared/adversarial-races.test.mjs
git commit -m "test(shared): adversarial race attacks on first-terminal-writer-wins"
```

---

### Task 14: 接線收尾 — npm test 全綠

**Files:**
- Modify: `package.json`(scripts)
- Modify: `docs/plans/2026-06-12-phase2a-shared-core.md`(勾進度)

- [ ] **Step 1: 把 shared 套件串進 npm test**

`package.json` 的 scripts 區改為(只動這兩行):

```json
    "test": "npm run test:structure && npm run test:shared && npm run test:delegate && npm run test:antigravity && npm run test:codex",
    "test:shared": "node --test tests/shared/*.test.mjs tests/shared/conformance/*.test.mjs",
```

- [ ] **Step 2: 全套驗證**

Run: `npm test 2>&1 | tail -15`
Expected: 五套全 pass —— structure 2 + shared(本 plan 新增 ≈48)+ delegate 91 + antigravity 243 + codex 305。任何紅燈用 superpowers:systematic-debugging,不准改既有測試。

- [ ] **Step 3: 對照 Task 0 基線**

確認既有四套的 pass 數與基線一致(本 plan 不准動到三個 plugin 的任何檔案:`git status` 應只見 `shared/`、`tests/shared/`、`package.json`、本 plan 檔)。

Run: `git status --short -- plugins/`
Expected: 空輸出

- [ ] **Step 4: 勾掉本 plan 全部 checkbox 並 commit**

```bash
git add package.json docs/plans/2026-06-12-phase2a-shared-core.md
git commit -m "feat(shared): wire shared+conformance suites into npm test — phase 2A complete"
```

- [ ] **Step 5: 收工狀態回報**

回報:分支名、`npm test` 末 15 行、`git log --oneline main..HEAD`。push 與 PR 由使用者決定。

---

## Self-Review 紀錄(writing-plans 自查)

- Spec 覆蓋:§3 schema(Task 1)、events(Task 2)、目錄式 store + CAS + prune(Task 3–5)、reconcile 雙保險的同步半邊(Task 6;watchdog 開關只到宣告層,實裝在 Plan B/C)、§5 sanitizeEnv(Task 7)、§2.3 wait 的 core 半邊(Task 8;`logs` 動詞純屬 companion 投影,Plan B 接線)、§5 pgid(Task 9)、adapter 合約 + 五不變量(Task 10)、worker(Task 11)、§7 十劇本(Task 12)、競態對抗審查(Task 13)、§8 step 0 pre-flight(Task 0)。
- Plan A 刻意不含:render/args(首位消費者在 Plan B 的 companion 重構)、vendor sync + drift CI(首個 vendored 副本出現在 Plan B)、`--json` companion 投影(Plan B)。
- 型別一致性:`createJobRecord` 欄位 ↔ worker finalize patch ↔ conformance 斷言已互相核對;`readEvents({afterIndex})` ↔ `waitForJob` 的增量 drain 一致。
