import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { binaryAvailable, isProcessAlive, runCommand, terminateProcessTree } from "../../skills/codex/scripts/lib/process.mjs";

test("runCommand never runs through a shell and forwards args as a literal array (no shell injection)", () => {
  // Regression for the Windows shell:true + array-args path that let a
  // user-controlled value (e.g. a git --base ref) inject into cmd.exe (DEP0190).
  let captured = null;
  runCommand("git", ["diff", "main & calc.exe", "$(whoami)"], {
    spawnImpl(command, args, opts) {
      captured = { command, args, opts };
      return { status: 0, signal: null, stdout: "", stderr: "", error: null };
    }
  });
  assert.ok(captured, "spawn implementation should have been invoked");
  assert.equal(captured.opts.shell, false);
  assert.deepEqual(captured.args, ["diff", "main & calc.exe", "$(whoami)"]);
});

test("terminateProcessTree refuses non-integer or non-positive pids without signalling", () => {
  for (const bogus of [123.5, 0, -5, NaN, Number.POSITIVE_INFINITY]) {
    const outcome = terminateProcessTree(bogus, {
      platform: "linux",
      killImpl() {
        throw new Error(`must not signal for ${String(bogus)}`);
      },
      runCommandImpl() {
        throw new Error(`must not run taskkill for ${String(bogus)}`);
      }
    });
    assert.equal(outcome.attempted, false, `expected no attempt for ${String(bogus)}`);
  }
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("isProcessAlive returns true for the current process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive returns false for a pid that was never assigned", () => {
  // PID_MAX on Linux/macOS is below 4 million; 2**31 - 1 will never exist.
  assert.equal(isProcessAlive(2147483646), false);
});

test("isProcessAlive rejects malformed pid values without throwing", () => {
  for (const bogus of [0, -1, NaN, Number.POSITIVE_INFINITY, undefined, null, "", "not-a-number", {}, []]) {
    assert.equal(isProcessAlive(bogus), false, `expected false for ${String(bogus)}`);
  }
});

test("isProcessAlive accepts numeric strings that parse to a live pid", () => {
  assert.equal(isProcessAlive(String(process.pid)), true);
});

test("binaryAvailable gives up on a probe that never answers and says which binary hung", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hang-"));
  const fake = path.join(dir, "codex");
  fs.writeFileSync(fake, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const started = Date.now();
  const status = binaryAvailable(fake, ["--version"], { timeout: 500 });
  assert.ok(Date.now() - started < 10_000, "the probe must return near its timeout, not when the binary exits");
  assert.equal(status.available, false);
  assert.match(status.detail, /did not answer within 1s; the .*codex binary first on PATH hangs at startup/);
});

test("binaryAvailable still reports a probe that answers in time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ok-"));
  const fake = path.join(dir, "codex");
  fs.writeFileSync(fake, "#!/bin/sh\necho codex-cli 9.9.9\n", { mode: 0o755 });
  assert.deepEqual(binaryAvailable(fake, ["--version"], { timeout: 5000 }), { available: true, detail: "codex-cli 9.9.9" });
});

test("codexUnavailableError keeps a hang's reason and does not send the host to reinstall", async () => {
  const { codexUnavailableError } = await import("../../skills/codex/scripts/lib/codex.mjs");
  const hung = codexUnavailableError({ available: false, detail: "`codex --version` did not answer within 30s; the codex binary first on PATH hangs at startup (check `command -v codex`)" });
  assert.match(hung.message, /^Codex CLI did not start: `codex --version` did not answer within 30s/);
  assert.doesNotMatch(hung.message, /npm install/);
  const missing = codexUnavailableError({ available: false, detail: "not found" });
  assert.match(missing.message, /not installed or is missing required runtime support \(not found\)\. Install it/);
});
