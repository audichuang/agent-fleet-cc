/**
 * /antigravity:image — generate an image with agy's built-in generate_image
 * tool (Imagen under the hood) and recover the saved file path.
 *
 * Runs in the FOREGROUND only: image generation is a one-shot that returns a
 * path you want immediately, so there is no background/job-polling surface.
 *
 * Flags:
 *   --name <id>      ask agy to save the image under this name
 *   --output <path>  copy the generated file to this path
 *   --add-dir <path> additional workspace dir (repeatable)
 *   --json           emit JSON
 *   --cwd <path>     override working directory
 */

import { copyFileSync, existsSync } from "node:fs";

import { parseCommandInput } from "../lib/args.mjs";
import { runAsMain } from "../lib/cli-entry.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildImagePrompt } from "../lib/prompt-templates.mjs";
import { extractImagePath } from "../lib/image.mjs";
import { runForegroundJob } from "../lib/job-helpers.mjs";
import { outputCommandResult } from "../lib/render.mjs";

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["name", "output", "cwd", "add-dir", "model"],
    booleanOptions: ["json"],
  });

  const description = positionals.join(" ").trim();
  if (!description) {
    process.stderr.write(
      "antigravity:image — no description provided. Pass what you want drawn, e.g. /antigravity:image a red bicycle in the rain.\n",
    );
    return 1;
  }

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const name = options.name ? String(options.name) : undefined;
  const output = options.output ? String(options.output) : undefined;

  const addDirs = Array.isArray(options["add-dir"])
    ? options["add-dir"].map(String)
    : options["add-dir"]
    ? [String(options["add-dir"])]
    : [];

  const prompt = buildImagePrompt(description, { name });

  const { result } = await runForegroundJob({
    workspaceRoot,
    kind: "image",
    title: truncate(description, 80),
    prompt,
    addDirs,
    model: options.model ? String(options.model) : undefined,
    cwd: workspaceRoot,
    request: { addDirs, name: name ?? null, output: output ?? null },
    onStdout: (chunk) => process.stderr.write(chunk),
  });

  if (result.status === "auth_required") {
    process.stderr.write(
      "\nantigravity:image — not authenticated. Run /antigravity:setup, then retry.\n",
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
    process.stderr.write(`\nantigravity:image — failed (${result.status}).\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status === "cancelled" ? 2 : 1;
  }

  const { imagePath, source } = extractImagePath(result.stdout);

  let copiedTo = null;
  let warning = null;
  if (imagePath && existsSync(imagePath)) {
    if (output) {
      try {
        copyFileSync(imagePath, output);
        copiedTo = output;
      } catch (err) {
        warning = `could not copy to ${output}: ${err?.message ?? err}`;
      }
    }
  } else {
    warning =
      "agy did not return a usable IMAGE_PATH; the image may still have been saved — check agy's reply above.";
  }

  const payload = {
    imagePath: imagePath ?? null,
    source,
    copiedTo,
    warning,
    rawOutput: result.stdout,
  };

  const lines = [];
  if (imagePath) lines.push(`Generated: ${imagePath}`);
  if (copiedTo) lines.push(`Copied to: ${copiedTo}`);
  if (warning) lines.push(`Warning: ${warning}`);
  lines.push("");
  lines.push(result.stdout.trimEnd());
  outputCommandResult(payload, `${lines.join("\n")}\n`, Boolean(options.json));
  return 0;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runAsMain(import.meta.url, run, "image");
