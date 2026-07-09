// tests/grok/companion.test.mjs — in-process runCompanion() with injected seams.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCompanion } from "../../plugins/grok/scripts/grok-companion.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_GROK = path.join(HERE, "fake-grok.mjs");

function collect() {
  const lines = [];
  return { out: (l) => lines.push(l), lines };
}

test("setup reports the grok CLI version when the probe succeeds", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["setup"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA },
    out,
    spawnSyncImpl: () => ({ status: 0, stdout: "grok 9.9.9\n" }),
  });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /✓ grok CLI: grok 9\.9\.9/.test(l)), lines.join("\n"));
});

test("setup fails when the grok CLI is not runnable", async () => {
  const { out } = collect();
  const code = await runCompanion(["setup"], {
    env: {}, out,
    spawnSyncImpl: () => ({ error: new Error("ENOENT") }),
  });
  assert.equal(code, 1);
});

test("task (foreground) runs a job to completion via the fake engine and emits --json", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "hello there", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      // Inject the fake grok as the spawned binary via request.binaryArgv seam.
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.engine, "grok");
  assert.equal(json.status, "completed");
  assert.match(json.resultText, /^echo:hello there/);
});

test("recursion guard: refuses to run inside a grok job", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["status"], { env: { GROK_FLEET_ACTIVE: "1" }, out });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /recursion guard/.test(l)));
});
