import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  // The doc must be honest that the shell-backgrounded review is session-scoped, NOT the
  // durable watchdog-backed `/codex:task --background` job (E: run_in_background ≠ durable).
  assert.match(source, /runs the review in the FOREGROUND/i);
  assert.match(source, /session-scoped and best-effort/i);
  assert.match(source, /\/codex:task --background/);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  // Same honesty caveat as /codex:review (E: shell-background is session-scoped, not durable).
  assert.match(source, /runs the review in the FOREGROUND/i);
  assert.match(source, /session-scoped and best-effort/i);
  assert.match(source, /\/codex:task --background/);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "attach.md",
    "cancel.md",
    "execute-plan.md",
    "handoff.md",
    "logs.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "task.md",
    "wait.md"
  ]);
});

test("task wait and logs commands expose Codex companion runtime entrypoints", () => {
  const task = read("commands/task.md");
  const wait = read("commands/wait.md");
  const logs = read("commands/logs.md");

  assert.match(task, /disable-model-invocation:\s*true/);
  assert.match(task, /codex-companion\.mjs" task "\$ARGUMENTS"/);
  assert.match(task, /Return the command stdout verbatim/i);
  assert.match(task, /Do not paraphrase, summarize, rewrite, or add commentary/i);

  assert.match(wait, /disable-model-invocation:\s*true/);
  assert.match(wait, /argument-hint:\s*'<job-id>/);
  assert.match(wait, /codex-companion\.mjs" wait "\$ARGUMENTS"/);
  assert.match(wait, /requires a job id/i);
  assert.match(wait, /equivalent to `\/codex:status <job-id> --wait`/i);
  assert.match(wait, /Present the full command output to the user/i);
  assert.match(wait, /Do not paraphrase, summarize, rewrite, condense, or add commentary/i);

  assert.match(logs, /disable-model-invocation:\s*true/);
  assert.match(logs, /codex-companion\.mjs" logs "\$ARGUMENTS"/);
  assert.match(logs, /delegates to the existing attach implementation/i);
  assert.match(logs, /Preserve Codex native live log behavior/i);
  assert.match(logs, /Present the streamed log output to the user as-is/i);
  assert.match(logs, /Do not paraphrase, summarize, rewrite, condense, or add commentary/i);
});

test("handoff builds a GPT-5.6 prompt and sends it to Codex by default, with --print to only emit it", () => {
  const source = read("commands/handoff.md");
  assert.match(source, /argument-hint:/);
  assert.match(source, /allowed-tools:.*Skill/);
  assert.match(source, /allowed-tools:.*Bash\(node:\*\)/);
  assert.match(source, /gpt-5-6-prompting/);
  // Default behavior: send the built prompt to Codex via the companion task runner.
  assert.match(source, /codex-companion\.mjs" task --prompt-file/);
  // --print (or --prompt-only) emits the prompt without running Codex.
  assert.match(source, /--print/);
  assert.match(source, /```text/);
  // Mode A reflects on the session's work via git; Mode B builds for a given task.
  assert.match(source, /git --no-pager diff/);
  assert.match(source, /absolute paths/i);
  assert.match(source, /no arguments/i);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model>/);
  assert.doesNotMatch(rescue, /spark/i);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /Pass any explicit `--model` value through verbatim/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /Pass any explicit `--model` value through verbatim/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.doesNotMatch(agent, /spark/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  // #360: failures now print a structured {"status":"error",...} envelope on
  // stdout; the subagent must surface it rather than swallow the failure.
  assert.match(agent, /On failure the companion exits non-zero and prints a structured.*envelope on stdout\. Return that stdout as-is/i);
  assert.match(agent, /Only if there is genuinely no stdout at all .* return nothing/i);
  assert.match(agent, /gpt-5-6-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gpt-5-6-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Pass any explicit `--model` value through verbatim/i);
  assert.doesNotMatch(runtimeSkill, /spark/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  // The standalone repo's root README stayed behind in codex-plugin-cc (it is
  // not part of the install payload); its doc-consistency assertions went with it.
});

test("result and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

// The ticket lane is a routing capability that lives only in prose: the small-task
// route exists because these two files say it does. A silent edit dropping either
// half (the model/effort pairing, or the rescue agent's permission to take a ticket
// at all) removes the capability with no code change and no other failure.
test("gpt-5.6-luna is documented as the ticket lane, pinned to max effort", () => {
  const promptingSkill = read("skills/gpt-5-6-prompting/SKILL.md");
  const agent = read("agents/codex-rescue.md");

  assert.match(promptingSkill, /\|\s*\*\*gpt-5\.6-luna\*\*\s*\|/, "luna needs a row in the model table");
  assert.match(promptingSkill, /Luna always runs at `--effort max`/);
  assert.match(promptingSkill, /One ticket per run/);
  // Pre-cut prices would misprice every routing decision made from this table.
  assert.match(promptingSkill, /\$0\.20 \/ \$1\.20/, "luna's post-2026-07-30 price");
  assert.match(promptingSkill, /\$2\.00 \/ \$12\.00/, "terra's post-2026-07-30 price");
  assert.doesNotMatch(promptingSkill, /\$2\.50 \/ \$15\.00/, "stale pre-cut terra price");

  assert.match(agent, /Ticket lane/);
  assert.match(agent, /--model gpt-5\.6-luna --effort max/);
  // Both halves of the lane need an exception in the forwarding rules, not just the
  // model half: an unqualified "leave `--effort` unset unless the user asks" outranks
  // the lane for a forwarder reading top-to-bottom, and luna without `max` is the
  // ~27-on-the-index model the lane exists to avoid.
  assert.match(agent, /Leave `--effort` unset unless[^\n]*Ticket lane/);
  assert.match(agent, /Leave model unset by default[^\n]*Ticket lane/);
});

// Delivery-path choice is disclosed to a reference rather than carried in SKILL.md,
// because every codex-rescue spawn preloads SKILL.md in full and the forwarder can
// only ever execute one path. The pointer is what makes the reference reachable.
test("delivery-path reference is reachable and carries the fork trap", () => {
  const promptingSkill = read("skills/gpt-5-6-prompting/SKILL.md");
  const deliveryPaths = read("skills/gpt-5-6-prompting/references/delivery-paths.md");

  assert.match(promptingSkill, /references\/delivery-paths\.md/, "SKILL.md must point at the reference");
  assert.match(deliveryPaths, /`--resume-last`/);
  assert.match(deliveryPaths, /subagent_tokens: 20732/, "the measured cost is the whole argument");
  // #234 is cheap to reintroduce from the name alone; the reference has to say why not.
  assert.match(deliveryPaths, /context: fork/);
  assert.match(deliveryPaths, /no `Agent` tool/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-6-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-6-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  // README assertions removed with the standalone repo's root README (left behind).
});
