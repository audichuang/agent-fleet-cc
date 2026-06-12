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
  readTerminalLock,
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

test("attack 2 — prune unlink-order invariant: pruneJobs must delete job.json BEFORE terminal.lock (direct red-light guarantee)", () => {
  // 直接攻擊 pruneJobs 的 unlink 順序不變量。
  // 方法:注入 onUnlink 鉤子記錄每次 unlinkSync 的路徑,然後斷言 jobFilePath 排在
  // lockFilePath 之前。若 pruneJobs 把順序改成 lock-before-json,此測試立即紅燈。
  //
  // 為何這個順序是 load-bearing:
  // finalizeJob 在 claim(O_EXCL) 後重讀 JSON。
  // 若 json 先消失、lock 仍在 → finalizeJob 見 fresh=null → undo 自己的 claim → 回 false。
  // 若 lock 先消失、json 仍在 → 不同的 finalizer 可以再次 O_EXCL claim → 覆蓋終態!
  //
  // mutation criterion:交換 state-store.mjs 裡 pruneJobs 中兩個 unlinkSync 的順序
  // (lock 先 json 後)→ unlinkOrder 陣列顯示 lockFilePath 排第一 → 以下斷言紅燈。
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  finalizeJob(s, j.id, { status: "completed" });

  // 用 onUnlink hook 記錄 pruneJobs 的 unlink 呼叫順序
  const unlinkOrder = [];
  const jfp = jobFilePath(s, j.id);   // 預先算好,供 hook 比較
  const lfp = lockFilePath(s, j.id);

  pruneJobs(s, { max: 0 }, {
    onUnlink(filePath) {
      if (filePath === jfp) unlinkOrder.push("json");
      else if (filePath === lfp) unlinkOrder.push("lock");
    },
  });

  // 核心不變量斷言:json 必須先於 lock 出現在 unlinkOrder
  assert.ok(unlinkOrder.includes("json"), "pruneJobs must attempt to unlink job.json");
  assert.ok(unlinkOrder.includes("lock"), "pruneJobs must attempt to unlink terminal.lock");
  assert.equal(
    unlinkOrder.indexOf("json"),
    0,
    `unlink order must be json-first, got: ${unlinkOrder.join(",")}`,
  );
  assert.equal(
    unlinkOrder.indexOf("lock"),
    1,
    `unlink order must be lock-second, got: ${unlinkOrder.join(",")}`,
  );

  // 目錄整個清除後應不再存在
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

// --------------------------------------------------------------------
// Attack 4 — reconcile 的 TOCTOU 窗口:reconcileDeadPids 讀 listJobs 快照後、
// 呼叫 finalizeJob 前,如果 pruneJobs 恰好把那個 job 整個刪掉,
// finalizeJob 會拿到 existing=null → 回 false(不復活 job)。
// 但如果 reconcile 內部還有一個直接 writeJob 路徑(lock-repair 分支),
// 它的 beforeFreshRead hook 可以模擬 prune 在中途刪 json — fresh=null → 守衛攔下。
//
// 本攻擊使用 finalizeJob 的 dead-pid 路徑,故不走 lock-repair:
// 利用 finalizeJob 的 _hooks.afterClaim 縫模擬「claim 成功後 prune 才刪 json」,
// 驗 finalizeJob 的 undo-own-lock 分支確實執行(回 false 且 lock 已被自行清除)。
// 若 undo-own-lock 分支缺失,測試仍通(只是 lock 殘留),但後續 markJobRunning
// 會被 EEXIST 鎖死 — 用第二輪斷言抓住這個殘留。
// --------------------------------------------------------------------
test("attack 4 — reconcile TOCTOU: prune deletes job.json after finalizeJob claims lock → undo-own-lock must fire, lock must not leak", () => {
  const s = tmp();
  const j = createJobRecord({ engine: "delegate" });
  createJob(s, j, "p");
  // 建立 running job (dead pid)
  writeJob(s, { ...readJob(s, j.id), status: "running", pid: 99999 });

  // 直接呼叫 finalizeJob + afterClaim hook:模擬 O_EXCL claim 成功後、fresh re-read 前,
  // prune 搶先刪了 job.json(但目錄還在,lock 剛被自己寫進去)。
  const result = finalizeJob(
    s,
    j.id,
    { status: "failed", error: "reconciled dead pid" },
    {
      afterClaim() {
        // 模擬 prune 刪 job.json(prune step 1 — unlink 順序不變量的第一步)
        try { fs.unlinkSync(jobFilePath(s, j.id)); } catch {}
      },
    },
  );

  // finalizeJob 必須回 false(fresh=null → undo 自己的 lock 並退出)
  assert.equal(result, false, "finalizeJob must return false when json is gone post-claim");

  // job.json 已被 prune 刪掉,readJob 應為 null
  assert.equal(readJob(s, j.id), null, "job.json must remain absent");

  // 最關鍵:undo-own-lock 必須清掉 lock — 否則 lock 殘留會永久封鎖後續操作。
  // mutation criterion:移除 finalizeJob 的 undo-own-lock 區塊(fs.unlinkSync lock)
  // → lock 殘留 → 以下斷言紅燈。
  assert.equal(
    fs.existsSync(lockFilePath(s, j.id)),
    false,
    "undo-own-lock must remove the lock file — stale lock would permanently block future writes",
  );

  // 進一步驗:lock 消失後,readTerminalLock 應回 null。
  assert.equal(readTerminalLock(s, j.id), null, "readTerminalLock must return null after undo");
});
