/**
 * /antigravity:task — free-form prompt with state tracking.
 *
 * Defaults to BACKGROUND. Use --wait to block on completion or pass
 * --foreground to run inline. See /antigravity:rescue for the foreground-by-
 * default variant.
 *
 * Flags:
 *   --wait                block until completion
 *   --foreground          run inline instead of forking a worker
 *   --continue            resume the most recent agy conversation
 *   --conversation <id>   resume a specific conversation
 *   --add-dir <path>      additional workspace dir (repeatable)
 *   --json                emit JSON
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildTaskPrompt } from "../lib/prompt-templates.mjs";
import { runForegroundJob, startBackgroundJob, waitForJob } from "../lib/job-helpers.mjs";
import { outputCommandResult } from "../lib/render.mjs";

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["conversation", "cwd", "add-dir", "model"],
    booleanOptions: ["wait", "foreground", "continue", "json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = options.model ? String(options.model) : undefined;

  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt && !options.continue && !options.conversation) {
    process.stderr.write("antigravity:task — no task text provided. Pass a prompt or --conversation <id>.\n");
    return 1;
  }

  let mode = "print";
  let conversationId;
  if (options.conversation) {
    mode = "conversation";
    conversationId = String(options.conversation);
  } else if (options.continue) {
    mode = "continue";
  }

  const addDirs = Array.isArray(options["add-dir"])
    ? options["add-dir"].map(String)
    : options["add-dir"]
    ? [String(options["add-dir"])]
    : [];

  const prompt = buildTaskPrompt(userPrompt || "(continue)");
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;

  if (options.foreground) {
    const { result } = await runForegroundJob({
      workspaceRoot,
      kind: "task",
      title,
      prompt,
      mode,
      conversationId,
      addDirs,
      model,
      cwd: workspaceRoot,
      request: { mode, addDirs, model },
      onStdout: (chunk) => process.stderr.write(chunk),
    });

    if (result.status === "auth_required") {
      process.stderr.write(
        `\nantigravity:task — not authenticated. Run /antigravity:setup, then retry.\n`,
      );
      if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
      return 1;
    }
    if (result.status !== "completed") {
      process.stderr.write(`\nantigravity:task — failed (${result.status}).\n`);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.status === "cancelled" ? 2 : 1;
    }
    outputCommandResult({ task: result.stdout }, result.stdout, Boolean(options.json));
    return 0;
  }

  // Background path (default).
  const { job } = await startBackgroundJob({
    workspaceRoot,
    kind: "task",
    title,
    prompt,
    mode,
    conversationId,
    addDirs,
    cwd: workspaceRoot,
    request: { mode, addDirs, model },
  });
  const payload = {
    jobId: job.id,
    status: "queued",
    message: `Background task started. Run /antigravity:status ${job.id} to check progress.`,
  };
  outputCommandResult(
    payload,
    `Background task started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
    Boolean(options.json),
  );

  if (options.wait) {
    const final = await waitForJob(workspaceRoot, job.id);
    if (!final) return 1;
    if (final.status === "completed" && final.result?.rawOutput) {
      process.stdout.write(final.result.rawOutput);
    }
    return final.status === "completed" ? 0 : final.status === "cancelled" ? 2 : 1;
  }
  return 0;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runAsMain(import.meta.url, run, "task");
