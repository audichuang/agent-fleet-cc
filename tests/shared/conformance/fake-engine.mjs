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
    // 最後一行寫完後等 stdout 排空再 exit — process.exit() 不等非同步 flush。
    process.stdout.write(JSON.stringify({ kind: "result", ok: true, text: `huge:${big.length * 4}` }) + "\n", () => process.exit(0));
    break;
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
