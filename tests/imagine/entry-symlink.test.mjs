import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SKILL_ROOT = path.resolve(import.meta.dirname, "../../skills/imagine");

// aghub installs every skill as a symlink, and a second Claude config dir may link plugins/, so
// the script path the host runs is often not the real path. argv[1] keeps the link while
// import.meta.url is realpath'd by the ESM loader; the entry guard must still run main()
// instead of exiting 0 with no output.
for (const [label, viaLink] of [["real path", false], ["symlinked directory", true]]) {
  test(`imagine --help prints usage when invoked via a ${label}`, () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imagine-entry-")));
    try {
      fs.cpSync(SKILL_ROOT, path.join(tmp, "real", "imagine"), { recursive: true });
      let root = path.join(tmp, "real");
      if (viaLink) {
        fs.symlinkSync(root, path.join(tmp, "link"));
        root = path.join(tmp, "link");
      }
      const r = spawnSync(process.execPath, [path.join(root, "imagine", "scripts", "imagine.mjs"), "--help"], {
        encoding: "utf8"
      });
      assert.match(r.stderr, /Known flags/, `silent no-op: exit=${r.status} stderr=${r.stderr}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
