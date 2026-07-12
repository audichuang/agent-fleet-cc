export function renderStatus(jobs) {
  if (!jobs.length) return "No grok jobs in this workspace.";
  return jobs
    .map((job) =>
      [
        job.id,
        (job.status ?? "?").padEnd(9),
        `model=${job.request?.model ?? "grok-4.5"}`,
        job.createdAt ?? "",
        job.title ? `"${job.title}"` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
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
  if (job.sessionId) {
    lines.push("", `Tip: continue this thread with: task --resume-job ${job.id} "<follow-up>"`);
  }
  return lines.join("\n");
}
