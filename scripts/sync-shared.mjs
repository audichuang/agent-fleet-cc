// scripts/sync-shared.mjs
// vendor:shared/lib → 各 plugin 的 scripts/lib/shared/(安裝只快取 plugin
// 子目錄,共享 lib 必須 vendor 進去 — 藍圖已驗證的快取行為)。
// CI 跑本腳本後 git diff --exit-code:vendored 副本與 source 不同步即紅燈。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(root, "shared", "lib");
// Plan C/D 把 antigravity、codex 加進來
const TARGETS = ["delegate"].map((p) =>
  path.join(root, "plugins", p, "scripts", "lib", "shared"),
);

for (const target of TARGETS) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(SOURCE, target, { recursive: true });
  const banner = path.join(target, "VENDORED.md");
  fs.writeFileSync(
    banner,
    "# VENDORED — do not edit\n\nSynced from `shared/lib/` by `scripts/sync-shared.mjs`.\nEdit the source and re-run `npm run sync-shared`.\n",
  );
  console.log(`synced shared/lib -> ${path.relative(root, target)}`);
}
