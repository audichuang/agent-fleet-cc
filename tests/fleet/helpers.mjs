// Hermetic test base: import this FIRST in every fleet test file.
// Strips ambient ANTHROPIC_*/CLAUDE_*/CLAUDECODE*/CC_*/AGY_BIN THEN
// redirects HOME and CC_PLUGIN_DATA to throwaway temp dirs, so the suite
// never reads the real ~/.claude and never inherits the developer's provider env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 1) STRIP ambient provider env first.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("ANTHROPIC_") ||
    key.startsWith("CLAUDE_") ||
    key.startsWith("CLAUDECODE") ||
    key.startsWith("CC_") ||
    key === "AGY_BIN"
  ) {
    delete process.env[key];
  }
}

// 2) THEN set the test-controlled values so they win over the strip pattern.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.CC_PLUGIN_DATA = fs.mkdtempSync(
  path.join(os.tmpdir(), "fleet-test-data-"),
);

export function makeTempDir(prefix = "fleet-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDataRoot() {
  return makeTempDir("fleet-data-");
}

export function writeProfile(dataRoot, name, contents) {
  const dir = path.join(dataRoot, "profiles");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  // contents may be a string (written VERBATIM, to allow raw/invalid JSON)
  // or an object (JSON-stringified). This differs from tests/cc/helpers.mjs
  // on purpose so Task 7 can write an unparseable-JSON fixture.
  const body = typeof contents === "string" ? contents : JSON.stringify(contents, null, 2);
  fs.writeFileSync(file, body);
  return file;
}
