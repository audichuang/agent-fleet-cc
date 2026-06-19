export function renderStatus(jobs) {
  if (!jobs.length) return "No cc jobs in this workspace.";
  return jobs
    .map((job) =>
      [
        job.id,
        (job.status ?? "?").padEnd(9),
        `profile=${job.request?.profile ?? "?"}`,
        job.createdAt ?? "",
        job.title ? `"${job.title}"` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

export function renderResult(job, logTail = "") {
  const head = `[${job.id}] ${job.status} (profile=${job.request?.profile ?? "?"})`;
  if (job.status === "completed") {
    return `${head}\n\n${job.resultText ?? "(no result text)"}`;
  }
  const lines = [job.errorKind ? `${head} [${job.errorKind}]` : head];
  if (job.error) lines.push(`error: ${job.error}`);
  if (logTail) lines.push("", "--- log tail ---", logTail);
  if (job.sessionId) {
    lines.push(
      "",
      `Tip: continue this thread with: task --resume-job ${job.id} "<follow-up>"`,
    );
  }
  return lines.join("\n");
}
