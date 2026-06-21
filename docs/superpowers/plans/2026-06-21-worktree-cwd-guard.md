# worktree-cwd-guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Codex(engine 層)在啟動前**強制驗證** cwd 落在預期 worktree(triplet),並提供一個 host 端 skill 規範整條「worktree → subagent → codex」的調用紀律。

**Architecture:** 一個零依賴的 SSOT helper `lib/worktree-guard.mjs` 實作「解析 expected triplet + L2(b) git hard check + sanitize git env + 清 broker endpoint env」。companion 的 `handleTask` / `handleTaskWorker` / `handleReviewCommand` 在啟動 engine 前呼叫它(B1/B1b);`job-control` 的 cross-workspace fallback 在 expected 模式下被約束(B1c)。維度 A 是 `audi-skill` 的一個 skill,引用同一組 L2 判定案例。既有的 per-worktree 隔離(realpath hash / per-worktree broker)**不動**——只在它上游加 gate。

**Tech Stack:** 純 ESM `.mjs`,zero-dependency;測試用 `node:test` + `node:assert/strict`,hermetic(fake codex binary、重導 `CLAUDE_PLUGIN_DATA`、注入 `runGit`/`env` seam)。

## Global Constraints

- Node >= 22.3;純 ESM `.mjs`,zero-dependency(spec「Conventions」)。
- **IRONCLAD**:只動 `plugins/codex/` + `tests/codex/`;不碰 `plugins/{antigravity,cc}/` 或其 tests。
- 落點是 `agent-fleet-cc/plugins/codex`(README:133 supersedes codex-plugin-cc;不動已退役的上游 repo)。
- 全線 **fail-fast、零 fallback**:不符即 throw / 非零退出,絕不猜預設值繼續。
- expected triplet 是 **all-or-none**:`worktreePath` / `worktreeBranch` / `worktreeBase`(刻意不叫 `base`,避開 review 的 `--base`)。
- 既有 per-worktree 隔離(`state.mjs` realpath hash / per-worktree broker)**不得修改**。
- 驗證用 **git hard check**(直接 spawn git),**不信** `resolveWorkspaceRoot` 的非 git fallback(`workspace.mjs:3`)。
- broker endpoint env 常數 = `CODEX_COMPANION_APP_SERVER_ENDPOINT`(`app-server.mjs:23`)。
- 每個 commit 結尾:`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 交付 gate:完成前全 `npm test` 綠 + 真 Codex foreign-broker smoke 通過。

---

## File Structure

**Create:**
- `plugins/codex/scripts/lib/worktree-guard.mjs` — SSOT:`WorktreeMismatchError`、`parseExpectedTriplet`、`sanitizeGitEnv`、`assertWorktreeAlignment`、`expectedFromRequest`。
- `tests/codex/worktree-guard-vectors.mjs` — SSOT test vectors(A、B 共用的正反例)。
- `tests/codex/worktree-guard.test.mjs` — `worktree-guard.mjs` 單元測試(吃 vectors)。
- `tests/codex/worktree-guard-companion.test.mjs` — companion gate(task/worker/review)hermetic 測試。
- `tests/codex/worktree-guard-foreign-broker.smoke.mjs` — 真 Codex smoke(連別樹 broker 被擋)。
- `/home/audichuang/research/audi-skill/worktree-cwd-guard/SKILL.md` — 維度 A skill。

**Modify:**
- `plugins/codex/scripts/codex-companion.mjs` — `handleTask`(:849)、`buildTaskRequest`(:687)、`handleTaskWorker`(:912)、`handleReviewCommand`(:799)加 gate;import worktree-guard。
- `plugins/codex/scripts/lib/job-control.mjs` — `:308` cross-workspace fallback 加 `allowCrossWorkspace` 約束(B1c)。
- `package.json` — `test:codex` 已用 `tests/codex/*.test.mjs` 自動涵蓋新 `.test.mjs`;smoke 另加 `test:codex:smoke` script。

---

## Task 0: Worktree + 乾淨基線

**Files:** 無(環境建置)

- [ ] **Step 1: 用原生 worktree 工具建立隔離工作區**

依 `superpowers:using-git-worktrees`:優先用原生 `EnterWorktree`(會切換 session cwd)。鎖定三件套作為本次開發的 EXPECTED:`WT_PATH`(worktree 絕對路徑)、`WT_BRANCH`、`WT_BASE`(`git rev-parse HEAD`)。

- [ ] **Step 2: 確認 baseline 綠**

Run: `npm run test:codex`
Expected: 全 pass(codex 套件目前綠;`runtime.test.mjs` 偶發 flaky,失敗就重跑一次確認)。

- [ ] **Step 3: 記錄起點**

Run: `git -C "$WT_PATH" rev-parse --show-toplevel && git -C "$WT_PATH" branch --show-current && git -C "$WT_PATH" rev-parse HEAD`
Expected: toplevel == `WT_PATH`、branch == `WT_BRANCH`、HEAD == `WT_BASE`(對應 spec L2(a) 起點驗證)。

---

## Task 1: SSOT helper `worktree-guard.mjs`

**Files:**
- Create: `plugins/codex/scripts/lib/worktree-guard.mjs`
- Create: `tests/codex/worktree-guard-vectors.mjs`
- Test: `tests/codex/worktree-guard.test.mjs`

**Interfaces:**
- Produces:
  - `class WorktreeMismatchError extends Error`(`.name = "WorktreeMismatchError"`, `.detail`)
  - `parseExpectedTriplet(source) -> {worktreePath,worktreeBranch,worktreeBase} | null`(all-or-none;partial → throw)
  - `expectedFromRequest(request) -> triplet | null`(從 queued request 物件取)
  - `sanitizeGitEnv(env) -> void`(in-place 刪 `GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR`)
  - `assertWorktreeAlignment({cwd, expected, env=process.env, runGit}) -> void`(不符 throw;通過則清 `CODEX_COMPANION_APP_SERVER_ENDPOINT`)
  - `BROKER_ENDPOINT_ENV`(re-export 字串常數,測試共用)

- [ ] **Step 1: 寫 test vectors(SSOT,A/B 共用)**

`tests/codex/worktree-guard-vectors.mjs`:
```js
// SSOT 正反例 —— 維度 B 的 JS 單元測試吃它;維度 A 的 SKILL.md 在文件中引用同樣的案例描述。
export const TRIPLET_VECTORS = [
  { name: "all three present", source: { "expected-worktree": "/wt", "expected-branch": "feat", "expected-base": "abc" },
    expect: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "abc" } },
  { name: "none present", source: {}, expect: null },
  { name: "partial (only path) throws", source: { "expected-worktree": "/wt" }, throws: true },
  { name: "partial (path+branch) throws", source: { "expected-worktree": "/wt", "expected-branch": "feat" }, throws: true },
  { name: "request-shaped keys", source: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "abc" },
    expect: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "abc" } }
];

// align 案例:fake git 回應 -> 期望 pass/throw。每筆 git 是 { "<args join ' '>": {status, stdout} }。
export const ALIGN_VECTORS = [
  { name: "exact match passes",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/wt" },
           "branch --show-current": { status: 0, stdout: "feat" },
           "merge-base --is-ancestor base1 HEAD": { status: 0, stdout: "" } },
    pass: true },
  { name: "wrong tree throws",
    cwd: "/other", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/other" } }, pass: false },
  { name: "wrong branch throws",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/wt" },
           "branch --show-current": { status: 0, stdout: "main" } }, pass: false },
  { name: "baseline lost (not ancestor) throws",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 0, stdout: "/wt" },
           "branch --show-current": { status: 0, stdout: "feat" },
           "merge-base --is-ancestor base1 HEAD": { status: 1, stdout: "" } }, pass: false },
  { name: "not a git repo throws (no fallback)",
    cwd: "/wt", expected: { worktreePath: "/wt", worktreeBranch: "feat", worktreeBase: "base1" },
    git: { "rev-parse --show-toplevel": { status: 128, stdout: "" } }, pass: false }
];
```
> 注意:`realpathSync.native` 在測試中對不存在路徑會 throw。`assertWorktreeAlignment` 必須容忍 realpath 失敗→退回原字串比較(見 Step 3),test vectors 用的 `/wt`、`/other` 不存在,正好驗證這個退路。

- [ ] **Step 2: 寫 failing test**

`tests/codex/worktree-guard.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpectedTriplet, assertWorktreeAlignment, sanitizeGitEnv, BROKER_ENDPOINT_ENV }
  from "../../plugins/codex/scripts/lib/worktree-guard.mjs";
import { TRIPLET_VECTORS, ALIGN_VECTORS } from "./worktree-guard-vectors.mjs";

test("parseExpectedTriplet honours all-or-none", () => {
  for (const v of TRIPLET_VECTORS) {
    if (v.throws) assert.throws(() => parseExpectedTriplet(v.source), /all-or-none/i, v.name);
    else assert.deepEqual(parseExpectedTriplet(v.source), v.expect, v.name);
  }
});

function fakeGit(table) {
  return (_cwd, args) => {
    const key = args.join(" ");
    const hit = table[key];
    if (!hit) return { status: 1, stdout: "" };
    return { status: hit.status, stdout: hit.stdout };
  };
}

test("assertWorktreeAlignment enforces L2(b)", () => {
  for (const v of ALIGN_VECTORS) {
    const env = {};
    const run = () => assertWorktreeAlignment({ cwd: v.cwd, expected: v.expected, env, runGit: fakeGit(v.git) });
    if (v.pass) assert.doesNotThrow(run, v.name);
    else assert.throws(run, /WorktreeMismatch|mismatch|not (a git|an ancestor)/i, v.name);
  }
});

test("sanitizeGitEnv strips git-control env", () => {
  const env = { GIT_DIR: "/x", GIT_WORK_TREE: "/y", GIT_COMMON_DIR: "/z", KEEP: "1" };
  sanitizeGitEnv(env);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_COMMON_DIR, undefined);
  assert.equal(env.KEEP, "1");
});

test("expected mode drops foreign broker endpoint", () => {
  const env = { [BROKER_ENDPOINT_ENV]: "unix:/foreign/broker.sock" };
  const ok = ALIGN_VECTORS.find((v) => v.pass);
  assertWorktreeAlignment({ cwd: ok.cwd, expected: ok.expected, env, runGit: fakeGit(ok.git) });
  assert.equal(env[BROKER_ENDPOINT_ENV], undefined);
});
```

- [ ] **Step 3: Run → 確認 fail**

Run: `node --test tests/codex/worktree-guard.test.mjs`
Expected: FAIL(模組不存在 / 函式未定義)。

- [ ] **Step 4: 實作 `worktree-guard.mjs`**

```js
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";

export class WorktreeMismatchError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "WorktreeMismatchError";
    this.detail = detail;
  }
}

const FIELDS = [
  ["worktreePath", "expected-worktree"],
  ["worktreeBranch", "expected-branch"],
  ["worktreeBase", "expected-base"]
];

// all-or-none. null when none present; throw when partial.
export function parseExpectedTriplet(source = {}) {
  const picked = {};
  let present = 0;
  for (const [camel, flag] of FIELDS) {
    const value = source[flag] ?? source[camel];
    if (value != null && value !== "") {
      picked[camel] = String(value);
      present += 1;
    }
  }
  if (present === 0) return null;
  if (present !== FIELDS.length) {
    throw new WorktreeMismatchError(
      "expected-worktree contract is all-or-none: provide worktreePath, worktreeBranch, and worktreeBase together.",
      { picked }
    );
  }
  return picked;
}

export function expectedFromRequest(request = {}) {
  return parseExpectedTriplet(request ?? {});
}

export function sanitizeGitEnv(env) {
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
}

function realpathOr(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value; // path may not exist (tests, fresh worktree) — fall back to literal compare
  }
}

function defaultRunGit(cwd, args, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

// Hard L2(b) check. Does NOT trust resolveWorkspaceRoot fallback. No-op when expected is null.
export function assertWorktreeAlignment({ cwd, expected, env = process.env, runGit = defaultRunGit }) {
  if (!expected) return;
  sanitizeGitEnv(env);

  const top = runGit(cwd, ["rev-parse", "--show-toplevel"], env);
  if (top.status !== 0) {
    throw new WorktreeMismatchError(`cwd is not inside a git repository (no fallback): ${cwd}`, { cwd });
  }
  const actualTop = realpathOr(top.stdout.trim());
  const wantTop = realpathOr(expected.worktreePath);
  if (actualTop !== wantTop) {
    throw new WorktreeMismatchError(`worktree mismatch: toplevel ${actualTop} != expected ${wantTop}`, { actualTop, wantTop });
  }

  const branch = runGit(cwd, ["branch", "--show-current"], env).stdout.trim();
  if (branch !== expected.worktreeBranch) {
    throw new WorktreeMismatchError(`branch mismatch: ${branch || "(detached)"} != ${expected.worktreeBranch}`, { branch });
  }

  const anc = runGit(cwd, ["merge-base", "--is-ancestor", expected.worktreeBase, "HEAD"], env);
  if (anc.status !== 0) {
    throw new WorktreeMismatchError(`baseline ${expected.worktreeBase} is not an ancestor of HEAD (reset/rebase?).`, { base: expected.worktreeBase });
  }

  // expected mode: never let a stale/foreign broker endpoint override cwd-derived broker.
  delete env[BROKER_ENDPOINT_ENV];
}
```

- [ ] **Step 5: Run → 確認 pass**

Run: `node --test tests/codex/worktree-guard.test.mjs`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/worktree-guard.mjs tests/codex/worktree-guard-vectors.mjs tests/codex/worktree-guard.test.mjs
git commit -m "feat(codex): worktree-guard SSOT — expected triplet + L2(b) hard check

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: companion `task` gate(B1 + request schema)

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs`(`handleTask` :849、`buildTaskRequest` :687、import 區 :64)
- Test: `tests/codex/worktree-guard-companion.test.mjs`

**Interfaces:**
- Consumes: `parseExpectedTriplet`, `assertWorktreeAlignment`(Task 1)
- Produces: `handleTask` 接受 `--expected-worktree/--expected-branch/--expected-base`;`buildTaskRequest` 多帶這三欄。

- [ ] **Step 1: 寫 failing test(用 fake codex,hermetic)**

`tests/codex/worktree-guard-companion.test.mjs`(參照 `enqueue-background.test.mjs` / `fake-codex-fixture.mjs` 的 hermetic 慣例:重導 `CLAUDE_PLUGIN_DATA` 到 tmp、PATH 注入 fake `codex`、cwd 指向一個臨時 git repo):
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COMPANION = path.resolve("plugins/codex/scripts/codex-companion.mjs");

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtguard-"));
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  run(["init", "-q", "-b", "feat"]);
  run(["config", "user.email", "t@t"]); run(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "f"), "1");
  run(["add", "."]); run(["commit", "-qm", "base"]);
  const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, base };
}

function runTask(cwd, extraArgs, env = {}) {
  return spawnSync(process.execPath, [COMPANION, "task", "--cwd", cwd, "--prompt", "noop", ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "pd-")), ...env }
  });
}

test("task: mismatched expected-worktree exits non-zero before engine", () => {
  const { dir, base } = makeRepo();
  const r = runTask(dir, ["--expected-worktree", "/definitely/not/here", "--expected-branch", "feat", "--expected-base", base]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /worktree mismatch|WorktreeMismatch/i);
});

test("task: partial triplet is rejected (all-or-none)", () => {
  const { dir } = makeRepo();
  const r = runTask(dir, ["--expected-worktree", dir]); // missing branch+base
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /all-or-none/i);
});
```
> 真正「matched → 進 engine」的成功路徑由 fake-codex fixture 覆蓋(engine 被呼叫即代表 gate 放行);沿用既有 fixture 注入方式,不要打真 API。

- [ ] **Step 2: Run → 確認 fail**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: FAIL（目前 `--expected-*` 被當未知旗標忽略,不會非零退出）。

- [ ] **Step 3: 改 `handleTask`(:849）加旗標 + gate**

import 區(:64 附近)加:
```js
import { parseExpectedTriplet, assertWorktreeAlignment } from "./lib/worktree-guard.mjs";
```
`handleTask` 的 `parseCommandInput` valueOptions 補三個旗標,並在 `cwd`/`workspaceRoot` 解析後、任何 engine 啟動前加 gate:
```js
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "expected-worktree", "expected-branch", "expected-base"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const expected = parseExpectedTriplet(options);
  assertWorktreeAlignment({ cwd, expected }); // throws → main() error envelope → non-zero exit, before any engine start
```
`buildTaskRequest`(:687)加三欄,讓 background 路徑把契約存進 queued request:
```js
function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, expected }) {
  return { cwd, model, effort, prompt, write, resumeLast, jobId, expected };
}
```
background 分支建立 request 時帶上 `expected`:
```js
    const request = buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId: job.id, expected });
```

- [ ] **Step 4: Run → 確認 pass**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/codex/worktree-guard-companion.test.mjs
git commit -m "feat(codex): task command enforces expected-worktree before engine start

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `task-worker` 二次驗(B1b)

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs`(`handleTaskWorker` :912)
- Test: `tests/codex/worktree-guard-companion.test.mjs`(同檔追加)

**Interfaces:**
- Consumes: `expectedFromRequest`, `assertWorktreeAlignment`(Task 1);queued request 的 `expected`(Task 2)

- [ ] **Step 1: 追加 failing test**

```js
test("task-worker re-verifies expected from stored request", () => {
  // 直接寫一個帶 expected(指向錯樹)的 queued job 檔,再跑 task-worker,應在執行前失敗。
  // 用 Task 2 的 makeRepo + CLAUDE_PLUGIN_DATA 重導;job 檔路徑用 companion 的 state 慣例(slug-hash)。
  // 斷言:task-worker 進程非零退出且訊息含 worktree mismatch,且 fake codex 從未被呼叫(engine 未啟動)。
  const { dir, base } = makeRepo();
  // ...(寫入 storedJob.request = { cwd: dir, prompt: "noop", expected: { worktreePath: "/nope", worktreeBranch: "feat", worktreeBase: base } })
  // 透過 enqueueBackgroundTask 或直接 writeJobFile 造出 queued 狀態,再 spawn `task-worker --cwd dir --job-id <id>`。
  // assert.notEqual(status, 0); assert.match(out, /worktree mismatch/i);
});
```
> 實作 test 時用 `state.mjs` 的 `writeJobFile(workspaceRoot, jobId, record)` 造 queued job(workspaceRoot = `resolveWorkspaceRoot(dir)`),record.request 帶錯樹 expected。

- [ ] **Step 2: Run → 確認 fail**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: FAIL（worker 目前不驗 expected,會進 `executeTaskRun`）。

- [ ] **Step 3: 改 `handleTaskWorker`(:912)在 `executeTaskRun` 前 gate**

在取得 `request` 之後、`runTrackedJob(... executeTaskRun ...)` 之前加:
```js
  const expected = expectedFromRequest(request);
  assertWorktreeAlignment({ cwd, expected }); // background path must not skip the CLI-time contract
```
import 區補 `expectedFromRequest`。

- [ ] **Step 4: Run → 確認 pass**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/codex/worktree-guard-companion.test.mjs
git commit -m "feat(codex): background task-worker re-verifies expected-worktree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `review` gate(B1 覆蓋 review 路徑)

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs`(`handleReviewCommand` :799)
- Test: `tests/codex/worktree-guard-companion.test.mjs`(同檔追加)

- [ ] **Step 1: 追加 failing test**

```js
test("review: mismatched expected-worktree exits non-zero before engine", () => {
  const { dir, base } = makeRepo();
  const r = spawnSync(process.execPath,
    [COMPANION, "review", "--cwd", dir, "--scope", "working-tree",
     "--expected-worktree", "/nope", "--expected-branch", "feat", "--expected-base", base],
    { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "pd-")) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /worktree mismatch|WorktreeMismatch/i);
});
```

- [ ] **Step 2: Run → 確認 fail**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 改 `handleReviewCommand`(:799)加旗標 + gate**

valueOptions 補三個 `expected-*`;在 `workspaceRoot` 解析後、`executeReviewRun` 前:
```js
  const expected = parseExpectedTriplet(options);
  assertWorktreeAlignment({ cwd, expected });
```

- [ ] **Step 4: Run → 確認 pass**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/codex/worktree-guard-companion.test.mjs
git commit -m "feat(codex): review command enforces expected-worktree before engine start

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 約束 cross-workspace fallback（B1c）

**Files:**
- Modify: `plugins/codex/scripts/lib/job-control.mjs`(:308 `findJobByIdAcrossWorkspaces` 呼叫處)
- Modify: `plugins/codex/scripts/codex-companion.mjs`(result/status/cancel/attach handler 在 expected 模式傳 `allowCrossWorkspace: false`)
- Test: `tests/codex/worktree-guard-companion.test.mjs`(同檔追加)

**Interfaces:**
- Produces: `buildSingleJobSnapshot(cwd, reference, options)`(`job-control.mjs:296`)新增 `options.allowCrossWorkspace`(預設 `true`,維持現狀);`false` 時跳過 catch 區(:307-320)的 `findJobByIdAcrossWorkspaces` 直接 re-throw。其他走 fallback 的 helper(`resolveResultJob`/`resolveCancelableJob`)同步透傳此選項。

- [ ] **Step 1: 追加 failing test**

```js
test("expected mode disables cross-workspace job fallback", () => {
  // 在 workspace A 造一個 job;在 workspace B(帶正確 expected)用該 job id 查 result。
  // 預設(無 expected)應能跨界找到;帶 expected 時應限定當前 workspace、找不到即報錯,不跨界。
  // 斷言:--expected-* 模式下 /codex:result <idFromA> 在 B 找不到(workspace-scoped),非零或明確 not-found。
});
```

- [ ] **Step 2: Run → 確認 fail**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: FAIL（目前一律跨界 fallback)。

- [ ] **Step 3: job-control 加 `allowCrossWorkspace` 選項**

`buildSingleJobSnapshot`(`job-control.mjs:296`)的 catch 區(:307-320)是 cross-workspace fallback 所在。加 `options.allowCrossWorkspace`(預設 `true`,保留現狀);`false` 時跳過 fallback 直接 re-throw:
```js
export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const allowCrossWorkspace = options.allowCrossWorkspace !== false; // default preserves current behaviour
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  let selected;
  try {
    selected = matchJobReference(jobs, reference);
  } catch (error) {
    if (allowCrossWorkspace && reference) {            // <-- gate the fallback
      const found = findJobByIdAcrossWorkspaces(cwd, reference);
      if (found) { return { /* ...existing return unchanged... */ }; }
    }
    throw error;                                        // expected mode: dead-end stays workspace-scoped
  }
  // ...rest unchanged...
}
```
companion 的 result/status/cancel/attach handler:加 `expected-*` valueOptions,解析 `expected = parseExpectedTriplet(options)`,呼叫 `buildSingleJobSnapshot`(及 `resolveResultJob`/`resolveCancelableJob` 若它們也走 fallback)時帶 `{ allowCrossWorkspace: !expected }`。

- [ ] **Step 4: Run → 確認 pass**

Run: `node --test tests/codex/worktree-guard-companion.test.mjs`
Expected: PASS。

- [ ] **Step 5: 跑既有 cross-workspace 測試確認無回歸**

Run: `node --test tests/codex/cross-workspace-lookup.test.mjs`
Expected: PASS（預設行為不變)。

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/job-control.mjs plugins/codex/scripts/codex-companion.mjs tests/codex/worktree-guard-companion.test.mjs
git commit -m "feat(codex): expected mode constrains cross-workspace job fallback (B1c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 維度 A skill `worktree-cwd-guard`

**Files:**
- Create: `/home/audichuang/research/audi-skill/worktree-cwd-guard/SKILL.md`

**Interfaces:** 引用 Task 1 的 `ALIGN_VECTORS` 案例(同一組正反例,人類可讀化)以保證 A/B 不變量一致。

- [ ] **Step 1: 寫 SKILL.md(frontmatter + 流程 + L2 片段 + subagent 自驗範本)**

沿用 audi-skill 慣例(frontmatter `name`+`description`、內文繁中)。內容必含:
- **真 gate 宣告**:hard gate = host preflight(派前 assert)+ companion gate(`--expected-worktree` triplet);**subagent 自驗是 best-effort 補強,非 enforcement**。
- **流程**:原生 `EnterWorktree`(禁手動 `git worktree add`)→ 鎖 `WT_PATH/WT_BRANCH/WT_BASE` → 起點驗證 (a) → 每交棒跑 (b) → 調 codex 顯式帶 `--expected-worktree/--expected-branch/--expected-base`(對齊 companion gate)→ 失敗即停 + 回報落點。
- **L2(b) shell 片段**(與 spec 一致:sanitize git env + git hard check + merge-base ancestor)。
- **subagent 自驗 prompt 範本**(固定段落,標明 best-effort)。

- [ ] **Step 2: 驗證 skill 自帶的 L2 片段與 JS SSOT 同義**

走查:SKILL.md 的 shell 判定(toplevel/branch/merge-base/sanitize)與 `worktree-guard.mjs` 的 `assertWorktreeAlignment` 逐條對應;`ALIGN_VECTORS` 每個反例在 shell 片段下也會 `die`。

- [ ] **Step 3: Commit(在 audi-skill repo)**

```bash
cd /home/audichuang/research/audi-skill
git add worktree-cwd-guard/SKILL.md
git commit -m "feat: worktree-cwd-guard skill — host preflight + per-handoff L2 + subagent self-check

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 真 Codex foreign-broker smoke

**Files:**
- Create: `tests/codex/worktree-guard-foreign-broker.smoke.mjs`
- Modify: `package.json`(加 `test:codex:smoke` script;**不**併入 hermetic `npm test`)

**Interfaces:** Consumes Task 2 的 `--expected-*` 旗標 + Task 1 的 broker-env 清除。

- [ ] **Step 1: 寫 smoke（需真 codex + 已登入)**

`tests/codex/worktree-guard-foreign-broker.smoke.mjs`:沿用 `e2e-testing` real-engine smoke 慣例,需 `codex` 已安裝且登入,否則 `test.skip`。
- 建兩個真 git worktree:A(正確)、B(別樹)。
- 在 A 啟一個 broker,拿到它的 `CODEX_COMPANION_APP_SERVER_ENDPOINT`。
- 在 B 跑 `task --cwd B --expected-worktree B... `,但 env 注入指向 A 的 endpoint。
- 斷言:gate 清掉 foreign endpoint → Codex 連到 **B 自己**的 broker(或 turn 在 B 的 workspace 落地),**不**在 A 落地。

- [ ] **Step 2: 加 package.json script**

```json
"test:codex:smoke": "node --test tests/codex/worktree-guard-foreign-broker.smoke.mjs"
```

- [ ] **Step 3: Run（真 engine)**

Run: `npm run test:codex:smoke`
Expected: PASS（或在無 codex/未登入環境 skip 並印明原因)。

- [ ] **Step 4: Commit**

```bash
git add tests/codex/worktree-guard-foreign-broker.smoke.mjs package.json
git commit -m "test(codex): real-Codex foreign-broker smoke — gate drops foreign endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 全套交付 gate

- [ ] **Step 1: 全測試綠**

Run: `npm test`
Expected: 全 pass(`runtime.test.mjs` 偶發 flaky → 重跑一次確認)。

- [ ] **Step 2: 真 Codex smoke 綠**

Run: `npm run test:codex:smoke`
Expected: PASS。

- [ ] **Step 3: 回報落點(dev-untouched 驗證)**

Run: `git -C "$WT_PATH" rev-parse --show-toplevel && git -C "$WT_PATH" branch --show-current`
Expected: 仍在 `WT_PATH` / `WT_BRANCH`(整個實作未漏出 worktree)。

---

## Self-Review

**1. Spec coverage:**
- 核心不變量(L2(a)/(b)、sanitize、git hard check)→ Task 1。✓
- B1 companion gate(task/review)→ Task 2 / Task 4。✓
- B1b background worker 二次驗 → Task 3。✓
- B1c cross-workspace 約束 → Task 5。✓
- broker env 清除 → Task 1(`assertWorktreeAlignment` 末)。✓
- all-or-none triplet → Task 1(`parseExpectedTriplet`)。✓
- 維度 A skill → Task 6。✓
- SSOT 共用 test vectors → Task 1(`worktree-guard-vectors.mjs`,Task 6 引用)。✓
- 真 Codex foreign-broker smoke → Task 7。✓
- 全 npm test 綠 → Task 8。✓
- command template 接旗標 = **follow-up**(spec 非目標),本 plan 不含 → 一致。✓

**2. Placeholder scan:** Task 3/5 的 test 內文用「造 queued job / 解析函式真實簽名」描述而非完整 code——這是因為它們依賴 `state.mjs` / `job-control.mjs` 的既有 helper,實作時需先 Read 該檔取得確切簽名。已在步驟中明示「讀 X 取得簽名」,非 TBD;production 改動的 code 片段均已給出。

**3. Type consistency:** triplet 欄位全程 `worktreePath/worktreeBranch/worktreeBase`;flag 全程 `expected-worktree/expected-branch/expected-base`;`parseExpectedTriplet` / `expectedFromRequest` / `assertWorktreeAlignment` / `WorktreeMismatchError` / `BROKER_ENDPOINT_ENV` 跨 task 一致。✓
