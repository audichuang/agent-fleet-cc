import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderStoredJobResult,
  renderTaskResult
} from "../../plugins/codex/scripts/lib/render.mjs";

test("renderCancelReport confirms cancellation when the job was actually cancelled", () => {
  const out = renderCancelReport({ id: "job-y", status: "cancelled", title: "Investigate" });
  assert.match(out, /Cancelled job-y\./);
});

test("renderCancelReport reports the real terminal status when the cancel lost the race", () => {
  // The job finalized as completed before cancel's durable write won, so the
  // report must NOT claim it was cancelled.
  const out = renderCancelReport({ id: "job-x", status: "completed", title: "Investigate" });
  assert.doesNotMatch(out, /Cancelled job-x\./);
  assert.match(out, /completed/i);
  assert.match(out, /job-x/);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderJobStatusReport surfaces timedOut jobs without the misleading 'aborted' wording", () => {
  const output = renderJobStatusReport({
    id: "task-timeout-render",
    status: "failed",
    phase: "failed",
    timedOut: true,
    title: "Long-running task",
    errorMessage:
      "Tracked job task-timeout-render exceeded the 15m hard timeout; the job record was marked failed. The underlying runner was not cancelled and may still be executing in the background — kill it manually if it keeps consuming resources.",
    duration: "15m 1s",
    jobClass: "task",
    kindLabel: "rescue"
  });

  // New wording must be present
  assert.match(output, /Hard timeout: job marked failed after exceeding the configured duration\./);
  assert.match(output, /underlying runner was not cancelled and may still be executing/);
  // Misleading wording from the prior version must NOT be present
  assert.doesNotMatch(output, /runner watchdog aborted the job/);
  // Error message must still be rendered
  assert.match(output, /Error: Tracked job task-timeout-render exceeded the 15m hard timeout/);
});

test("renderJobStatusReport surfaces autoReconciled jobs with PID context", () => {
  const output = renderJobStatusReport({
    id: "task-zombie-render",
    status: "failed",
    phase: "failed",
    autoReconciled: true,
    reconciledDeadPid: 90016,
    title: "Dead companion",
    errorMessage: "Worker process PID 90016 exited without reporting a terminal status; auto-reconciled as failed.",
    duration: "13m 36s",
    jobClass: "task",
    kindLabel: "rescue"
  });

  assert.match(output, /Auto-reconciled as failed: worker process \(PID 90016\) exited without reporting\./);
});

test("renderTaskResult surfaces the failure reason above a failed turn's partial output", () => {
  // /codex:task's stdout is returned VERBATIM to the user (commands/task.md), so a
  // failed turn that still produced an agent message must not read as a plain answer.
  const output = renderTaskResult(
    {
      rawOutput: "Here is what I found so far.",
      failureMessage: "stream disconnected",
      errorMessage: "Codex ended the turn with a failure: 429 rate limit."
    },
    { title: "Codex Task", jobId: null, write: false }
  );

  assert.match(output, /failed/i);
  assert.match(output, /429 rate limit\./);
  // The partial answer is kept, but BELOW the reason.
  assert.ok(
    output.indexOf("429 rate limit") < output.indexOf("Here is what I found so far."),
    "the failure reason must come first, or a verbatim paste hides it"
  );
});

test("renderTaskResult leaves a successful turn's output untouched", () => {
  const output = renderTaskResult({ rawOutput: "All done.", failureMessage: "" }, {});
  assert.equal(output, "All done.\n");
});

test("renderStoredJobResult prefixes status and failure reason onto a failed job's stored output", () => {
  // The rawOutput branch used to preempt the status/errorMessage block entirely, so
  // /codex:result re-served a failed job's partial answer with no status line at all.
  const output = renderStoredJobResult(
    {
      id: "task-failed",
      status: "failed",
      title: "Codex Task",
      jobClass: "task",
      errorMessage: "Codex ended the turn with a failure: 429 rate limit."
    },
    {
      threadId: "thr_9",
      result: { rawOutput: "Here is what I found so far." }
    }
  );

  assert.match(output, /Status: failed/);
  assert.match(output, /429 rate limit\./);
  assert.match(output, /Here is what I found so far\./);
  assert.match(output, /Codex session ID: thr_9/);
});

test("renderStoredJobResult does not repeat a failure reason that IS the stored body", () => {
  // A turn that died before any agent message stores the error text AS its rawOutput
  // (codex.mjs resolveFinalMessage falls back to it), so the header reason and the body
  // are the same sentence. Status still has to show; the reason must not be said twice.
  const reason = "Codex turn failed: 401 Unauthorized (upstream auth rejected).";
  const output = renderStoredJobResult(
    { id: "task-failed-noanswer", status: "failed", title: "Codex Task", jobClass: "task", errorMessage: reason },
    { result: { rawOutput: reason } }
  );

  assert.match(output, /Status: failed/);
  assert.equal((output.match(/401 Unauthorized/g) ?? []).length, 1);
});

// NOTE for the next reader: this test and "renderTaskResult leaves a successful turn's
// output untouched" pass both with and without the failure-header change — that is the
// point. They are no-regression guards on the SUCCESS path (failureReasonFor returns
// null at status 0, so a completed job must render byte-identically). Do not "fix" them
// into failure-path tests; the failure path is pinned by the e2e tests in
// turn-error-surfacing.test.mjs, which go through the real companion.
test("renderStoredJobResult does not prefix a status header onto a completed job", () => {
  const output = renderStoredJobResult(
    { id: "task-ok", status: "completed", title: "Codex Task", jobClass: "task" },
    { result: { rawOutput: "All done." } }
  );

  assert.equal(output, "All done.\n");
});
