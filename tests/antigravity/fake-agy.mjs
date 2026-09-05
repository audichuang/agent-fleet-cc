#!/usr/bin/env node
// Fake agy shim (plain-text print mode). Reads prompt from `--print <prompt>`
// argv (spec D-1: agy does NOT read stdin), emits plain text per FAKE_AGY_MODE,
// honors FAKE_AGY_PIDFILE so e2e cancel tests can target the process group.
import fs from "node:fs";
import { spawn } from "node:child_process";
const argv = process.argv.slice(2);
const i = argv.indexOf("--print");
const prompt = i >= 0 ? (argv[i + 1] ?? "") : "";
const mode = process.env.FAKE_AGY_MODE ?? "ok";
if (process.env.FAKE_AGY_PIDFILE) fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, String(process.pid));
const line = (s) => process.stdout.write(s + "\n");
switch (mode) {
  case "ok": line("OK"); line(""); line("body paragraph one."); line(""); line("body paragraph two."); process.exit(0);
  case "echo": line(`echo:${prompt.trim().slice(0, 40)}`); process.exit(0);
  case "empty": process.exit(0);                          // clean exit, no stdout -> completed null
  case "noise": line(""); line("   "); line("actual content"); process.exit(0);
  case "authStderr": process.stderr.write("Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?x=1\n"); process.exit(1);
  case "authStdout": line("Authentication required. Please visit the URL to log in"); line("https://accounts.google.com/o/oauth2/auth?x=1"); process.exit(0);
  case "fail": process.stderr.write("some agy error\n"); process.exit(1);
  case "not-installed": process.exit(127);
  case "hang": line("working..."); setInterval(() => {}, 1 << 30); break;
  case "grandchild": { const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], { stdio: "ignore" }); line(`GRANDCHILD_PID: ${gc.pid}`); setInterval(() => {}, 1 << 30); break; }
  default: line("OK"); process.exit(0);
}
