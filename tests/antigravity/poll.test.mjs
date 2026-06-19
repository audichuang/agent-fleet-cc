import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  POLL_MS,
  TERMINAL_STATUSES,
  parseTimeoutMs,
  waitForTerminal,
} from "../../plugins/antigravity/scripts/lib/poll.mjs";

describe("poll helpers", () => {
  test("parseTimeoutMs returns the default when no value is provided", () => {
    assert.equal(parseTimeoutMs(undefined, 60000), 60000);
  });

  test("parseTimeoutMs accepts numeric millisecond values", () => {
    assert.equal(parseTimeoutMs("5000", 60000), 5000);
    assert.equal(parseTimeoutMs("0", 60000), 0);
  });

  test("parseTimeoutMs rejects invalid values", () => {
    assert.throws(
      () => parseTimeoutMs("", 60000),
      /--timeout-ms must be a non-negative number of milliseconds/,
    );
    assert.throws(
      () => parseTimeoutMs("-1", 60000),
      /--timeout-ms must be a non-negative number of milliseconds/,
    );
    assert.throws(
      () => parseTimeoutMs("abc", 60000),
      /--timeout-ms must be a non-negative number of milliseconds/,
    );
  });

  test("TERMINAL_STATUSES includes only terminal job states", () => {
    assert.equal(TERMINAL_STATUSES.has("completed"), true);
    assert.equal(TERMINAL_STATUSES.has("failed"), true);
    assert.equal(TERMINAL_STATUSES.has("cancelled"), true);
    assert.equal(TERMINAL_STATUSES.has("running"), false);
    assert.equal(TERMINAL_STATUSES.has("pending"), false);
  });

  test("POLL_MS is a positive interval", () => {
    assert.equal(typeof POLL_MS, "number");
    assert.equal(POLL_MS >= 1, true);
  });

  test("waitForTerminal resolves when injected snapshots reach a terminal state", async () => {
    let calls = 0;
    const result = await waitForTerminal("/repo", "j1", 60000, {
      buildSingleJobSnapshot(cwd, jobId) {
        calls += 1;
        assert.equal(cwd, "/repo");
        assert.equal(jobId, "j1");
        if (calls === 1) return { job: { id: "j1", status: "running" } };
        return { job: { id: "j1", status: "completed" } };
      },
    });

    assert.equal(result.timedOut, false);
    assert.equal(result.snapshot.job.status, "completed");
    assert.equal(calls, 2);
  });
});
