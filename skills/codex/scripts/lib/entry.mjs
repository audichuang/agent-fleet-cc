import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// True when the module at `moduleUrl` is the script node was asked to run. Compares real paths:
// node keeps a symlinked script path in argv[1] but resolves import.meta.url through the link,
// so a plain string compare silently skips main() whenever the skill dir is reached through a
// symlink (aghub links every skill, and a second Claude config dir may link plugins/).
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const self = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(self);
  } catch {
    return path.resolve(argv1) === self;
  }
}
