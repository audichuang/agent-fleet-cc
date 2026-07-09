// Hermetic test base: import this FIRST in every grok test file.
// Redirects HOME/data dirs to throwaway temp dirs and strips ambient
// GROK_*/XAI_*/FAKE_GROK_* so the suite never reads ~/.grok, never inherits real
// auth, and is never perturbed by a stray fake-engine mode in the environment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GROK_") || key.startsWith("XAI_") || key.startsWith("FAKE_GROK_")) {
    delete process.env[key];
  }
}
process.env.GROK_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "grok-test-data-"));

export function makeTempDir(prefix = "grok-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDataRoot() {
  return makeTempDir("grok-data-");
}
