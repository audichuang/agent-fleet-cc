/**
 * /antigravity:review — read-only review of working tree or branch diff.
 *
 * Flags:
 *   --base <ref>      base ref for branch diff
 *   --scope <auto|working-tree|branch>
 *   --background      fire-and-forget worker, return immediately
 *   --wait            block until completion (foreground default)
 *   --continue        resume the last review conversation
 *   --conversation <id>  resume a specific conversation
 *   --json            output JSON instead of markdown
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildReviewPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runForegroundJob, startBackgroundJob, waitForJob } from "../lib/job-helpers.mjs";
import { outputCommandResult } from "../lib/render.mjs";

export async function run(argv = [], ctx = {}) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "conversation", "cwd", "model"],
    booleanOptions: ["background", "wait", "continue", "json", "no-sandbox"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scope = (options.scope ? String(options.scope) : "auto");
  const base = options.base ? String(options.base) : undefined;
  const model = options.model ? String(options.model) : undefined;
  // Review is read-only: run agy under --sandbox so a misbehaving model cannot
  // mutate the tree. Escape hatch: --no-sandbox.
  const sandbox = !options["no-sandbox"];

  let envelope;
  try {
    envelope = collectReviewContext(workspaceRoot, { scope, base });
  } catch (err) {
    process.stderr.write(`antigravity:review — ${err?.message ?? err}\n`);
    return 1;
  }

  if (!envelope.context.diff || envelope.context.diff.trim() === "") {
    process.stdout.write("antigravity:review — no changes to review.\n");
    return 0;
  }

  const prompt = buildReviewPrompt(envelope);
  const mode = options.conversation
    ? "conversation"
    : options.continue
    ? "continue"
    : "print";
  const conversationId = options.conversation ? String(options.conversation) : undefined;
  const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""}`;

  if (options.background) {
    const { job } = await startBackgroundJob({
      workspaceRoot,
      kind: "review",
      title,
      prompt,
      mode,
      conversationId,
      cwd: workspaceRoot,
      request: { scope: envelope.scope, base: base ?? null, mode, model, sandbox },
    });
    const payload = {
      jobId: job.id,
      status: "queued",
      message: `Background review started. Run /antigravity:status ${job.id} to check progress.`,
    };
    outputCommandResult(
      payload,
      `Background review started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
      Boolean(options.json),
    );
    if (options.wait) {
      const final = await waitForJob(workspaceRoot, job.id);
      return final?.status === "completed" ? 0 : final?.status === "cancelled" ? 2 : 1;
    }
    return 0;
  }

  const { result } = await runForegroundJob({
    workspaceRoot,
    kind: "review",
    title,
    prompt,
    mode,
    conversationId,
    model,
    sandbox,
    cwd: workspaceRoot,
    request: { scope: envelope.scope, base: base ?? null, mode, model, sandbox },
    onStdout: (chunk) => process.stderr.write(chunk),
  });

  if (result.status === "auth_required") {
    process.stderr.write(
      `\nantigravity:review — Antigravity is not authenticated.\n` +
        `Run /antigravity:setup to complete the OAuth flow, then retry.\n`,
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
    process.stderr.write(`\nantigravity:review — failed (${result.status}).\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status === "cancelled" ? 2 : 1;
  }

  const payload = {
    scope: envelope.scope,
    review: result.stdout,
  };
  outputCommandResult(payload, result.stdout, Boolean(options.json));
  return 0;
}

export default run;

runAsMain(import.meta.url, run, "review");
