// tests/shared/fixtures/worker-entry-shape.mjs
// 複製 production worker-entry 的形狀 —— 重點就是最後那個 `.then(code => process.exit(code))`。
// 不變量 3 只能在這個邊界上被證明:in-process 的測試不會顯式 exit,所以排程的 SIGKILL 升級
// 照樣開火,連「有沒有同步殺」都分不出來(實測:mutation 不會打紅)。
import { spawn } from "node:child_process";
import { runWorker } from "../../../shared/lib/runtime/worker.mjs";

const [stateDir, jobId, fixture] = process.argv.slice(2);
const adapter = {
  name: "fake", engine: "fake", recursionMarker: "FAKE_ACTIVE", wantsWatchdog: false,
  buildInvocation: () => ({ argv: [process.execPath, fixture], env: {}, stdinPayload: "" }),
  parseEvent: (line) => {
    // 把孫子的 pid 交給測試(走 stderr,免得跟 job log 的判定混在一起)
    try { const o = JSON.parse(line); process.stderr.write(`LEADER ${o.childPid}\nGRANDCHILD ${o.grandchildPid}\nREADY ${o.ready}\n`); } catch {}
    return null;
  },
  extractResult: () => ({ ok: false, resultText: null, sessionId: null }),
  classifyError: () => "unknown",
  resumeArgs: () => [],
};
// killImpl 是判定用的縫:把 worker 實際送出的每個訊號印到 stderr。測試靠這個「entry 在
// 退出前確實發出了 group SIGKILL」來判定,而不是靠時序 —— 排程的升級與同步收尾都落在
// killedAt+grace,時間上分不開(review 指出前一版因此可能因錯誤理由而綠)。
const T0 = Date.now();
const killImpl = (pid, sig) => {
  // 帶時戳:測試要能證明 SIGKILL 等到了 killedAt+graceMs,而不只是「有送」。
  process.stderr.write(`SIGNAL ${pid} ${sig} ${Date.now() - T0}\n`);
  return process.kill(pid, sig);
};
runWorker({ stateDir, jobId, adapter, deps: { graceMs: 200, killImpl } }).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
