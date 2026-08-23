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
    try { process.stderr.write("GRANDCHILD " + JSON.parse(line).grandchildPid + "\n"); } catch {}
    return null;
  },
  extractResult: () => ({ ok: false, resultText: null, sessionId: null }),
  classifyError: () => "unknown",
  resumeArgs: () => [],
};
runWorker({ stateDir, jobId, adapter, deps: { graceMs: 150 } }).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
