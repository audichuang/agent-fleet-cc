import test from "node:test";
import assert from "node:assert/strict";

import "./helpers.mjs"; // hermetic env isolation
import { isArchivedThreadError, resumeThread } from "../../skills/codex/scripts/lib/codex.mjs";

// The app-server's wording (codex-rs app-server thread_processor.rs), seen 2026-10-30/31
// when `task --thread` / `--resume-last` hit an archived thread.
const ARCHIVED = (id) => new Error(`session ${id} is archived. Run \`codex unarchive ${id}\` to unarchive it first.`);

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

test("resumeThread unarchives an archived thread and resumes it once", async () => {
  const client = fakeClient([ARCHIVED("t-1"), {}, { thread: { id: "t-1" } }]);
  const progress = [];
  const response = await resumeThread(client, "t-1", "/repo", { onProgress: (event) => progress.push(event) });
  assert.equal(response.thread.id, "t-1");
  assert.deepEqual(client.calls.map((call) => call.method), ["thread/resume", "thread/unarchive", "thread/resume"]);
  assert.deepEqual(client.calls[1].params, { threadId: "t-1" });
  assert.match(JSON.stringify(progress), /was archived; unarchiving it to continue/);
});

test("resumeThread does not unarchive on any other resume error", async () => {
  const client = fakeClient([new Error("thread not found: t-2")]);
  await assert.rejects(resumeThread(client, "t-2", "/repo"), /thread not found/);
  assert.deepEqual(client.calls.map((call) => call.method), ["thread/resume"]);
});

test("resumeThread retries only once: a second archived refusal surfaces", async () => {
  const client = fakeClient([ARCHIVED("t-3"), {}, ARCHIVED("t-3")]);
  await assert.rejects(resumeThread(client, "t-3", "/repo"), /is archived/);
  assert.equal(client.calls.length, 3);
});

test("isArchivedThreadError matches only the app-server's archived refusal", () => {
  assert.equal(isArchivedThreadError(ARCHIVED("x")), true);
  assert.equal(isArchivedThreadError(new Error("thread x is archived")), false);
  assert.equal(isArchivedThreadError(null), false);
});
