import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { SpawnedCodexAppServerClient } from "../../plugins/codex/scripts/lib/app-server.mjs";

// The app-server delivers turn completion as JSONL notifications on stdout, and a
// waiting turn only fails via exitPromise (the transport watchdog). The proc
// 'exit' event is not the only way the connection can die: if the app-server
// closes its stdout (EOF) but the process lingers — a wedged upstream — no
// notification and no 'exit' ever comes, so exitPromise must still resolve off
// the stdout EOF or the turn hangs silently (idle watchdog is off by default).
// This matters doubly because the broker's own upstream client IS this direct
// client: without it, the broker's attachUpstreamExitHandler never fires.
test("SpawnedCodexAppServerClient treats an unexpected stdout EOF as connection death", async () => {
  const client = new SpawnedCodexAppServerClient("/ws");
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  client.attachTransportStream(stdout);

  // A turn is mid-flight, waiting on a notification. The app-server closes its
  // stdout without exiting: EOF with no terminal notification.
  stdout.end();

  await client.exitPromise; // before the fix this never resolved -> silent hang
  assert.ok(client.exitError, "an unexpected stdout EOF must be recorded as an exit error so a waiting turn fails");
});

test("SpawnedCodexAppServerClient does not flag stdout EOF as an error during our own close()", async () => {
  const client = new SpawnedCodexAppServerClient("/ws");
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  client.attachTransportStream(stdout);

  client.closed = true; // simulate an intentional close() in progress
  stdout.end();

  await client.exitPromise;
  assert.equal(client.exitError, null, "an intentional shutdown must resolve cleanly, not as a transport error");
});

// On graceful shutdown the broker calls appClient.close(); on POSIX that used to
// send a bare SIGTERM to the codex app-server pid only, orphaning its MCP/tool
// subprocesses. close() must reap the whole tree via terminateProcessTree on
// every platform.

test("terminateChild reaps the whole process tree (terminateProcessTree), never a bare proc.kill", () => {
  const reaped = [];
  const client = new SpawnedCodexAppServerClient("/ws", {
    terminateProcessTreeImpl: (pid) => {
      reaped.push(pid);
    }
  });
  client.proc = {
    pid: 4242,
    killed: false,
    exitCode: null,
    kill() {
      throw new Error("close must not bare-kill the direct child; it must reap the tree");
    }
  };

  client.terminateChild();

  assert.deepEqual(reaped, [4242]);
});

test("terminateChild does nothing once the child has already exited", () => {
  const reaped = [];
  const client = new SpawnedCodexAppServerClient("/ws", {
    terminateProcessTreeImpl: (pid) => reaped.push(pid)
  });
  client.proc = { pid: 4242, killed: false, exitCode: 0 };

  client.terminateChild();

  assert.deepEqual(reaped, []);
});

test("terminateChild swallows reaper errors (best-effort cleanup)", () => {
  const client = new SpawnedCodexAppServerClient("/ws", {
    terminateProcessTreeImpl: () => {
      throw new Error("kill boom");
    }
  });
  client.proc = { pid: 4242, killed: false, exitCode: null };

  assert.doesNotThrow(() => client.terminateChild());
});
