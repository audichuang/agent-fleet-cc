import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { BROKER_ENDPOINT_ENV } from "../../plugins/codex/scripts/lib/app-server.mjs";
import { interruptAppServerTurn } from "../../plugins/codex/scripts/lib/codex.mjs";

test("interruptAppServerTurn no-ops instead of spawning a throwaway app-server when no broker session is recorded", async () => {
  // The turn lives on the SHARED broker. Without a recorded session, connect's
  // reuseExistingBroker fallback would spawn a fresh app-server that cannot own the
  // turn — the RPC then errors and the cancel path logs "interrupt failed" as if a
  // live turn had resisted. Assert the no-op, and that nothing was spawned.
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const previousPath = process.env.PATH;
  const previousEndpoint = process.env[BROKER_ENDPOINT_ENV];
  // helpers.mjs already strips CODEX_* from the test process; be explicit anyway so
  // the assertion cannot pass merely because an endpoint leaked in from a dev shell.
  delete process.env[BROKER_ENDPOINT_ENV];
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  try {
    const result = await interruptAppServerTurn(repo, { threadId: "thr_1", turnId: "turn_1" });

    assert.equal(result.attempted, false, "no broker session means there is nothing to interrupt");
    assert.equal(result.interrupted, false);
    assert.match(result.detail, /no shared Codex broker session/);
  } finally {
    process.env.PATH = previousPath;
    if (previousEndpoint !== undefined) {
      process.env[BROKER_ENDPOINT_ENV] = previousEndpoint;
    }
  }

  // The availability probe only runs `--version` / `app-server --help`, neither of
  // which boots the fake server, so any app-server start here would be the spawn we
  // are guarding against.
  const fakeState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  assert.ok(!fakeState?.appServerStarts, "the guard must return before any app-server is spawned");
});
