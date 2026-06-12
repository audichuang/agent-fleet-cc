// tests/shared/job.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  newJobId,
  createJobRecord,
} from "../../shared/lib/core/job.mjs";

test("six-state machine sets", () => {
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ["queued", "running"]);
  assert.deepEqual(
    [...TERMINAL_STATUSES].sort(),
    ["cancelled", "completed", "failed", "timed-out"],
  );
});

test("newJobId: prefixed, sortable, unique", () => {
  const a = newJobId("dlg", 1000);
  const b = newJobId("dlg", 2000);
  assert.match(a, /^dlg-[a-z0-9]+-[0-9a-f]{6}$/);
  assert.ok(a < b, "timestamp segment must sort");
  assert.notEqual(newJobId("dlg", 1000), newJobId("dlg", 1000));
});

test("createJobRecord: unified core fields, engine extras under request", () => {
  const job = createJobRecord({
    engine: "delegate",
    title: "fix the bug",
    cwd: "/tmp/ws",
    timeoutMs: 60000,
    request: { profile: "deepseek", model: "deepseek-chat" },
  });
  assert.equal(job.engine, "delegate");
  assert.equal(job.status, "queued");
  assert.equal(job.title, "fix the bug");
  assert.equal(job.model, "deepseek-chat"); // 攤平自 request.model
  assert.equal(job.usage, null);
  assert.equal(job.exitCode, null); // session 型引擎可永遠 null
  assert.equal(job.sessionId, null);
  assert.deepEqual(job.request, { profile: "deepseek", model: "deepseek-chat" });
  assert.ok(job.id.startsWith("delegate-"));
  assert.ok(job.createdAt && job.updatedAt);
});

test("createJobRecord rejects unknown engine-less record", () => {
  assert.throws(() => createJobRecord({}), /engine/);
});
