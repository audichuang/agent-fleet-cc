// Hermetic test base: import this FIRST in every test file.
// Redirects HOME/data dirs to throwaway temp dirs and strips ambient
// ANTHROPIC_*/CLAUDE_*/CLAUDECODE*/CC_* so the suite never reads the
// real ~/.claude and never inherits the developer's provider env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("ANTHROPIC_") ||
    key.startsWith("CLAUDE_") ||
    key.startsWith("CLAUDECODE") ||
    key.startsWith("CC_")
  ) {
    delete process.env[key];
  }
}
process.env.CC_PLUGIN_DATA = fs.mkdtempSync(
  path.join(os.tmpdir(), "cc-test-data-"),
);

export function makeTempDir(prefix = "cc-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDataRoot() {
  return makeTempDir("cc-data-");
}

export function writeProfile(dataRoot, name, contents) {
  const dir = path.join(dataRoot, "profiles");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}
