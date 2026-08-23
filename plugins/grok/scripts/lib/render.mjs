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

export function renderResult(job, logTail = "", resumeSessionId = job?.sessionId ?? null) {
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
  // resumeSessionId is the CALLER's session-provenance verdict — grok-companion.mjs's
  // resumableSessionId, which only hands over an id it can prove a session existed for.
  // Never derive it here from job.request.sessionId: that id is minted BEFORE spawn, so on
  // a job that died before grok opened a session (no credentials, bad flag, failed session
  // create) it names a session that does not exist and `--resume-job` fails on a tip we
  // printed. The verdict needs the job's event log, which render has no stateDir to read.
  // Default: the post-hoc job.sessionId, which comes off the `end`/json event and is
  // therefore self-proving — a caller that forgets the argument loses tips, never invents
  // one.
  if (resumeSessionId) {
    lines.push("", `Tip: continue this thread with: task --resume-job ${job.id} "<follow-up>"`);
  }
  return lines.join("\n");
}
