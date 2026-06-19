import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderStatus,
  renderResult,
} from "../../plugins/cc/scripts/lib/render.mjs";

test("renderStatus: empty and populated", () => {
  assert.match(renderStatus([]), /No cc jobs/);
  const text = renderStatus([
    {
      id: "dlg-1",
      status: "running",
      title: "fix the bug",
      createdAt: "2026-06-11T00:00:00Z",
      request: { profile: "kimi" },
    },
  ]);
  assert.match(text, /dlg-1/);
  assert.match(text, /running/);
  assert.match(text, /kimi/);
  assert.match(text, /fix the bug/);
});

test("renderResult: completed shows result text; failed shows error + log tail + errorKind", () => {
  const ok = renderResult(
    {
      id: "dlg-1",
      status: "completed",
      title: "done one",
      resultText: "all done",
      request: { profile: "kimi" },
    },
    "",
  );
  assert.match(ok, /dlg-1/);
  assert.match(ok, /completed/);
  assert.match(ok, /kimi/);
  assert.match(ok, /all done/);
  const bad = renderResult(
    {
      id: "dlg-2",
      status: "failed",
      error: "auth failed",
      errorKind: "auth",
      sessionId: "s1",
      request: { profile: "glm" },
    },
    "line1\nline2",
  );
  assert.match(bad, /failed/);
  assert.match(bad, /glm/);
  assert.match(bad, /\[auth\]/, "failed header is annotated with errorKind");
  assert.match(bad, /auth failed/);
  assert.match(bad, /line2/);
  assert.match(bad, /--resume-job/, "failed jobs advertise resume");
});
