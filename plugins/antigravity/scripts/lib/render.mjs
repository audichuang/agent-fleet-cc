/**
 * Output rendering — formats reviews, status, results, and reports as markdown.
 */

/**
 * Tolerantly extract the structured review object agy was asked to emit. agy
 * `--print` returns free text, so the model may wrap the JSON in a ```json
 * fence or surround it with prose; we strip the fence or slice the outermost
 * `{...}`. Returns a normalized review (renderReviewResult-ready) or null when
 * no JSON object can be recovered.
 *
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseReviewJson(stdout) {
  if (typeof stdout !== "string") return null;
  let text = stdout.trim();
  if (!text) return null;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
  } else if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    text = text.slice(start, end + 1);
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return normalizeReview(obj);
}

function normalizeReview(obj) {
  return {
    verdict: typeof obj.verdict === "string" ? obj.verdict : "needs_attention",
    summary: typeof obj.summary === "string" ? obj.summary : "",
    findings: Array.isArray(obj.findings) ? obj.findings.map(normalizeFinding) : [],
    next_steps: Array.isArray(obj.next_steps) ? obj.next_steps.filter((s) => typeof s === "string") : [],
  };
}

function normalizeFinding(f) {
  return {
    severity: typeof f?.severity === "string" ? f.severity.toLowerCase() : "medium",
    title: typeof f?.title === "string" ? f.title : "(untitled)",
    body: typeof f?.body === "string" ? f.body : "",
    file: typeof f?.file === "string" ? f.file : "",
    line_start: Number.isFinite(f?.line_start) ? f.line_start : 0,
    line_end: Number.isFinite(f?.line_end) ? f.line_end : 0,
    confidence: Number.isFinite(f?.confidence) ? f.confidence : 0.5,
    recommendation: typeof f?.recommendation === "string" ? f.recommendation : "",
  };
}

/**
 * Render a structured review result (from adversarial review) as markdown.
 *
 * @param {{ verdict: string, summary: string, findings: Array<{ severity: string, title: string, body: string, file: string, line_start: number, line_end: number, confidence: number, recommendation: string }>, next_steps: string[] }} review
 * @returns {string}
 */
export function renderReviewResult(review) {
  const lines = [];
  const icon = review.verdict === "approve" ? "APPROVED" : "NEEDS ATTENTION";
  lines.push(`# Antigravity Adversarial Review: ${icon}`);
  lines.push("");
  lines.push(`**Verdict:** ${review.verdict}`);
  lines.push(`**Summary:** ${review.summary}`);

  if (review.findings.length === 0) {
    lines.push("");
    lines.push("No material findings.");
  } else {
    lines.push("");
    lines.push(`## Findings (${review.findings.length})`);
    lines.push("");

    // Sort by severity: critical > high > medium > low.
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...review.findings].sort(
      (a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4)
    );

    for (const finding of sorted) {
      const conf = Math.round(finding.confidence * 100);
      lines.push(`### [${finding.severity.toUpperCase()}] ${finding.title} (${conf}% confidence)`);
      lines.push("");
      lines.push(`**File:** \`${finding.file}\` lines ${finding.line_start}-${finding.line_end}`);
      lines.push("");
      lines.push(finding.body);
      if (finding.recommendation) {
        lines.push("");
        lines.push(`**Recommendation:** ${finding.recommendation}`);
      }
      lines.push("");
    }
  }

  if (review.next_steps.length > 0) {
    lines.push("## Next Steps");
    lines.push("");
    for (const step of review.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a status snapshot as markdown.
 *
 * @param {{ workspaceRoot: string, config: any, runtimeStatus: any, running: any[], latestFinished: any, recent: any[], needsReview: boolean }} snapshot
 * @returns {string}
 */
export function renderStatusSnapshot(snapshot) {
  const lines = [];
  lines.push("# Antigravity Status");
  lines.push("");

  // Review gate status.
  const gateStatus = snapshot.needsReview ? "enabled" : "disabled";
  lines.push(`Review gate: ${gateStatus}`);
  lines.push("");

  // Running jobs.
  if (snapshot.running.length > 0) {
    lines.push("## Active Jobs");
    lines.push("");
    lines.push("| Job ID | Kind | Status | Phase | Health | Last Progress | Elapsed | Summary |");
    lines.push("|--------|------|--------|-------|--------|---------------|---------|---------|");
    for (const job of snapshot.running) {
      const elapsed = computeElapsedDisplay(job);
      lines.push(
        `| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${job.phase ?? "-"} | ${job.healthStatus ?? "-"} | ${job.lastProgressAt ?? "-"} | ${elapsed} | ${job.summary ?? "-"} |`
      );
    }
    lines.push("");
  }

  // Recent completed jobs.
  if (snapshot.recent.length > 0) {
    lines.push("## Recent Jobs");
    lines.push("");
    lines.push("| Job ID | Kind | Status | Duration | Summary | Follow-up |");
    lines.push("|--------|------|--------|----------|---------|-----------|");
    for (const job of snapshot.recent) {
      const duration = computeElapsedDisplay(job);
      const followUp = job.status === "completed" ? `/antigravity:result ${job.id}` : "-";
      lines.push(`| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${duration} | ${job.summary ?? "-"} | ${followUp} |`);
    }
    lines.push("");
  }

  if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
    lines.push("No antigravity jobs found for this session.");
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const TAIL_N = 5;

function formatEventLineBrief(event) {
  switch (event.type) {
    case "model_text_chunk":
    case "model_thought_chunk":
      return `[${event.type}] ${event.chars ?? 0} chars`;
    case "tool_call":
      return `[tool_call] ${event.toolName ?? "unknown"}`;
    case "file_change":
      return `[file_change] ${event.action ?? "modify"} ${event.path ?? ""}`;
    case "phase":
      return `[phase] ${event.message ?? ""}`;
    case "phase_changed":
      return `[phase_changed] ${event.phase ?? event.message ?? ""}`;
    case "diagnostic":
    case "error":
    case "stderr":
      return event.source
        ? `[${event.type}] ${event.source}: ${event.message ?? ""}`
        : `[${event.type}] ${event.message ?? ""}`;
    default:
      return `[${event.type ?? "event"}]`;
  }
}

function formatAgo(nowMs, timestamp) {
  const tsMs = Date.parse(timestamp ?? "");
  if (Number.isNaN(tsMs)) return "";
  const delta = Math.max(0, nowMs - tsMs);
  if (delta < 1000) return `${delta}ms ago`;
  return `${(delta / 1000).toFixed(1)}s ago`;
}

function rollupCounters(events) {
  const c = { chunks: 0, thoughts: 0, tools: 0, files: 0 };
  for (const e of events) {
    if (e.type === "model_text_chunk") c.chunks += 1;
    else if (e.type === "model_thought_chunk") c.thoughts += 1;
    else if (e.type === "tool_call") c.tools += 1;
    else if (e.type === "file_change") c.files += 1;
  }
  return c;
}

/**
 * Render a single job's detailed status.
 *
 * @param {{ job: any } | any} snapshotOrJob - Either a { job } wrapper (legacy) or a bare job object.
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function renderSingleJobStatus(snapshotOrJob, options = {}) {
  const isSnapshotWrapper =
    snapshotOrJob &&
    typeof snapshotOrJob === "object" &&
    Object.prototype.hasOwnProperty.call(snapshotOrJob, "workspaceRoot") &&
    Object.prototype.hasOwnProperty.call(snapshotOrJob, "job");
  const job = isSnapshotWrapper ? snapshotOrJob.job : snapshotOrJob;
  const lines = [];
  lines.push(`# Antigravity Job: ${job.id}`);
  lines.push("");
  lines.push(`- **Kind:** ${job.kind ?? "unknown"}`);
  lines.push(`- **Status:** ${job.status}`);
  lines.push(`- **Phase:** ${job.phase ?? "-"}`);
  lines.push(`- **Title:** ${job.title ?? "-"}`);
  if (job.threadId) {
    lines.push(`- **Session ID:** ${job.threadId}`);
  }
  if (job.summary) {
    lines.push(`- **Summary:** ${job.summary}`);
  }

  lines.push("");
  lines.push("## Health");
  lines.push("");
  lines.push(`- **Health:** ${job.healthStatus ?? "-"}`);
  lines.push(`- **Diagnostic:** ${job.healthMessage ?? "-"}`);
  lines.push(`- **Recommended Action:** ${job.recommendedAction ?? "-"}`);

  lines.push("");
  lines.push("## Runtime");
  lines.push("");
  lines.push(`- **Elapsed:** ${job.elapsed ?? "-"}`);
  if (job.runtime?.transport) {
    lines.push(`- **Transport:** ${job.runtime.transport}`);
  }
  lines.push(`- **PID:** ${job.pid ?? "-"}`);
  lines.push(`- **Created:** ${job.createdAt ?? "-"}`);
  lines.push(`- **Started:** ${job.startedAt ?? "-"}`);
  lines.push(`- **Updated:** ${job.updatedAt ?? "-"}`);
  lines.push(`- **Completed:** ${job.completedAt ?? "-"}`);
  lines.push(`- **Last Heartbeat:** ${job.lastHeartbeatAt ?? "-"}`);
  lines.push(`- **Last Progress:** ${job.lastProgressAt ?? "-"}`);
  lines.push(`- **Last Model Output:** ${job.lastModelOutputAt ?? "-"}`);
  lines.push(`- **Last Tool Call:** ${job.lastToolCallAt ?? "-"}`);
  lines.push(`- **Last Diagnostic:** ${job.lastDiagnosticAt ?? "-"}`);

  if (job.errorMessage) {
    lines.push("");
    lines.push("## Error");
    lines.push("");
    lines.push(job.errorMessage);
  }

  if (job.recentProgress && job.recentProgress.length > 0) {
    lines.push("");
    lines.push("## Recent Progress");
    lines.push("");
    for (const line of job.recentProgress) {
      lines.push(line);
    }
  }

  if (Array.isArray(job.events) && job.events.length > 0) {
    const nowMs = options?.now ?? Date.now();
    const allEvents = job.events;
    const tail = allEvents.slice(-TAIL_N);
    const last = allEvents[allEvents.length - 1];
    const counters = rollupCounters(allEvents);

    lines.push("");
    lines.push("## Recent Events");
    lines.push("");
    lines.push(`  last event: ${formatEventLineBrief(last)} - ${formatAgo(nowMs, last.timestamp)}`);
    lines.push("  recent:");
    for (const event of tail) {
      lines.push(`    ${formatEventLineBrief(event)}  ${formatAgo(nowMs, event.timestamp)}`);
    }
    lines.push(`  totals: chunks=${counters.chunks}  thoughts=${counters.thoughts}  tools=${counters.tools}  files=${counters.files}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a stored job result for the /antigravity:result command.
 *
 * @param {string} cwd
 * @param {any} job - The job index entry.
 * @param {any} storedJob - The full stored job file data.
 * @returns {string}
 */
/**
 * agy does not expose the conversation id in `--print` output, so we can rarely
 * capture a thread id. When we have one, point at `--conversation <id>`;
 * otherwise point at the working `--continue` (resume the most recent).
 */
function formatResumeHint(threadId) {
  if (threadId) {
    return `\nConversation ID: ${threadId}\nResume conversation: agy --conversation ${threadId}\n`;
  }
  return "\nResume the most recent agy conversation: agy --continue (or /antigravity:rescue --continue)\n";
}

export function renderResultOutput(cwd, job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;

  // If there's raw text output, return it.
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.agy?.stdout === "string" && storedJob.result.agy.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    return `${output}${formatResumeHint(threadId)}`;
  }

  // If there's pre-rendered output, return it.
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    return `${output}${formatResumeHint(threadId)}`;
  }

  // Fallback: build from job metadata.
  const lines = [
    `# ${job.title ?? "Antigravity Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Conversation ID: ${threadId}`);
    lines.push(`Resume conversation: agy --conversation ${threadId}`);
  } else {
    lines.push("Resume the most recent agy conversation: agy --continue (or /antigravity:rescue --continue)");
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a cancel report.
 *
 * @param {any} job
 * @returns {string}
 */
export function renderCancelReport(job) {
  const lines = [
    "# Antigravity Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.kind) {
    lines.push(`- Kind: ${job.kind}`);
  }
  lines.push(`- Status: ${job.status}`);

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a setup report.
 *
 * @param {{ agyAvailable: boolean, agyVersion?: string, authenticated?: boolean, authMethod?: string, npmAvailable?: boolean, reviewGate?: boolean, message?: string }} report
 * @returns {string}
 */
export function renderSetupReport(report) {
  const lines = [];
  lines.push("# Antigravity Setup");
  lines.push("");

  if (report.agyAvailable) {
    lines.push(`- agy CLI: installed${report.agyVersion ? ` (${report.agyVersion})` : ""}`);
  } else {
    lines.push("- agy CLI: **not installed**");
  }

  if (report.authenticated !== undefined) {
    lines.push(`- Authentication: ${report.authenticated ? "authenticated" : "**not authenticated**"}`);
    if (report.authMethod) {
      lines.push(`- Auth method: ${report.authMethod}`);
    }
  }

  if (report.npmAvailable !== undefined) {
    lines.push(`- npm: ${report.npmAvailable ? "available" : "not available"}`);
  }

  if (report.reviewGate !== undefined) {
    lines.push(`- Review gate: ${report.reviewGate ? "enabled" : "disabled"}`);
  }

  if (report.message) {
    lines.push("");
    lines.push(report.message);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Output either JSON or rendered markdown based on the --json flag.
 *
 * @param {any} payload - The structured data.
 * @param {string} rendered - The markdown rendering.
 * @param {boolean} json - Whether to output JSON.
 */
export function outputCommandResult(payload, rendered, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

function computeElapsedDisplay(job) {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? new Date().toISOString();
  if (!start) {
    return "-";
  }
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${Math.round(ms / 60000)}m`;
}

function formatEventLine(event) {
  const parts = [
    event.timestamp ?? "-",
    event.type ?? "event"
  ];
  const details = [];
  if (event.phase) {
    details.push(`phase=${event.phase}`);
  }
  if (event.toolName) {
    details.push(`tool=${event.toolName}`);
  }
  if (event.path) {
    details.push(`path=${event.path}`);
  }
  if (event.action) {
    details.push(`action=${event.action}`);
  }
  if (event.source) {
    details.push(`source=${event.source}`);
  }
  if (event.transport) {
    details.push(`transport=${event.transport}`);
  }
  if (event.message) {
    details.push(event.message);
  }
  return details.length > 0 ? `${parts.join(" ")} - ${details.join("; ")}` : parts.join(" ");
}
