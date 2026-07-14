/**
 * /antigravity:review — read-only review of working tree or branch diff.
 *
 * Runs on the shared runtime (Phase 4e): runForeground/startBackground drive
 * the shared worker lifecycle; the launch seam lives in lib/job-runtime.mjs.
 * The git context collection + prompt building stay engine-specific.
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
import { runForeground, startBackground, projectJob } from "../lib/job-runtime.mjs";
import { waitForJob } from "../lib/shared/core/wait.mjs";
import { reconcileDeadPids } from "../lib/shared/core/reconcile.mjs";
import { outputCommandResult } from "../lib/render.mjs";

// A background --wait blocks on an explicit finite budget (shared waitForJob has
// no infinite mode). 15m mirrors the wait command's default.
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

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
  const json = Boolean(options.json);
  // Review is read-only only by INSTRUCTION: the prompt ("Do NOT modify files")
  // is the sole, best-effort lever — agy's headless --print mode has NO hard
  // write guard. --sandbox is OS terminal containment (nsjail) that DOES apply
  // headless, but it fences only shell commands (and the model can self-select
  // BypassSandbox), not file writes. The fine-grained permission deny/ask lists
  // did not block a write in --print either (verified live 1.1.2: a global
  // `deny: write_file(*)` still wrote). We still pass --sandbox for terminal
  // friction. Escape hatch: --no-sandbox.
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
  const conversationId = options.conversation ? String(options.conversation) : null;
  const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""}`;

  // M8: conversationId (?? null) flows into request so --continue/--conversation
  // resume survives the rewiring (the adapter reads only job.request.conversationId).
  const request = {
    scope: envelope.scope,
    base: base ?? null,
    mode,
    conversationId: conversationId ?? null,
    model,
    sandbox,
  };

  if (options.background) {
    const { stateDir, job } = startBackground({
      cwd: workspaceRoot,
      kind: "review",
      title,
      prompt,
      request,
    });
    const payload = {
      jobId: job.id,
      status: "queued",
      message: `Background review started. Run /antigravity:status ${job.id} to check progress.`,
    };
    outputCommandResult(
      payload,
      `Background review started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
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
    kind: "review",
    title,
    prompt,
    request,
  });

  if (finished.errorKind === "auth") {
    process.stderr.write(
      "\nantigravity:review — Antigravity is not authenticated.\n" +
        "Run /antigravity:setup to complete the OAuth flow, then retry.\n",
    );
    return 1;
  }
  if (finished.status !== "completed") {
    process.stderr.write(`\nantigravity:review — failed (${finished.status}).\n`);
    if (finished.error) process.stderr.write(finished.error);
    return finished.status === "cancelled" ? 2 : 1;
  }

  const payload = {
    scope: envelope.scope,
    review: finished.resultText,
  };
  outputCommandResult(payload, finished.resultText ?? "", json);
  return 0;
}

export default run;

runAsMain(import.meta.url, run, "review");
