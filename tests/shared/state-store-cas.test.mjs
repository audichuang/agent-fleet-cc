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

// ────────────────────────────────────────────────────────────────────────────
// terminal JSON 守衛:即使 lock 被 prune 掉,終態 JSON 仍必須拒絕再 finalize。
//
// 場景:finalize 成功(JSON 變終態)→ 手動 unlink lock(模擬 prune 刪 lock)→
// 再次 finalize 應回 false 且 status 不變。
// 隔離對象:state-store.mjs line 126 的 terminal 守衛
//   `if (!existing || TERMINAL_STATUSES.has(existing.status)) return false;`
// 若把此守衛弱化成只剩 EEXIST 分支,下方測試紅燈——
// 因為 lock 已不存在,claimTerminalTransition 會成功,stale finalizer 得以復活。
// ────────────────────────────────────────────────────────────────────────────
test("terminal JSON guard: rejects finalize even when lock is pruned away", () => {
  const s = tmp();
  const j = mkJob(s);
  // 第一次 finalize 成功:JSON 變終態,lock 建立
  assert.equal(finalizeJob(s, j.id, { status: "completed", resultText: "ok" }), true);
  assert.equal(readJob(s, j.id).status, "completed", "precondition: JSON must be terminal after first finalize");
  // 模擬 prune 刪掉 lock(但 JSON 仍在)
  fs.unlinkSync(lockFilePath(s, j.id));
  assert.equal(fs.existsSync(lockFilePath(s, j.id)), false, "precondition: lock must be gone");
  // 即使 lock 不在,終態 JSON 必須拒絕
  assert.equal(finalizeJob(s, j.id, { status: "cancelled" }), false, "terminal JSON guard must reject even without lock");
  // status 不應被覆蓋
  assert.equal(readJob(s, j.id).status, "completed", "status must remain completed");
  assert.equal(readJob(s, j.id).resultText, "ok", "resultText must remain ok");
});

// ────────────────────────────────────────────────────────────────────────────
// fresh-merge:驗 claim 後、fresh 讀前寫入的欄位不被 existing 覆蓋。
//
// 場景:job 以 queued 狀態進入 finalizeJob(此時 existing.pid === null)。
// claim 成功後,afterClaim hook 模擬 worker 把 pid stamp 寫進 job.json。
// fresh 讀到 pid=4242,merge 後終態 JSON 應保留 pid — 若實作是
// {...existing, ...patch}(不做 fresh merge)則 pid 會是 null,測試紅燈。
// ────────────────────────────────────────────────────────────────────────────
test("finalize fresh-merges fields written after first read (worker pid stamp)", () => {
  const s = tmp();
  const j = mkJob(s);
  // job 此時是 queued,pid = null — existing 讀不到 pid
  assert.equal(readJob(s, j.id).pid, null, "precondition: pid must be null before finalizeJob");

  assert.equal(
    finalizeJob(s, j.id, { status: "cancelled" }, {
      afterClaim() {
        // 模擬 worker 在 claim 成功後才把 pid 寫進 job.json
        writeJob(s, { ...readJob(s, j.id), pid: 4242, status: "running" });
      },
    }),
    true,
  );

  // fresh-merge 必須保住 afterClaim 寫入的 pid;
  // {...existing, ...patch} 回歸會讓 pid = null(existing 時 pid 仍是 null)。
  assert.equal(readJob(s, j.id).pid, 4242, "cancelJob 之後靠 pid 找 process group");
});

// ────────────────────────────────────────────────────────────────────────────
// markJobRunning pre-check 隔離:用 queued(非終態)job + 預置 lock 來確認
// pre-check 確實因 lock 存在而拒絕——與 JSON 是否終態無關。
//
// 另補純 CAS EEXIST loser 案例:lock 存在 + JSON 非終態 → finalizeJob 回 false
// (claimTerminalTransition 遇 EEXIST 分支)。
// ────────────────────────────────────────────────────────────────────────────
test("markJobRunning loses to a claimed lock (pre and post write)", () => {
  const s = tmp();

  // pre-check 隔離:queued job + 預置 lock → lock pre-check 必回 null
  // (不走「JSON 已終態」分支——以此隔離兩個 guard 的責任)
  const a = mkJob(s);
  assert.equal(readJob(s, a.id).status, "queued", "precondition: a must be queued (non-terminal)");
  fs.writeFileSync(
    lockFilePath(s, a.id),
    JSON.stringify({ status: "cancelled" }),
    { flag: "wx", mode: 0o600 },
  );
  // a 的 JSON 是 queued(非終態);唯有 lock pre-check 阻止了 markJobRunning
  assert.equal(markJobRunning(s, a.id, { pid: 1 }), null, "pre-check must reject when lock exists even if JSON is non-terminal");
  // 確認 pre-check 在「寫 running」之前就攔下:JSON 應仍是 queued,pid 仍是 null
  assert.equal(readJob(s, a.id).status, "queued", "pre-check must stop before writing running status");
  assert.equal(readJob(s, a.id).pid, null, "pre-check must stop before writing pid");

  // post-write 競態:寫 running 與重查之間,lock 出現
  const b = mkJob(s);
  const result = markJobRunning(s, b.id, { pid: 2 }, {
    beforeRecheck() {
      fs.writeFileSync(
        lockFilePath(s, b.id),
        JSON.stringify({ status: "cancelled" }),
        { flag: "wx", mode: 0o600 },
      );
    },
  });
  assert.equal(result, null, "post-write recheck must reject when lock appears after write");
});

test("finalizeJob CAS EEXIST loser: lock present + non-terminal JSON returns false", () => {
  const s = tmp();
  const j = mkJob(s);
  // 預置 lock(模擬另一個 finalizer 已 claim)
  fs.writeFileSync(
    lockFilePath(s, j.id),
    JSON.stringify({ pid: 9999, status: "completed", at: new Date().toISOString() }),
    { flag: "wx", mode: 0o600 },
  );
  // job.json 仍是 queued(非終態)— claimTerminalTransition 遇 EEXIST
  assert.equal(readJob(s, j.id).status, "queued", "precondition: JSON must be non-terminal");
  assert.equal(finalizeJob(s, j.id, { status: "cancelled" }), false, "loser must return false via EEXIST branch");
  // 已有 lock 必須不被覆蓋
  assert.deepEqual(readTerminalLock(s, j.id), { status: "completed" }, "winner lock must survive");
});

test("legacy/garbage lock content yields { status: null } not a crash", () => {
  const s = tmp();
  const j = mkJob(s);
  fs.writeFileSync(lockFilePath(s, j.id), "12345"); // JSON.parse("12345") 是合法 JSON
  assert.deepEqual(readTerminalLock(s, j.id), { status: null });
});

// ────────────────────────────────────────────────────────────────────────────
// prune-undo:驗 claim 成功後 job.json 才消失的情境。
//
// afterClaim hook 模擬 prune 在 claim 成功後刪掉 job.json(prune 順序:
// json 先於 lock,finalizeJob 靠此偵測 post-claim prune 並 undo 自己的 lock)。
// fresh 讀回 null → undo lock → return false。
// ────────────────────────────────────────────────────────────────────────────
test("finalize after prune removed job.json undoes its own lock (post-claim)", () => {
  const s = tmp();
  const j = mkJob(s);
  // precondition:job.json 存在且非終態,claim 得以進行
  assert.ok(fs.existsSync(jobFilePath(s, j.id)), "precondition: job.json must exist before finalizeJob");

  const result = finalizeJob(s, j.id, { status: "failed" }, {
    afterClaim() {
      // 模擬 prune 在 claim 成功後、fresh 讀前刪 job.json(json 先於 lock 的順序)
      fs.unlinkSync(jobFilePath(s, j.id));
    },
  });

  assert.equal(result, false, "must return false when json disappears after claim");
  assert.equal(fs.existsSync(lockFilePath(s, j.id)), false, "undo must remove own lock (post-claim undo-own-lock branch)");
});
