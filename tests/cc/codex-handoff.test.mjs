import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = path.join(REPO_ROOT, "plugins/cc/bin/cc-companion");

test("bin/cc-companion 存在、可執行、有 shebang、forward 到 cc-companion.mjs", () => {
  assert.ok(fs.existsSync(LAUNCHER), "bin/cc-companion missing");
  const text = fs.readFileSync(LAUNCHER, "utf8");
  assert.match(text, /^#!.*\b(bash|sh)\b/, "missing shebang");
  assert.match(text, /scripts\/cc-companion\.mjs/, "must exec the runtime");
  const mode = fs.statSync(LAUNCHER).mode;
  assert.ok(mode & 0o111, "launcher must be executable");
});

test("bin/cc-companion 無參數時 forward 到 runtime 並 exit 0（印 usage）", () => {
  const res = spawnSync(LAUNCHER, [], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: cc-companion/, "should print companion usage");
});

test("透過 symlink 入口呼叫 launcher 仍能 resolve 到 runtime（PATH 安裝多為 symlink）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symlink-"));
  const link = path.join(dir, "cc-companion");
  fs.symlinkSync(LAUNCHER, link);
  const res = spawnSync(link, [], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage: cc-companion/, "symlinked launcher must resolve runtime");
  fs.rmSync(dir, { recursive: true, force: true });
});

const SKILL = path.join(REPO_ROOT, "plugins/cc/skills/cc-handoff/SKILL.md");

test("cc-handoff skill 存在、frontmatter 正確、含關鍵操作指令", () => {
  assert.ok(fs.existsSync(SKILL), "cc-handoff/SKILL.md missing");
  const text = fs.readFileSync(SKILL, "utf8");
  assert.ok(text.startsWith("---"), "missing frontmatter");
  const fm = text.slice(3, text.indexOf("---", 3));
  assert.match(fm, /name:\s*cc-handoff/, "name must be cc-handoff");
  assert.match(fm, /description:/, "missing description");
  // description 三要素關鍵字(spec §2 Q3 判據)
  assert.match(fm, /claude/i, "description must mention claude");
  assert.match(fm, /hand|delegate/i, "description must mention hand/delegate");
  assert.match(fm, /subtask|task/i, "description must mention subtask/task");
  // body 必含 spec v2 釘死的操作:CC_PLUGIN_DATA、PROJECT_ROOT、git status、--json、不自動外包
  assert.match(text, /CC_PLUGIN_DATA/, "body must set CC_PLUGIN_DATA (V-2)");
  assert.match(text, /git rev-parse --show-toplevel/, "body must pin PROJECT_ROOT (V-3)");
  assert.match(text, /git status --porcelain/, "body must list changed files (V-5)");
  assert.match(text, /--json/, "body must use --json");
  assert.match(text, /明確指派|explicit/i, "body must state explicit-assignment-only");
  assert.match(text, /bin\/cc-companion/, "body must prefer bin/cc-companion launcher (orca isCliEntry workaround)");
  // profile 選擇:明確分辨(沒指定→native / 指定→看 profiles 用對應),不依賴單一 profile auto-select
  assert.match(text, /--profile/, "body must pass --profile explicitly, not rely on auto-select");
  assert.match(text, /CC_PROFILE/, "body must select profile via CC_PROFILE (native default + explicit pick)");
});

const COMPANION = path.join(REPO_ROOT, "plugins/cc/scripts/cc-companion.mjs");
const FAKE_CLAUDE = path.join(REPO_ROOT, "tests/cc/fake-claude.mjs");

test("污染回歸:同時有 CC_PLUGIN_DATA 與被污染的 CLAUDE_PLUGIN_DATA 時,job/state 落 CC_PLUGIN_DATA（V-2/#2）", () => {
  const want = fs.mkdtempSync(path.join(os.tmpdir(), "cc-want-"));   // cc 真正的 dataRoot
  const wrong = fs.mkdtempSync(path.join(os.tmpdir(), "cc-wrong-")); // codex 環境注入的 CLAUDE_PLUGIN_DATA
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ws-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cc-bin-"));
  const shim = path.join(bin, "claude");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake 0.0.0"; exit 0; fi\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`,
    { mode: 0o755 },
  );
  // 單一 profile 放在 want → auto-select
  fs.mkdirSync(path.join(want, "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(want, "profiles", "native.json"),
    JSON.stringify({ env: { FAKE_CLAUDE_MODE: "success" } }),
  );
  const prompt = path.join(ws, "task.md");
  fs.writeFileSync(prompt, "do the thing");

  const res = spawnSync(
    process.execPath,
    [COMPANION, "task", "--prompt-file", prompt, "--json"],
    {
      cwd: ws,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CC_PLUGIN_DATA: want,        // cc 的 dataRoot
        CLAUDE_PLUGIN_DATA: wrong,   // 模擬 orca codex 污染
        CC_CLAUDE_BIN: shim,
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `no JSON in stdout: ${res.stdout}\n${res.stderr}`);
  const j = JSON.parse(line);
  assert.equal(j.status, "completed", `${res.stdout}\n${res.stderr}`);
  // 坐實:state 落在 want(CC_PLUGIN_DATA),wrong 完全沒被用
  assert.ok(fs.existsSync(path.join(want, "state")), "state must live under CC_PLUGIN_DATA");
  assert.ok(
    !fs.existsSync(path.join(wrong, "state")),
    "CLAUDE_PLUGIN_DATA must NOT be used when CC_PLUGIN_DATA is set",
  );

  for (const d of [want, wrong, ws, bin]) {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const CODEX_MKT = path.join(REPO_ROOT, ".agents/plugins/marketplace.json");

test("codex marketplace manifest 列出 cc 且指向 ./plugins/cc", () => {
  assert.ok(fs.existsSync(CODEX_MKT), ".agents/plugins/marketplace.json missing");
  const m = JSON.parse(fs.readFileSync(CODEX_MKT, "utf8"));
  assert.ok(typeof m.name === "string" && m.name, "marketplace needs a name");
  const entry = m.plugins.find((p) => p.name === "cc");
  assert.ok(entry, "cc entry missing from codex marketplace");
  assert.equal(entry.source.source, "local", "source.source must be local");
  assert.equal(entry.source.path, "./plugins/cc", "source.path must point at ./plugins/cc");
  assert.ok(entry.policy && entry.policy.installation, "entry needs policy.installation");
  assert.ok(entry.policy.authentication, "entry needs policy.authentication");
  assert.ok(entry.category, "entry needs category");
});
