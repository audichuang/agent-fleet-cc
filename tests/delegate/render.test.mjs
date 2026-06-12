import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderStatus,
  renderResult,
} from "../../plugins/delegate/scripts/lib/render.mjs";

test("renderStatus: empty and populated", () => {
  assert.match(renderStatus([]), /No delegate jobs/);
  const text = renderStatus([
    {
      id: "dlg-1",
      status: "running",
      profile: "kimi",
      promptPreview: "fix the bug",
      createdAt: "2026-06-11T00:00:00Z",
    },
  ]);
  assert.match(text, /dlg-1/);
  assert.match(text, /running/);
  assert.match(text, /kimi/);
});

test("renderResult: completed shows result text; failed shows error + log tail", () => {
  const ok = renderResult(
    { id: "dlg-1", status: "completed", profile: "kimi", resultText: "all done" },
    "",
  );
  assert.match(ok, /all done/);
  const bad = renderResult(
    { id: "dlg-2", status: "failed", profile: "glm", error: "auth", sessionId: "s1" },
    "line1\nline2",
  );
  assert.match(bad, /failed/);
  assert.match(bad, /auth/);
  assert.match(bad, /line2/);
  assert.match(bad, /--resume-id/, "failed jobs advertise resume");
});
