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
  assert.match(source, /references\/prompting\.md/);
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
  // Was /Use exactly one `Bash` call/ — prose the body already contradicted two lines
  // later, where a multi-line prompt is told to go through a written `--prompt-file`.
  // The real invariant is one `task` run per handoff, not one Bash call.
  assert.match(agent, /one `task` run per rescue handoff/i);
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
  assert.match(agent, /references\/prompting\.md/);
  assert.match(agent, /to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that reference to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  // 1.6.2 deleted `codex-cli-runtime`; ~90% of it was already duplicated here, and
  // these are the invariants that were only in the skill. They govern a command line
  // the agent builds by hand, so losing one fails at runtime, not at edit time.
  assert.match(agent, /one `task` run per rescue handoff/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Never hardcode a cache\/versioned path/i, "the ${CLAUDE_PLUGIN_ROOT} path invariant");
  assert.match(agent, /pass `--prompt-file <path>`/i, "the empty-prompt trap");
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /Treat `--background` and `--wait` as Claude-side execution control only/i);
  assert.match(agent, /Strip them before calling `task`/i);
  // Every flag the companion accepts needs a rule, or the agent's "preserve the
  // user's task text as-is" makes it prompt text Codex reads as an instruction.
  assert.match(agent, /Treat a user-typed `--write` as a runtime control/i);
  assert.match(agent, /do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  // The standalone repo's root README stayed behind in codex-plugin-cc (it is
  // not part of the install payload); its doc-consistency assertions went with it.
});

test("result and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex/SKILL.md");

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
  const promptingSkill = read("skills/codex/references/prompting.md");
  const agent = read("agents/codex-rescue.md");

  assert.match(promptingSkill, /\|\s*\*\*gpt-5\.6-luna\*\*\s*\|/, "luna needs a row in the model table");
  assert.match(promptingSkill, /Luna always runs at `--effort max`/);
  assert.match(promptingSkill, /One ticket per run/);
  // 1.6.2 removed the price column. It was the exact thing root AGENTS.md forbids —
  // an enumerated engine catalog in shipped prose — and the guard it replaces proved
  // the point: it pinned one live price and one *stale* price as a doesNotMatch,
  // a fossil of the table having already rotted once. A reprint by OpenAI moved no
  // test, so the table could lie while the suite stayed green.
  //
  // Assert the absence, not a new set of numbers: any `$N / $N` pair here is the
  // rot returning. The routing capability the old assertions were really protecting
  // (luna's row, the max-effort pairing, one-ticket-per-run) is still pinned above.
  assert.doesNotMatch(
    promptingSkill,
    /\$\d[\d.]*\s*\/\s*\$\d/,
    "prices belong in OpenAI's pricing page, not in shipped prose — route by role instead"
  );
  assert.match(
    promptingSkill,
    /route by which job it is, not by price/i,
    "dropping the numbers only works if the file says what to route on instead"
  );

  assert.match(agent, /Ticket lane/);
  assert.match(agent, /--model gpt-5\.6-luna --effort max/);
  // Both halves of the lane need an exception in the forwarding rules, not just the
  // model half: an unqualified "leave `--effort` unset unless the user asks" outranks
  // the lane for a forwarder reading top-to-bottom, and luna without `max` is the
  // ~27-on-the-index model the lane exists to avoid.
  assert.match(agent, /Leave `--effort` unset unless[^\n]*Ticket lane/);
  assert.match(agent, /Leave model unset by default[^\n]*Ticket lane/);
  // The lane widens the charter so a ticket can reach Codex at all; it must not read
  // as an advert for the cheap route. Spawning this subagent costs the main thread
  // ~20K whatever the ticket's size, so a description selling "cheap" points the main
  // thread at the single most expensive path in delivery-paths.md.
  assert.match(agent, /instead of refusing as too simple/);
  assert.doesNotMatch(agent, /run cheaply/);
});

// Delivery-path choice is disclosed to a reference rather than carried in SKILL.md,
// because every codex-rescue spawn preloads SKILL.md in full and the forwarder can
// only ever execute one path. The pointer is what makes the reference reachable.
test("delivery-path reference is reachable and carries the fork trap", () => {
  const promptingSkill = read("skills/codex/references/prompting.md");
  const deliveryPaths = read("skills/codex/references/delivery-paths.md");

  assert.match(promptingSkill, /\(delivery-paths\.md\)/, "prompting.md must point at its sibling reference");
  assert.match(deliveryPaths, /`--resume-last`/);
  assert.match(deliveryPaths, /subagent_tokens: 20732/, "the measured cost is the whole argument");
  // #234 is cheap to reintroduce from the name alone; the reference has to say why not.
  assert.match(deliveryPaths, /context: fork/);
  assert.match(deliveryPaths, /no `Agent` tool/i);
  // A cost table is only actionable if it says which rows the reader can execute.
  // Cross-checked against the command itself so the claim cannot rot silently: if
  // `/codex:task` ever became model-invocable, this reference would be wrong.
  assert.match(read("commands/task.md"), /^disable-model-invocation:\s*true$/m);
  assert.match(deliveryPaths, /`\/codex:task` is `disable-model-invocation`/);
});

test("internal docs use task terminology for rescue runs", () => {
  const agent = read("agents/codex-rescue.md");
  const promptingSkill = read("skills/codex/references/prompting.md");
  const promptRecipes = read("skills/codex/references/codex-prompt-recipes.md");

  assert.match(agent, /codex-companion\.mjs" task \.\.\./);
  assert.match(agent, /This subagent only forwards to `task`/i);
  assert.match(agent, /--resume-last/i);
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

// Every surface that hands Codex's own output to the user must route through the
// `codex-result-handling` skill — it carries the stop-rule that review findings are
// never auto-fixed. The list is spelled out rather than inferred because the
// alternative (grepping bodies for "verbatim") guesses at prose and would pass on a
// file that dropped the pointer.
//
// `logs` and `attach` belong here even though they look like plumbing: the persisted
// log they stream ends with the job's `Final output`, so a review's findings reach the
// user through them too. `wait` and `status --wait` do NOT belong: they render
// `renderJobStatusReport` (job details and hints), while only `result` renders the
// stored output via `renderStoredJobResult`.
const RESULT_RELAYING_COMMANDS = [
  "adversarial-review",
  "attach",
  "execute-plan",
  "handoff",
  "logs",
  "rescue",
  "result",
  "review",
  "task",
];

// Naming the skill is what makes it load; the `Skill` grant is what keeps that from
// costing a permission prompt at the one moment the stop-rule has to arrive. Assert
// both — `allowed-tools` pre-approves, it does not gate availability, so the grant is
// an ergonomics fix and the reference is the functional one.
test("every command that relays Codex output routes through codex:codex", () => {
  for (const name of RESULT_RELAYING_COMMANDS) {
    const body = read(`commands/${name}.md`);
    assert.match(
      body,
      /`codex:codex` skill/,
      `commands/${name}.md relays Codex output but never names the codex:codex skill`
    );
    const allowed = /^allowed-tools: (.+)$/m.exec(body);
    assert.ok(allowed, `commands/${name}.md has no allowed-tools line`);
    assert.ok(
      allowed[1].split(",").map((t) => t.trim()).includes("Skill"),
      `commands/${name}.md names codex:codex but has no Skill pre-approval, so loading it will prompt`
    );
  }
});

// Round 2 asked for this; round 3 caught that it only covered `wait`. Slice each
// handler out of the companion and assert what it actually renders — `renderJobStatusReport`
// for the status surfaces, `renderStoredJobResult` for `result`. A change that makes a
// status surface relay the stored output goes red here instead of quietly escaping the
// relay set. The slicer must tolerate `async function`, or it runs past the handler it
// means to isolate and asserts on a neighbour.
function companionHandler(name) {
  const companion = fs.readFileSync(
    path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs"),
    "utf8"
  );
  const signature = new RegExp(`^(?:async )?function ${name}\\(`, "m");
  const opening = signature.exec(companion);
  assert.ok(opening, `${name} not found in codex-companion.mjs`);
  const rest = companion.slice(opening.index + opening[0].length);
  const next = /^(?:async )?function \w+\(/m.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

test("status surfaces render the status report, not the stored result", () => {
  for (const name of ["handleWait", "handleStatus"]) {
    const body = companionHandler(name);
    assert.match(body, /renderJobStatusReport|renderStatusPayload/, `${name} no longer renders a status report`);
    assert.doesNotMatch(
      body,
      /renderStoredJobResult/,
      `${name} now renders the stored result — that command relays Codex output and must join RESULT_RELAYING_COMMANDS`
    );
  }

  assert.match(
    companionHandler("handleResult"),
    /renderStoredJobResult/,
    "handleResult no longer renders the stored result"
  );

  for (const name of ["wait", "status"]) {
    assert.ok(
      !RESULT_RELAYING_COMMANDS.includes(name),
      `commands/${name}.md renders a status report, not the stored result`
    );
  }
});

// The rescue subagent presents nothing itself; the host does, and nothing declarable on
// the agent binds the host. Its one lever is the text it returns, so assert that the
// body still requires the contract line — checked in the body alone, because a match
// anywhere in the file could be satisfied by a `skills:` entry instead (round 3).
// The description is asserted to be a double-quoted scalar rather than checked against a
// hand-rolled YAML rule: an unquoted value can be broken by a `: `, a ` #`, or a leading
// `*`, and a guard that has to enumerate those fails in both directions. One safe
// representation has no grammar to get wrong.
test("codex-rescue keeps a quoted description and tells the host how to present its output", () => {
  const agent = read("agents/codex-rescue.md");
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(agent);
  assert.ok(parts, "agents/codex-rescue.md has no frontmatter");
  const [, frontmatter, body] = parts;

  const description = /^description: (.+)$/m.exec(frontmatter);
  assert.ok(description, "agents/codex-rescue.md has no description");
  assert.match(
    description[1],
    /^".*"$/,
    'the description must be a double-quoted scalar: an unquoted value containing ": " makes the whole frontmatter unparseable and Claude Code drops the agent silently'
  );

  assert.match(
    body,
    /`codex:codex` skill/,
    "the agent body must tell the host to present its output under the contract — the returned text is the only lever it has when the host invokes it directly"
  );
});

// 1.6.2 collapsed three skills into one. The count is the whole point of that
// change, and nothing else fails if a fourth reappears: skills are discovered by
// directory, so adding one is a `mkdir` with no import, no registration, and no
// other test to trip. The plugin also carries no manifest listing them, so this
// assertion is the only place the intended shape is written down.
//
// Each entry costs a permanently-loaded description in every session's skill list,
// which is why the budget is one. If a genuine second skill is ever needed, change
// the number here deliberately rather than letting it drift.
test("codex ships exactly one skill, whose references are all one hop from SKILL.md", () => {
  const skillsDir = path.join(PLUGIN_ROOT, "skills");
  const skills = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(skills, ["codex"], "codex is meant to expose exactly one skill");

  // The body is the hot path: nine commands load it to reach the stop-rule, so the
  // prompting material stays in references. A body that grew past ~80 lines would
  // mean that material had leaked back in and buried the rule again.
  const body = read("skills/codex/SKILL.md");
  assert.ok(
    body.split("\n").length < 80,
    "skills/codex/SKILL.md is the nine-command hot path — keep detail in references/"
  );

  // Every reference must be linked from SKILL.md, or it is two hops away and gets
  // skimmed at best. Checked both ways so neither a dangling link nor an orphaned
  // file passes.
  const linked = [...body.matchAll(/\]\(references\/([^)]+)\)/g)].map((m) => m[1]).sort();
  const onDisk = fs.readdirSync(path.join(skillsDir, "codex", "references")).sort();
  assert.deepEqual(linked, onDisk, "SKILL.md's reference table must match references/ exactly");
});
