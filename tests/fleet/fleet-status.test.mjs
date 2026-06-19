import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { runStatus } from "../../plugins/fleet/scripts/fleet-status.mjs";

const PLUGIN_ROOT = "/repo/plugins/fleet";

function scriptFor(engine) {
  const byEngine = {
    codex: ["..", "codex", "scripts", "codex-companion.mjs"],
    antigravity: ["..", "antigravity", "scripts", "commands", "status.mjs"],
    delegate: ["..", "delegate", "scripts", "delegate-companion.mjs"],
  };
  return path.resolve(PLUGIN_ROOT, ...byEngine[engine]);
}

function runEngineByEngine(payloads, calls = []) {
  return ({ script, args, cwd }) => {
    calls.push({ bin: process.execPath, args: [script, ...args], opts: { cwd } });
    const engine = Object.keys(payloads).find((name) => script === scriptFor(name));
    const value = payloads[engine];
    if (value?.raw) return Promise.resolve(value.raw);
    return Promise.resolve({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  };
}

function runWith(payloads, extra = {}) {
  const calls = [];
  const result = runStatus(["--json", ...(extra.argv ?? [])], {
    pluginRoot: PLUGIN_ROOT,
    cwd: "/workspace",
    existsSyncImpl: extra.existsSyncImpl ?? (() => true),
    runEngineImpl: runEngineByEngine(payloads, calls),
  });
  return result.then((r) => ({ result: r, calls, doc: JSON.parse(r.stdout) }));
}

test("status runs each engine's own status command and normalizes rows", async () => {
  const { result, calls, doc } = await runWith({
    codex: {
      running: [{ id: "codex-active", status: "running" }],
      recent: [{ id: "codex-done", status: "completed" }],
    },
    antigravity: {
      running: [],
      recent: [{ id: "agy-done", status: "completed" }],
    },
    delegate: [
      { engine: "delegate", jobId: "delegate-active", status: "queued" },
      { engine: "delegate", jobId: "delegate-done", status: "completed" },
    ],
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(doc.checkedEngines, ["codex", "antigravity", "delegate"]);
  assert.equal(doc.allAvailable, true);
  assert.deepEqual(calls.map((c) => c.args), [
    [scriptFor("codex"), "status", "--json"],
    [scriptFor("antigravity"), "--json"],
    [scriptFor("delegate"), "status", "--json"],
  ]);
  assert.equal(calls[0].opts.cwd, "/workspace");

  assert.deepEqual(
    doc.rows.map((row) => [row.engine, row.available, row.active, row.recent, row.status]),
    [
      ["codex", true, 1, 1, "active"],
      ["antigravity", true, 0, 1, "completed"],
      ["delegate", true, 1, 1, "active"],
    ],
  );
  assert.ok(doc.rows[0].actions.includes("/codex:logs codex-active"), "logs action present");
  assert.ok(!doc.rows[0].actions.includes("/codex:attach codex-active"), "attach is redundant, should be absent");
  assert.ok(doc.rows[1].actions.includes("/antigravity:logs agy-done --follow"));
  assert.ok(doc.rows[2].actions.includes("/delegate:logs delegate-active --follow"));
});

test("engine probes run concurrently while rows remain canonical", async () => {
  const payloads = {
    codex: { running: [], recent: [] },
    antigravity: { running: [], recent: [] },
    delegate: [],
  };
  const started = [];
  const resolvers = new Map();
  const resultPromise = runStatus(["--json"], {
    pluginRoot: PLUGIN_ROOT,
    cwd: "/workspace",
    existsSyncImpl: () => true,
    runEngineImpl: ({ script }) => {
      const engine = Object.keys(payloads).find((name) => script === scriptFor(name));
      started.push(engine);
      return new Promise((resolve) => {
        resolvers.set(engine, () => {
          resolve({ status: 0, stdout: JSON.stringify(payloads[engine]), stderr: "" });
        });
      });
    },
  });

  assert.deepEqual(started, ["codex", "antigravity", "delegate"]);

  resolvers.get("delegate")();
  resolvers.get("codex")();
  resolvers.get("antigravity")();
  const result = await resultPromise;
  const doc = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(doc.checkedEngines, ["codex", "antigravity", "delegate"]);
  assert.deepEqual(doc.rows.map((row) => row.engine), ["codex", "antigravity", "delegate"]);
});

test("an unrecognized status JSON shape becomes an explicit 'unknown' row, not idle", async () => {
  const { doc } = await runWith(
    {
      codex: { unexpected: true },
      antigravity: { running: [], recent: [] },
      delegate: [],
    },
    { argv: ["--only", "codex"] },
  );
  const row = doc.rows.find((r) => r.engine === "codex");
  assert.equal(row.status, "unknown");
  assert.match(row.summary, /unrecognized|unknown/i);
  assert.notEqual(row.status, "idle");
});

test("a jobs envelope is recognized and tallied", async () => {
  const { doc } = await runWith(
    {
      codex: {
        jobs: [
          { id: "codex-queued", status: "queued" },
          { id: "codex-done", status: "completed" },
        ],
      },
      antigravity: { running: [], recent: [] },
      delegate: [],
    },
    { argv: ["--only", "codex"] },
  );
  const row = doc.rows.find((r) => r.engine === "codex");
  assert.equal(row.status, "active");
  assert.equal(row.active, 1);
  assert.equal(row.recent, 1);
});

test("codex actions do not list both logs and attach (same handler)", async () => {
  const { doc } = await runWith(
    {
      codex: { running: [{ id: "codex-1", status: "running" }], recent: [] },
      antigravity: { running: [], recent: [] },
      delegate: [],
    },
    { argv: ["--only", "codex"] },
  );
  const row = doc.rows.find((r) => r.engine === "codex");
  assert.ok(row.actions.includes("/codex:logs codex-1"), "logs action present");
  assert.ok(!row.actions.includes("/codex:attach codex-1"), "attach is redundant with logs");
});

test("--only canonicalizes engine order and filters spawned commands", async () => {
  const { calls, doc } = await runWith(
    {
      codex: { running: [], recent: [] },
      delegate: [],
    },
    { argv: ["--only", "delegate,codex"] },
  );

  assert.deepEqual(doc.checkedEngines, ["codex", "delegate"]);
  assert.deepEqual(calls.map((c) => c.args[0]), [scriptFor("codex"), scriptFor("delegate")]);
});

test("raw quoted slash arguments are split in-process", async () => {
  const { calls, doc } = await runWith(
    {
      codex: { running: [], recent: [] },
      delegate: [],
    },
    { argv: ["--only delegate,codex"] },
  );

  assert.deepEqual(doc.checkedEngines, ["codex", "delegate"]);
  assert.deepEqual(calls.map((c) => c.args[0]), [scriptFor("codex"), scriptFor("delegate")]);
});

test("--raw-args-stdin reads safely quoted slash arguments from stdin", async () => {
  const calls = [];
  const result = await runStatus(["--raw-args-stdin"], {
    pluginRoot: PLUGIN_ROOT,
    cwd: "/workspace",
    existsSyncImpl: () => true,
    runEngineImpl: runEngineByEngine(
      {
        codex: { running: [], recent: [] },
        delegate: [],
      },
      calls,
    ),
    readStdinImpl: () => "--json --only delegate,codex\n",
  });
  const doc = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(doc.checkedEngines, ["codex", "delegate"]);
  assert.deepEqual(calls.map((c) => c.args[0]), [scriptFor("codex"), scriptFor("delegate")]);
});

test("missing status script becomes an unavailable row instead of a crash", async () => {
  const { doc, calls } = await runWith(
    {
      codex: { running: [], recent: [] },
      antigravity: { running: [], recent: [] },
      delegate: [],
    },
    {
      existsSyncImpl: (p) => p !== scriptFor("antigravity"),
    },
  );

  assert.equal(doc.allAvailable, false);
  assert.equal(doc.rows[1].engine, "antigravity");
  assert.equal(doc.rows[1].available, false);
  assert.match(doc.rows[1].summary, /status script missing/);
  assert.deepEqual(calls.map((c) => c.args[0]), [scriptFor("codex"), scriptFor("delegate")]);
});

test("bad JSON and non-zero exits become unavailable rows", async () => {
  const { doc } = await runWith({
    codex: { raw: { status: 0, stdout: "{not json", stderr: "" } },
    antigravity: { raw: { status: 7, stdout: "", stderr: "boom\n" } },
    delegate: [],
  });

  assert.equal(doc.allAvailable, false);
  assert.equal(doc.rows[0].available, false);
  assert.match(doc.rows[0].summary, /invalid JSON/);
  assert.equal(doc.rows[1].available, false);
  assert.match(doc.rows[1].summary, /non-zero: boom/);
  assert.equal(doc.rows[2].available, true);
});

test("human output is a compact markdown table", async () => {
  const result = await runStatus([], {
    pluginRoot: PLUGIN_ROOT,
    cwd: "/workspace",
    existsSyncImpl: () => true,
    runEngineImpl: runEngineByEngine({
      codex: { running: [], recent: [] },
      antigravity: { running: [], recent: [] },
      delegate: [],
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\| Engine \| Available \| Active \| Recent \| Status \| Summary \| Actions \|/);
  assert.match(result.stdout, /codex/);
  assert.match(result.stdout, /delegate/);
});

test("usage errors are JSON when --json is present", async () => {
  const result = await runStatus(["--json", "--only", "nope"], {
    pluginRoot: PLUGIN_ROOT,
    existsSyncImpl: () => true,
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "unknown engine: nope; allowed: codex,antigravity,delegate",
  });
});

test("raw quoted slash usage errors still honor --json", async () => {
  const result = await runStatus(["--json --only nope"], {
    pluginRoot: PLUGIN_ROOT,
    existsSyncImpl: () => true,
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "unknown engine: nope; allowed: codex,antigravity,delegate",
  });
});

test("--raw-args-stdin usage errors still honor --json", async () => {
  const result = await runStatus(["--raw-args-stdin"], {
    pluginRoot: PLUGIN_ROOT,
    existsSyncImpl: () => true,
    readStdinImpl: () => "--json --only nope\n",
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    error: "unknown engine: nope; allowed: codex,antigravity,delegate",
  });
});
