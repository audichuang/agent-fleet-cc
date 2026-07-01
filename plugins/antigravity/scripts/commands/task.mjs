/**
 * /antigravity:task — free-form prompt with state tracking.
 *
 * Defaults to BACKGROUND. Use --wait to block on completion or pass
 * --foreground to run inline. See /antigravity:rescue for the foreground-by-
 * default variant.
 *
 * Runs on the shared runtime (Phase 4e): runForeground/startBackground drive
 * the shared worker lifecycle; the launch seam lives in lib/job-runtime.mjs.
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
import { runForeground, startBackground, projectJob } from "../lib/job-runtime.mjs";
import { waitForJob } from "../lib/shared/core/wait.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import { outputCommandResult } from "../lib/render.mjs";

// A background --wait blocks on an explicit finite budget: shared waitForJob has
// no infinite mode (missing timeoutMs → deadline=NaN, always-false = fragile
// accidental-infinite). 15m mirrors the wait command's default.
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["conversation", "cwd", "add-dir", "model"],
    booleanOptions: ["wait", "foreground", "continue", "json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = options.model ? String(options.model) : undefined;
  const json = Boolean(options.json);

  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt && !options.continue && !options.conversation) {
    process.stderr.write("antigravity:task — no task text provided. Pass a prompt or --conversation <id>.\n");
    return 1;
  }

  let mode = "print";
  let conversationId = null;
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

  // M8: conversationId (?? null) flows into request so --continue/--conversation
  // resume survives the rewiring (the adapter reads only job.request.conversationId).
  const request = { mode, conversationId: conversationId ?? null, model, addDirs };

  if (options.foreground) {
    const { job: finished } = await runForeground({
      cwd: workspaceRoot,
      kind: "task",
      title,
      prompt,
      request,
    });

    if (finished.errorKind === "auth") {
      process.stderr.write(
        "\nantigravity:task — Antigravity is not authenticated.\nRun /antigravity:setup to complete the OAuth flow, then retry.\n",
      );
      return 1;
    }
    if (finished.status !== "completed") {
      process.stderr.write(`\nantigravity:task — failed (${finished.status}).\n`);
      if (finished.error) process.stderr.write(finished.error);
      return finished.status === "cancelled" ? 2 : 1;
    }
    outputCommandResult({ task: finished.resultText }, finished.resultText ?? "", json);
    return 0;
  }

  // Background path (default).
  const { stateDir, job } = startBackground({
    cwd: workspaceRoot,
    kind: "task",
    title,
    prompt,
    request,
  });
  const payload = {
    jobId: job.id,
    status: "queued",
    message: `Background task started. Run /antigravity:status ${job.id} to check progress.`,
  };
  outputCommandResult(
    payload,
    `Background task started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
    json,
  );

  if (options.wait) {
    const { done, job: final } = await waitForJob({
      stateDir,
      jobId: job.id,
      timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
      reconcile: reconcileDeadPids,
    });
    if (!final) return 1;
    if (!done) return 10;
    const projected = projectJob(final);
    if (projected.status === "completed" && projected.result?.rawOutput) {
      process.stdout.write(projected.result.rawOutput);
    }
    return projected.status === "completed" ? 0 : projected.status === "cancelled" ? 2 : 1;
  }
  return 0;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runAsMain(import.meta.url, run, "task");
