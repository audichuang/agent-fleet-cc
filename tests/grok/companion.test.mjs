// tests/grok/companion.test.mjs — in-process runCompanion() with injected seams.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
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

test("task refuses to launch unauthenticated (guards the 1h OAuth hang)", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["task", "hello", "--json"], {
    // Real-binary path: no binaryArgv, no GROK_BIN → auth preflight is active.
    // Hermetic HOME (helpers.mjs) has no ~/.grok/auth.json and no XAI_API_KEY.
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, HOME: process.env.HOME },
    cwd: process.env.GROK_PLUGIN_DATA,
    out,
  });
  assert.equal(code, 1);
  const json = JSON.parse(lines.at(-1));
  assert.equal(json.errorKind, "auth");
  assert.match(json.error, /not authenticated/);
});

test("task accepts --no-subagents (does not reject it as an unknown flag)", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "hi", "--no-subagents", "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.status, "completed");
});

test("task --schema returns grok's structured JSON as resultText", async () => {
  const schemaPath = path.join(makeTempDir(), "schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }));
  const { out, lines } = collect();
  const code = await runCompanion(
    ["task", "return ok true", "--schema", schemaPath, "--wait", "--json"],
    {
      env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
      cwd: process.env.GROK_PLUGIN_DATA,
      out,
      binaryArgv: [process.execPath, FAKE_GROK],
    },
  );
  const json = JSON.parse(lines.at(-1));
  assert.equal(code, 0);
  assert.equal(json.status, "completed");
  assert.match(json.resultText, /"ok":\s*true/);
});

test("task --schema rejects an unreadable or non-JSON schema file", async () => {
  const bad = collect();
  const c1 = await runCompanion(["task", "hi", "--schema", "/no/such/schema.json", "--wait", "--json"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
    cwd: process.env.GROK_PLUGIN_DATA, out: bad.out, binaryArgv: [process.execPath, FAKE_GROK],
  });
  assert.equal(c1, 1);
  assert.match(bad.lines.at(-1), /schema file not readable/);

  const notJson = path.join(makeTempDir(), "bad.json");
  fs.writeFileSync(notJson, "this is not json");
  const bad2 = collect();
  const c2 = await runCompanion(["task", "hi", "--schema", notJson, "--wait", "--json"], {
    env: { GROK_PLUGIN_DATA: process.env.GROK_PLUGIN_DATA, GROK_BIN: `${process.execPath}` },
    cwd: process.env.GROK_PLUGIN_DATA, out: bad2.out, binaryArgv: [process.execPath, FAKE_GROK],
  });
  assert.equal(c2, 1);
  assert.match(bad2.lines.at(-1), /not valid JSON/);
});

test("recursion guard: refuses to run inside a grok job", async () => {
  const { out, lines } = collect();
  const code = await runCompanion(["status"], { env: { GROK_FLEET_ACTIVE: "1" }, out });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /recursion guard/.test(l)));
});
