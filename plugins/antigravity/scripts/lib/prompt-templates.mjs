/**
 * Inline prompt templates for the antigravity-plugin commands.
 *
 * Kept inline (rather than in disk-loaded /prompts files) for v0.1.0 so the
 * plugin remains self-contained and so the templates can grow function-style
 * helpers without an extra interpolation layer.
 *
 * agy's print mode has no ACP, no streaming, no structured-output schema. Every
 * template here is plain natural language that produces a textual response.
 */

const MAX_DIFF_BYTES = 196 * 1024;

function trimDiff(diff) {
  if (typeof diff !== "string" || diff.length <= MAX_DIFF_BYTES) return diff ?? "";
  const head = diff.slice(0, MAX_DIFF_BYTES);
  const dropped = diff.length - MAX_DIFF_BYTES;
  return `${head}\n\n[... ${dropped} more diff bytes truncated for prompt size ...]`;
}

/**
 * Build the review prompt for `/antigravity:review`.
 *
 * @param {{ scope: string, context: any }} contextEnvelope - Return value from collectReviewContext.
 * @returns {string}
 */
export function buildReviewPrompt(contextEnvelope) {
  const { scope, context } = contextEnvelope;
  const lines = [];
  lines.push("You are reviewing a code change. Your output is read-only.");
  lines.push("Do NOT propose tool calls, do NOT modify files, do NOT ask follow-ups.");
  lines.push("");
  lines.push(`Scope: ${scope}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(context.summary ?? "(no summary)");
  lines.push("");

  if (scope === "branch") {
    lines.push("## Commits");
    lines.push("```");
    lines.push((context.commits ?? "").trim() || "(no commits)");
    lines.push("```");
    lines.push("");
  }

  lines.push("## Diff");
  lines.push("```diff");
  lines.push(trimDiff(context.diff));
  lines.push("```");

  if (scope !== "branch" && context.untrackedContents && context.untrackedContents.length > 0) {
    lines.push("");
    lines.push("## Untracked files (first 24 KB each)");
    for (const file of context.untrackedContents) {
      lines.push("");
      lines.push(`### ${file.path}`);
      lines.push("```");
      lines.push(file.content ?? "(binary or unreadable)");
      lines.push("```");
    }
  }

  lines.push("");
  lines.push("## Output");
  lines.push("Produce a Markdown review with the following sections:");
  lines.push("- **Verdict** (one line: APPROVE | CHANGES REQUESTED | NEEDS DISCUSSION)");
  lines.push("- **Summary** (2-3 sentences on overall change quality)");
  lines.push("- **Findings** (bulleted; for each include severity [critical|high|medium|low|nit], file:line, description, recommendation)");
  lines.push("- **Next Steps** (bulleted; concrete actions for the author)");
  lines.push("");
  lines.push("Be concise. Skip findings if the change is trivial. Do not suggest follow-up tool calls.");
  return lines.join("\n");
}

/**
 * Build the adversarial-review prompt for `/antigravity:adversarial-review`.
 *
 * Unlike the free-form review, this asks agy to return a STRICT JSON object so
 * the result can be rendered structurally (renderReviewResult). The output is
 * read-only — agy runs under --sandbox and must not propose edits.
 *
 * @param {{ scope: string, context: any }} contextEnvelope
 * @returns {string}
 */
export function buildAdversarialReviewPrompt(contextEnvelope) {
  const { scope, context } = contextEnvelope;
  const lines = [];
  lines.push("You are a skeptical senior engineer doing an adversarial code review. Your output is READ-ONLY.");
  lines.push("Do NOT modify files, do NOT propose tool calls, do NOT ask follow-up questions.");
  lines.push("Hunt for real defects: bugs, contract violations, race conditions, security issues, and maintainability problems. Do not pad with style nits.");
  lines.push("");
  lines.push(`Scope: ${scope}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(context.summary ?? "(no summary)");
  if (scope === "branch") {
    lines.push("");
    lines.push("## Commits");
    lines.push("```");
    lines.push((context.commits ?? "").trim() || "(no commits)");
    lines.push("```");
  }
  lines.push("");
  lines.push("## Diff");
  lines.push("```diff");
  lines.push(trimDiff(context.diff));
  lines.push("```");
  lines.push("");
  lines.push("## Output — STRICT JSON ONLY");
  lines.push("Reply with a SINGLE JSON object and nothing else (no prose, no markdown fence). Schema:");
  lines.push("{");
  lines.push('  "verdict": "approve" | "changes_requested" | "needs_attention",');
  lines.push('  "summary": "2-3 sentence overall assessment",');
  lines.push('  "findings": [');
  lines.push('    {');
  lines.push('      "severity": "critical" | "high" | "medium" | "low",');
  lines.push('      "title": "short title",');
  lines.push('      "body": "what is wrong and why it matters",');
  lines.push('      "file": "relative/path",');
  lines.push('      "line_start": 0, "line_end": 0,');
  lines.push('      "confidence": 0.0,');
  lines.push('      "recommendation": "concrete fix"');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "next_steps": ["concrete action", "..."]');
  lines.push("}");
  lines.push("Use an empty findings array if the change is clean. confidence is 0..1.");
  return lines.join("\n");
}

/**
 * Build the rescue prompt — passes the user prompt through verbatim with a
 * lightweight system preamble. agy already has its own system prompt; we add
 * just enough to set the tone.
 *
 * @param {string} userPrompt
 * @returns {string}
 */
export function buildRescuePrompt(userPrompt) {
  return userPrompt;
}

/**
 * Build the task prompt. Same shape as rescue — agy handles the rest.
 *
 * @param {string} userPrompt
 * @returns {string}
 */
export function buildTaskPrompt(userPrompt) {
  return userPrompt;
}

/**
 * Build the image-generation prompt for `/antigravity:image`.
 *
 * agy `--print` only returns natural-language text, so we ask the model to use
 * its built-in `generate_image` tool and then end its reply with a single
 * `IMAGE_PATH:` marker line that extractImagePath() recovers.
 *
 * @param {string} description - What to draw.
 * @param {{ name?: string }} [opts]
 * @returns {string}
 */
export function buildImagePrompt(description, { name } = {}) {
  const nameClause = name ? ` Save the image with name "${name}".` : "";
  const lines = [];
  lines.push(`Use your built-in generate_image tool to create the following image. Description: ${description}.${nameClause}`);
  lines.push("");
  lines.push("After the tool returns, you MUST end your reply with a single line in this exact format (no quotes, no markdown, nothing after it):");
  lines.push("IMAGE_PATH: <absolute filesystem path to the saved image>");
  lines.push("");
  lines.push("The IMAGE_PATH line is required — the calling wrapper parses it to locate the file.");
  return lines.join("\n");
}
