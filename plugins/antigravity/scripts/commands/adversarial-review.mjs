/**
 * /antigravity:adversarial-review — a stricter, structured review.
 *
 * Asks agy (read-only, under --sandbox) to return a JSON review, parses it, and
 * renders it structurally. Falls back to the raw text if agy does not return
 * parseable JSON.
 */

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildAdversarialReviewPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runForegroundJob } from "../lib/job-helpers.mjs";
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
  const sandbox = !options["no-sandbox"]; // read-only by default

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

  const { result } = await runForegroundJob({
    workspaceRoot,
    kind: "adversarial-review",
    title,
    prompt,
    model,
    sandbox,
    cwd: workspaceRoot,
    request: { scope: envelope.scope, base: base ?? null, model, sandbox },
    onStdout: (chunk) => process.stderr.write(chunk),
  });

  if (result.status === "auth_required") {
    process.stderr.write(
      "\nantigravity:adversarial-review — Antigravity is not authenticated. Run /antigravity:setup, then retry.\n",
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
    process.stderr.write(`\nantigravity:adversarial-review — failed (${result.status}).\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status === "cancelled" ? 2 : 1;
  }

  const review = parseReviewJson(result.stdout);
  if (review) {
    const rendered = renderReviewResult(review);
    outputCommandResult({ scope: envelope.scope, review }, rendered, Boolean(options.json));
    return 0;
  }

  // agy did not return parseable JSON — surface the raw text rather than fail.
  process.stderr.write(
    "antigravity:adversarial-review — could not parse a structured JSON review; showing agy's raw output.\n",
  );
  outputCommandResult({ scope: envelope.scope, raw: result.stdout }, result.stdout, Boolean(options.json));
  return 0;
}

export default run;

runAsMain(import.meta.url, run, "adversarial-review");
