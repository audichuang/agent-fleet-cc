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
  //
  // …but that id is minted BEFORE spawn, so on a job where grok never ran it names a
  // session that does not exist, and `--resume-job` fails on a tip we printed. Gate on
  // the only signal the JOB RECORD carries for "the engine never started": the failure
  // kind. `not-installed` is classifyError's ENOENT / exit-127 verdict (the binary
  // never executed); `spawn` is the companion's background-launch failure
  // (grok-companion.mjs); and a raw spawn throw with another errno (`spawn <path>
  // EACCES`) classifies as `unknown`, so match the error text too. Everything else —
  // exit-nonzero, timed-out, reconciled dead worker — means grok was spawned and may
  // well hold the session.
  // Why not the alternatives: `pid` is the WORKER's own pid, stamped by markJobRunning
  // BEFORE the spawn (shared runtime/worker.mjs:101), so it is set even when the spawn
  // throws; `exitCode` is null on BOTH a signal-killed timeout and a reconciled dead
  // worker (the very crash this tip exists for, reconcile.mjs); and `status` is
  // "failed" on both sides. Only the kind separates them.
  // ponytail: a job cancelled while still `queued` never spawned either and still gets
  // the tip; read the `spawned` event (events.ndjson) if that ever matters.
  const neverSpawned =
    job.errorKind === "not-installed" ||
    job.errorKind === "spawn" ||
    /^spawn /.test(job.error ?? "");
  if (!neverSpawned && (job.sessionId ?? job.request?.sessionId)) {
    lines.push("", `Tip: continue this thread with: task --resume-job ${job.id} "<follow-up>"`);
  }
  return lines.join("\n");
}
