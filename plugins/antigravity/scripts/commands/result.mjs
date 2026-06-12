/**
 * /antigravity:result — fetch a finished job's stored output.
 *
 * Exit codes:
 *   0  completed
 *   1  failed (or no job found)
 *   2  cancelled
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveResultJob } from "../lib/job-control.mjs";
import { readJobFile } from "../lib/state.mjs";
import { outputCommandResult, renderResultOutput } from "../lib/render.mjs";

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  let job;
  let workspaceRoot;
  try {
    ({ workspaceRoot, job } = resolveResultJob(cwd, reference));
  } catch (err) {
    process.stderr.write(`antigravity:result — ${err?.message ?? err}\n`);
    return 1;
  }

  const stored = readJobFile(workspaceRoot, job.id);
  const rendered = renderResultOutput(workspaceRoot, job, stored);
  const payload = {
    jobId: job.id,
    status: job.status,
    conversationId: stored?.conversationId ?? job.conversationId ?? null,
    result: stored?.result ?? null,
    rendered,
  };
  outputCommandResult(payload, rendered, json);

  switch (job.status) {
    case "completed":
      return 0;
    case "cancelled":
      return 2;
    default:
      return 1;
  }
}

export default run;

runAsMain(import.meta.url, run, "result");
