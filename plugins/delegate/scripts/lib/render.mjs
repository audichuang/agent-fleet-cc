export function renderStatus(jobs) {
  if (!jobs.length) return "No delegate jobs in this workspace.";
  return jobs
    .map((job) =>
      [
        job.id,
        (job.status ?? "?").padEnd(9),
        `profile=${job.profile ?? "?"}`,
        job.createdAt ?? "",
        job.promptPreview ? `"${job.promptPreview}"` : "",
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

export function renderResult(job, logTail = "") {
  const head = `[${job.id}] ${job.status} (profile=${job.profile ?? "?"})`;
  if (job.status === "completed") {
    return `${head}\n\n${job.resultText ?? "(no result text)"}`;
  }
  const lines = [head];
  if (job.error) lines.push(`error: ${job.error}`);
  if (logTail) lines.push("", "--- log tail ---", logTail);
  if (job.sessionId) {
    lines.push(
      "",
      `Tip: continue this thread with: task --resume-id ${job.id} "<follow-up>"`,
    );
  }
  return lines.join("\n");
}
