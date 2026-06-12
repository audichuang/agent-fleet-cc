/**
 * /antigravity:rescue — hand a free-form task off to Antigravity (agy).
 *
 * Positional: prompt text.
 * Flags:
 *   --background          fork worker, return immediately
 *   --wait                block until the job finishes
 *   --resume              continue the most recent agy conversation
 *   --fresh               start a new conversation (default if --resume not given)
 *   --continue            alias of --resume (parity with agy)
 *   --conversation <id>   resume a specific conversation
 *   --add-dir <path>      additional workspace dir (repeatable)
 *   --model <id>          accepted for forward-compat, currently logged + ignored
 *   --json                emit JSON instead of markdown
 */

import fs from "node:fs";

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildRescuePrompt } from "../lib/prompt-templates.mjs";
import { runForegroundJob, startBackgroundJob, waitForJob } from "../lib/job-helpers.mjs";
import { outputCommandResult } from "../lib/render.mjs";

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["conversation", "model", "cwd", "add-dir", "prompt-file"],
    booleanOptions: ["background", "wait", "resume", "continue", "fresh", "json"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let userPrompt = positionals.join(" ").trim();
  if (options["prompt-file"]) {
    try {
      userPrompt = fs.readFileSync(String(options["prompt-file"]), "utf8").trim();
    } catch (err) {
      process.stderr.write(`antigravity:rescue — could not read --prompt-file: ${err?.message ?? err}\n`);
      return 1;
    }
  }
  if (!userPrompt && !options.resume && !options.continue && !options.conversation) {
    process.stderr.write(
      "antigravity:rescue — no task text provided. Pass a prompt, --prompt-file <path>, or --conversation <id>.\n",
    );
    return 1;
  }

  // agy 1.0.7 has a native --model; forward it verbatim (no aliasing).
  const model = options.model ? String(options.model) : undefined;

  // Resolve conversation mode. --conversation wins; then --resume/--continue; then fresh.
  let mode = "print";
  let conversationId;
  if (options.conversation) {
    mode = "conversation";
    conversationId = String(options.conversation);
  } else if ((options.resume || options.continue) && !options.fresh) {
    mode = "continue";
  }

  const addDirs = Array.isArray(options["add-dir"])
    ? options["add-dir"].map(String)
    : options["add-dir"]
    ? [String(options["add-dir"])]
    : [];

  const prompt = buildRescuePrompt(userPrompt || "(continue)");
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;

  if (options.background) {
    const { job } = await startBackgroundJob({
      workspaceRoot,
      kind: "rescue",
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
      message: `Background rescue started. Run /antigravity:status ${job.id} to check progress.`,
    };
    outputCommandResult(
      payload,
      `Background rescue started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
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
    kind: "rescue",
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
      `\nantigravity:rescue — Antigravity is not authenticated. Run /antigravity:setup, then retry.\n`,
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
    process.stderr.write(`\nantigravity:rescue — failed (${result.status}).\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status === "cancelled" ? 2 : 1;
  }

  outputCommandResult({ rescue: result.stdout }, result.stdout, Boolean(options.json));
  return 0;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runAsMain(import.meta.url, run, "rescue");
