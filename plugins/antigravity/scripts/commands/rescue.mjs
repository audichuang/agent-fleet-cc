/**
 * /antigravity:rescue — hand a free-form task off to Antigravity (agy).
 *
 * Runs on the shared runtime (Phase 4e): runForeground/startBackground drive
 * the shared worker lifecycle; the launch seam lives in lib/job-runtime.mjs.
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
 *   --model <id>          native agy --model, forwarded verbatim
 *   --json                emit JSON instead of markdown
 */

import fs from "node:fs";

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildRescuePrompt } from "../lib/prompt-templates.mjs";
import { runForeground, startBackground, projectJob } from "../lib/job-runtime.mjs";
import { waitForJob } from "../lib/shared/core/wait.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import { outputCommandResult } from "../lib/render.mjs";

// A background --wait blocks on an explicit finite budget (shared waitForJob has
// no infinite mode). 15m mirrors the wait command's default.
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["conversation", "model", "cwd", "add-dir", "prompt-file"],
    booleanOptions: [
      "background", "wait", "resume", "continue", "fresh", "json",
      "apply", "dangerously-skip-permissions",
    ],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const json = Boolean(options.json);

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
  let conversationId = null;
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

  // Write mode is opt-in (default: text-out). skipPermissions is gated behind
  // --apply — it is meaningless (and unsafe) without write access.
  const write = Boolean(options.apply);
  const skipPermissions = write && Boolean(options["dangerously-skip-permissions"]);

  // M8: conversationId (?? null) flows into request so --continue/--conversation
  // resume survives the rewiring (the adapter reads only job.request.conversationId).
  const request = { mode, conversationId: conversationId ?? null, model, addDirs, write, skipPermissions };

  if (options.background) {
    const { stateDir, job } = startBackground({
      cwd: workspaceRoot,
      kind: "rescue",
      title,
      prompt,
      request,
    });
    const payload = {
      jobId: job.id,
      status: "queued",
      message: `Background rescue started. Run /antigravity:status ${job.id} to check progress.`,
    };
    outputCommandResult(
      payload,
      `Background rescue started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
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
      return projected.status === "completed" ? 0 : projected.status === "cancelled" ? 2 : 1;
    }
    return 0;
  }

  const { job: finished } = await runForeground({
    cwd: workspaceRoot,
    kind: "rescue",
    title,
    prompt,
    request,
  });

  if (finished.errorKind === "auth") {
    process.stderr.write(
      "\nantigravity:rescue — Antigravity is not authenticated.\nRun /antigravity:setup to complete the OAuth flow, then retry.\n",
    );
    return 1;
  }
  if (finished.status !== "completed") {
    process.stderr.write(`\nantigravity:rescue — failed (${finished.status}).\n`);
    if (finished.error) process.stderr.write(finished.error);
    return finished.status === "cancelled" ? 2 : 1;
  }

  outputCommandResult({ rescue: finished.resultText }, finished.resultText ?? "", json);
  return 0;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runAsMain(import.meta.url, run, "rescue");
