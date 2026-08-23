// tests/shared/fixtures/term-ignoring-grandchild.mjs
// 不變量 3 的最壞形狀:leader 收到 TERM 就乾脆退出,但它先生了一個
//   (a) 同 pgid、(b) 改掉 stdio(所以不會撐住 leader 的 stdout)、(c) 無視 SIGTERM
// 的孫子。於是 leader 的 'close' 很快到,而孫子還活著 —— 排程在 grace 之後的那發 SIGKILL
// 若因為 process.exit 而沒開火,這個孫子就永遠留著燒錢。
import { spawn } from "node:child_process";
const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  { stdio: "ignore" }, // 不繼承 stdout → leader 的 close 不被它撐住
);
process.stdout.write(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }) + "\n");
// leader 自己乖乖聽話:TERM 一到就走,製造「close 早於 grace」。
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
