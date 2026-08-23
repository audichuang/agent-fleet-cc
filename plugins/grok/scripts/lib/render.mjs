import { formatLiveness } from "./shared/core/liveness.mjs";

// livenessById: { [jobId]: projection } for active jobs (see collectLiveness).
// Active jobs get an indented liveness line so `/grok:status` alone answers
// "is it still alive and what is it doing?".
export function renderStatus(jobs, livenessById = {}) {
  if (!jobs.length) return "No grok jobs in this workspace.";
  return jobs
    .map((job) => {
      const head = [
        job.id,
        (job.status ?? "?").padEnd(9),
        `model=${job.request?.model ?? "grok-4.5"}`,
        job.createdAt ?? "",
        job.title ? `"${job.title}"` : "",
      ]
        .filter(Boolean)
        .join("  ");
      const live = livenessById[job.id];
      return live ? `${head}\n    ↳ ${formatLiveness(live)}` : head;
    })
    .join("\n");
}

export function renderResult(job, logTail = "") {
  const head = `[${job.id}] ${job.status} (model=${job.request?.model ?? "grok-4.5"})`;
  if (job.status === "completed") {
    return `${head}\n\n${job.resultText ?? "(no result text)"}`;
  }
  const lines = [job.errorKind ? `${head} [${job.errorKind}]` : head];
  if (job.error) lines.push(`error: ${job.error}`);
  // A non-completed job (failed / timed-out / cancelled) can still carry usable
  // text — e.g. a max-turns run that produced a partial answer. Surface it
  // instead of hiding it behind the error.
  if (job.resultText) lines.push("", job.resultText);
  if (logTail) lines.push("", "--- log tail ---", logTail);
  // job.sessionId is only written on a normal finalize; a worker that died
  // mid-run carries just the pre-minted request.sessionId — exactly the
  // crash-safe-resume case that id exists for. Reading both fields IS the whole
  // predicate (grok-companion.mjs's effectiveSessionId), inlined here because
  // importing it back would make render ↔ companion a cycle.
  if (job.sessionId ?? job.request?.sessionId) {
    lines.push("", `Tip: continue this thread with: task --resume-job ${job.id} "<follow-up>"`);
  }
  return lines.join("\n");
}
