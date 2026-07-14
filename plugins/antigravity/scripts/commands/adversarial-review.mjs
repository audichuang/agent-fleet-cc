/**
 * /antigravity:adversarial-review — a stricter, structured review.
 *
 * Asks agy to return a JSON review, parses it, and renders it structurally.
 * Falls back to the raw text if agy does not return parseable JSON. Read-only
 * is enforced by the PROMPT ("Do NOT modify files"); --sandbox only fences the
 * terminal, it does not block file writes (see review.mjs / AGENTS.md 踩雷).
 *
 * Runs on the shared runtime (Phase 4e): runForeground drives the shared worker
 * lifecycle; the launch seam lives in lib/job-runtime.mjs. The prompt building
 * + JSON parse/render stay engine-specific.
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildAdversarialReviewPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runForeground } from "../lib/job-runtime.mjs";
import { outputCommandResult, renderReviewResult, parseReviewJson } from "../lib/render.mjs";

export async function run(argv = [], ctx = {}) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "cwd", "model"],
    booleanOptions: ["json", "no-sandbox"],
  });

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scope = options.scope ? String(options.scope) : "auto";
  const base = options.base ? String(options.base) : undefined;
  const model = options.model ? String(options.model) : undefined;
  const json = Boolean(options.json);
  const sandbox = !options["no-sandbox"]; // terminal containment on by default (read-only comes from the prompt)

  let envelope;
  try {
    envelope = collectReviewContext(workspaceRoot, { scope, base });
  } catch (err) {
    process.stderr.write(`antigravity:adversarial-review — ${err?.message ?? err}\n`);
    return 1;
  }

  if (!envelope.context.diff || envelope.context.diff.trim() === "") {
    process.stdout.write("antigravity:adversarial-review — no changes to review.\n");
    return 0;
  }

  const prompt = buildAdversarialReviewPrompt(envelope);
  const title = `adversarial-review: ${envelope.scope}${base ? ` vs ${base}` : ""}`;

  // M8: conversationId (?? null) flows into request even though this command has
  // no resume flag — keeps the 5 launch commands consistent (the adapter reads
  // only job.request.conversationId).
  const request = {
    scope: envelope.scope,
    base: base ?? null,
    conversationId: null,
    model,
    sandbox,
  };

  const { job: finished } = await runForeground({
    cwd: workspaceRoot,
    kind: "adversarial-review",
    title,
    prompt,
    request,
  });

  if (finished.errorKind === "auth") {
    process.stderr.write(
      "\nantigravity:adversarial-review — Antigravity is not authenticated.\nRun /antigravity:setup to complete the OAuth flow, then retry.\n",
    );
    return 1;
  }
  if (finished.status !== "completed") {
    process.stderr.write(`\nantigravity:adversarial-review — failed (${finished.status}).\n`);
    if (finished.error) process.stderr.write(finished.error);
    return finished.status === "cancelled" ? 2 : 1;
  }

  const rawOutput = finished.resultText ?? "";
  const review = parseReviewJson(rawOutput);
  if (review) {
    const rendered = renderReviewResult(review);
    outputCommandResult({ scope: envelope.scope, review }, rendered, json);
    return 0;
  }

  // agy did not return parseable JSON — surface the raw text rather than fail.
  process.stderr.write(
    "antigravity:adversarial-review — could not parse a structured JSON review; showing agy's raw output.\n",
  );
  outputCommandResult({ scope: envelope.scope, raw: rawOutput }, rawOutput, json);
  return 0;
}

export default run;

runAsMain(import.meta.url, run, "adversarial-review");
