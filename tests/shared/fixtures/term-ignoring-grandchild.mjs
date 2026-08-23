// tests/shared/fixtures/term-ignoring-grandchild.mjs
// 不變量 3 的最壞形狀:leader 收到 TERM 就乾脆退出,但它先生了一個
//   (a) 同 pgid、(b) 改掉 stdio(不會撐住 leader 的 stdout)、(c) 無視 SIGTERM 的孫子。
// 於是 leader 的 'close' 很快到,而孫子還活著。
//
// 孫子必須「先裝好 handler 才算就緒」:早期版本在孫子還沒開始執行前就印出 pid,於是在
// 機器吃緊時 TERM 會用預設行為把它殺掉,測試就會因為錯誤的理由而綠(review 抓到)。
// 這裡用一個 ready 檔當握手,leader 等到它出現才報 pid。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ready = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gc-ready-")), "ready");
const grandchild = spawn(
  process.execPath,
  ["-e", `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, 'x'); setInterval(() => {}, 1000);`],
  { stdio: "ignore" },
);
const deadline = Date.now() + 5000;
while (!fs.existsSync(ready) && Date.now() < deadline) {
  try { fs.readFileSync("/proc/self/stat"); } catch {} // 忙等,不引入 async
}
process.stdout.write(
  JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid, ready: fs.existsSync(ready) }) + "\n",
);
process.on("SIGTERM", () => process.exit(0)); // leader 乖乖走 → close 早於 grace
setInterval(() => {}, 1000);
