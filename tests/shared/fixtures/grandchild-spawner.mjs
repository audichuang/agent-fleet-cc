// tests/shared/fixtures/grandchild-spawner.mjs
// 生一個孫子程序後常駐 — 用來驗 kill(-pgid) 連孫子一起殺。
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
process.stdout.write(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }) + "\n");
setInterval(() => {}, 1000); // 自己也常駐
