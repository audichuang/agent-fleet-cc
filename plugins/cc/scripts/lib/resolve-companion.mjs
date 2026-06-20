// plugins/cc/scripts/lib/resolve-companion.mjs
// 在 codex(或任何宿主)端定位 cc plugin 內的 cc-companion.mjs。
// 不靠寫死絕對路徑或 plugin-root env —— orca 環境兩者皆不可靠(spec v2 V-1)。
// 改用穩定錨:CODEX_HOME / 標準 cache 目錄下有界搜尋,並以相鄰
// .codex-plugin(或 .claude-plugin)plugin.json 的 name==="cc" 為 marker 驗證。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const MAX_DEPTH = 3; // base/<mkt>/cc/<ver> 最深三層

export class CompanionNotFoundError extends Error {
  constructor(scanned) {
    super(`cc-companion.mjs not found. scanned roots:\n${scanned.join("\n")}`);
    this.name = "CompanionNotFoundError";
    this.scanned = scanned;
  }
}

function cacheBases({ env, homedir }) {
  const bases = [];
  if (env.CODEX_HOME) {
    bases.push(path.join(env.CODEX_HOME, ".tmp", "plugins", "plugins"));
    bases.push(path.join(env.CODEX_HOME, "plugins", "cache"));
  }
  bases.push(path.join(homedir, ".codex", "plugins", "cache"));
  bases.push(path.join(homedir, ".claude", "plugins", "cache"));
  return bases;
}

// 若 dir 是合法 cc 根(dir/scripts/cc-companion.mjs 存在且相鄰 manifest name==="cc"),
// 回傳該 companion 絕對路徑,否則 null。
function companionAt(dir, { existsSync, readFileSync }) {
  const companion = path.join(dir, "scripts", "cc-companion.mjs");
  if (!existsSync(companion)) return null;
  for (const mani of [".codex-plugin", ".claude-plugin"]) {
    const mpath = path.join(dir, mani, "plugin.json");
    if (!existsSync(mpath)) continue;
    try {
      const j = JSON.parse(readFileSync(mpath, "utf8"));
      if (j && j.name === "cc") return companion;
    } catch {
      /* 壞 json,當作沒這個 marker */
    }
  }
  return null;
}

export function resolveCompanion({
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const scanned = [];
  const hits = []; // { companion, root }

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || !existsSync(dir)) return;
    const hit = companionAt(dir, { existsSync, readFileSync });
    if (hit) {
      hits.push({ companion: hit, root: dir });
      return; // 命中即 plugin 根,不再往下
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };

  // tier 優先(spec v2 V-1):依序試每個 base,第一個有命中的 tier 勝;
  // 只在同 tier 內按 root mtime 取最新。不做全域 mtime 排序(否則較新的
  // ~/.claude 安裝會蓋過 $CODEX_HOME 的 codex-host 安裝)。
  for (const base of cacheBases({ env, homedir })) {
    scanned.push(base);
    const before = hits.length;
    walk(base, 0);
    const fresh = hits.slice(before);
    if (fresh.length) {
      fresh.sort((a, b) => statSync(b.root).mtimeMs - statSync(a.root).mtimeMs);
      return fresh[0].companion;
    }
  }
  throw new CompanionNotFoundError(scanned);
}
