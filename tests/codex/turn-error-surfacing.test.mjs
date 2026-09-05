import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import "./helpers.mjs"; // hermetic env isolation (side-effect import)
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { resolveJobFile } from "../../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { describeTurnError } from "../../plugins/codex/scripts/lib/codex.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");

// Drive the REAL companion CLI against a fake codex whose turn/review/start ACKs
// then emits a terminal `error` notification — the production silent-death path.
// A pre-fix companion emitted status:1 with an empty result and no errorMessage.
function commitInitial(repo) {
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

// The observed silent-death shape: the app-server delivered the HTTP-400
// model-unavailable error with `.message` being a JSON-encoded envelope, so the
// human text was buried one JSON level deep.
const ENVELOPE_400 = {
  message: JSON.stringify({
    type: "error",
    status: 400,
    error: {
      type: "invalid_request_error",
      message: "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
    }
  })
};

test("describeTurnError unwraps the JSON-encoded app-server error envelope", () => {
  assert.equal(
    describeTurnError(ENVELOPE_400),
    "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
  );
});

test("describeTurnError reads a directly-nested { error: { message } } envelope", () => {
  assert.equal(
    describeTurnError({ error: { message: "401 Unauthorized" } }),
    "401 Unauthorized"
  );
});

test("describeTurnError passes a plain message through verbatim", () => {
  assert.equal(describeTurnError({ message: "permanent auth failure" }), "permanent auth failure");
});

test("describeTurnError falls back to stderr, then null", () => {
  assert.equal(describeTurnError(null, "  boom on stderr  "), "boom on stderr");
  assert.equal(describeTurnError(null, ""), null);
  assert.equal(describeTurnError(undefined), null);
});

test("describeTurnError never throws on a malformed error object", () => {
  assert.doesNotThrow(() => describeTurnError({ message: "{not valid json" }));
  // A non-JSON-looking message is returned as-is even though it starts oddly.
  assert.equal(describeTurnError({ message: "{not valid json" }), "{not valid json");
});

// The v2 `TurnError` carries `codexErrorInfo` + `additionalDetails` alongside
// `message`; both were being dropped, so a delegating commander reading --json got
// prose only. Tag the code and keep the details.
test("describeTurnError surfaces the structured codexErrorInfo code", () => {
  assert.equal(
    describeTurnError({ message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" }),
    "Usage limit reached [usageLimitExceeded]"
  );
});

test("describeTurnError reads the tag from an object-form codexErrorInfo", () => {
  assert.equal(
    describeTurnError({ message: "stream died", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }),
    "stream died [httpConnectionFailed]"
  );
});

test("describeTurnError appends additionalDetails without duplicating it", () => {
  assert.equal(
    describeTurnError({ message: "Bad request", additionalDetails: "model gpt-5.6-sol is gated" }),
    "Bad request — model gpt-5.6-sol is gated"
  );
  // Already contained in the message → no duplicate tail.
  assert.equal(
    describeTurnError({ message: "Bad request: it is gated", additionalDetails: "it is gated" }),
    "Bad request: it is gated"
  );
});

test("describeTurnError annotates a stderr-only failure too, and ignores malformed error info", () => {
  assert.equal(describeTurnError({ codexErrorInfo: "unauthorized" }, "boom"), "boom [unauthorized]");
  for (const codexErrorInfo of [null, "", "   ", [], 7, {}]) {
    assert.equal(describeTurnError({ message: "plain", codexErrorInfo }), "plain");
  }
});

test("runTrackedJob persists errorMessage when the runner RETURNS a failed execution (turn-error path)", async () => {
  // This is the silent-death regression: a turn ended by an `error` notification
  // makes the runner RETURN { exitStatus: 1 } (it does not throw). Before the fix,
  // the success-return finalize wrote result/rendered but NO errorMessage, so
  // /codex:status + --json showed a bare "failed". Assert the reason is persisted.
  const workspace = makeTempDir();
  const jobId = "job-returned-failed";
  const reason = describeTurnError(ENVELOPE_400);

  const execution = await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({
      exitStatus: 1,
      threadId: "th-x",
      turnId: "tn-x",
      payload: { status: 1, rawOutput: "", touchedFiles: [], reasoningSummary: [] },
      rendered: "boom\n",
      errorMessage: reason,
      summary: reason
    }),
    {}
  );

  assert.equal(execution.exitStatus, 1);
  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.errorMessage, reason, "a failed RETURN must persist errorMessage onto the job record");
});

test("runTrackedJob falls back to summary when a failed execution carries no explicit errorMessage", async () => {
  const workspace = makeTempDir();
  const jobId = "job-returned-failed-summaryonly";

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({
      exitStatus: 1,
      payload: { status: 1, rawOutput: "" },
      rendered: "boom\n",
      summary: "something went wrong"
    }),
    {}
  );

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.errorMessage, "something went wrong");
});

test("runTrackedJob does NOT set errorMessage on a completed job", async () => {
  const workspace = makeTempDir();
  const jobId = "job-returned-ok";

  await runTrackedJob(
    { id: jobId, workspaceRoot: workspace },
    async () => ({
      exitStatus: 0,
      payload: { status: 0, rawOutput: "the answer" },
      rendered: "the answer\n",
      summary: "the answer"
    }),
    {}
  );

  const record = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(record.status, "completed");
  assert.equal(record.errorMessage ?? null, null, "a completed job must not carry an errorMessage");
});

test("e2e: foreground `task --json` surfaces the failure reason on a terminal turn error", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0, "a terminal turn error must exit non-zero");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);
  // The whole point: the foreground --json payload (not only the persisted record)
  // must carry the unwrapped reason, not { status:1, rawOutput:"" }.
  assert.match(
    payload.errorMessage ?? "",
    /newer version of Codex/,
    "foreground task --json must surface the failure reason"
  );
});

test("e2e: foreground `review --json` surfaces the failure reason (native review branch)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(
    payload.errorMessage ?? "",
    /newer version of Codex/,
    "native review --json must surface the failure reason, not a success-sounding summary"
  );
});

test("e2e: foreground `adversarial-review --json` surfaces the failure reason", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.errorMessage ?? "", /newer version of Codex/);
});

// Second failure shape (Codex second-pass finding): the turn fails via a terminal
// turn/completed carrying turn.error, with NO preceding standalone `error`
// notification, so state.error stays null. failureReasonFor must still surface the
// real reason from result.turn.error rather than the generic fallback.
test("e2e: `task --json` surfaces turn.error from a failed turn/completed (no error notification)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-completed-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(
    payload.errorMessage ?? "",
    /401 Unauthorized/,
    "the failure reason from turn.error must not be lost to the generic fallback"
  );
});

test("e2e: `review --json` surfaces turn.error from a failed turn/completed (no error notification)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-completed-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.errorMessage ?? "", /401 Unauthorized/);
});

// The failure header is stated in full only when the reason ADDS something to the body.
// When the turn produced no agent message, resolveFinalMessage falls back to the turn
// error text, so rawOutput usually is the reason and a full header says it twice. These
// run the real companion CLI, so they pin the whole path, not just the render.
//
// (1.6.0 wrote this conditional as `result.hadAgentMessage` in executeTaskRun; 1.6.2
// replaced it with a comparison of the reason against the body, because the flag was a
// proxy for that question and got it wrong in both directions. There is no longer a
// flag to pin — the behaviour is entirely in renderTaskResult.)
//
// THE PAIR IS ONE TEST EACH FOR THE TWO HALVES — do not "simplify" either away:
//   - "WITH a partial answer" pins that the header EXISTS (no-header code reds it). It
//     cannot pin the conditional: unconditional prefixing also passes it, because a
//     partial answer is exactly the case where the header is wanted either way.
//   - "with NO agent message" pins that the header is CONDITIONAL (unconditional
//     prefixing doubles the reason and reds it). It is the only test that can.
test("e2e: a failed turn WITH a partial answer prefixes the reason above it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "partial-then-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /^Codex turn failed: /);
  assert.ok(
    result.stdout.indexOf("newer version of Codex") < result.stdout.indexOf("Here is what I found so far."),
    "the reason must sit above the partial answer, or a verbatim paste hides the failure"
  );
});

test("e2e: a failed turn with NO agent message states the reason exactly once", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-completed-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.equal(
    (result.stdout.match(/401 Unauthorized/g) ?? []).length,
    1,
    "the failure reason must be stated once, not as a header ON TOP of the identical body"
  );
  assert.doesNotMatch(result.stdout, /Codex turn failed: Codex turn failed/);
});

// The pair above both run on TURN_COMPLETED_ERROR, whose text carries the plugin's own
// "Codex turn failed: " prefix baked into the FIXTURE. That makes them blind to the
// question they look like they answer: swap in a realistic bare reason and they still
// pass, because the marker they match was never produced by the render. The two below
// drive shapes with no marker of their own, so the render is the only source.
//
// Both assert on STDOUT specifically. The --json payload and /codex:result have carried
// the failure correctly since 1.6.0; the hole was only ever in the two renders the slash
// commands actually print, and `commands/task.md` relays that stdout verbatim.
test("e2e: a bare turn.error message still renders as a failure", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "bare-turn-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout,
    /Codex turn failed/,
    "the message carries no marker of its own, so without a render-side one stdout reads as an answer"
  );
  assert.match(result.stdout, /401 Unauthorized/);
  // Exactly once — but only because this shape is UNDECORATED. See the decorated twin
  // below for what happens when the wire adds a code, which is the common case.
  assert.equal((result.stdout.match(/401 Unauthorized/g) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /Codex turn failed: Codex turn failed/);
});

// The containment check in renderTaskResult asks "does the body contain the reason?",
// but `describeTurnError` decorates the reason with a ` [codexErrorInfo]` tag the body
// does not have, so on the shape the real wire mostly produces the check MISSES and the
// message is stated twice — once decorated in the header, once bare in the body.
//
// That ceiling is deliberate and pre-dates this branch: `renderStoredJobResult` carries
// the same `ponytail:` note and the same reasoning, that a fuzzier compare would risk
// swallowing a genuinely distinct reason to save a readable near-repeat. This test is
// here so the ceiling is a recorded decision rather than a surprise, and so that anyone
// who does tighten the comparison sees exactly which output changes.
test("e2e: a decorated turn.error near-duplicates, and that ceiling is deliberate", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "decorated-turn-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  // What actually matters and must never regress: the failure is marked, the code
  // survives to the user, and the literal doubled PREFIX from 1.6.0 stays gone.
  assert.match(result.stdout, /^Codex turn failed: /);
  assert.match(result.stdout, /\[unauthorized\]/, "the machine-readable code must reach the user");
  assert.doesNotMatch(result.stdout, /Codex turn failed: Codex turn failed/);
  // The accepted ceiling, asserted so a future tightening is a visible test change and
  // not a silent one. If you make the comparison decoration-aware, this becomes 1.
  assert.equal(
    (result.stdout.match(/401 Unauthorized/g) ?? []).length,
    2,
    "decorated reason above, bare body below — see the ponytail: note in render.mjs"
  );
});

test("e2e: a failed turn with no output and no error text names the failure on stdout", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interrupted-no-error");
  initGitRepo(repo);
  commitInitial(repo);

  const result = run("node", [SCRIPT, "task", "do the thing"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  // The defect: with no rawOutput the render fell through to `failureMessage`, which is
  // "" on the broker transport, and printed this instead — a dead turn reading as a
  // model that simply had nothing to say. failureReasonFor always has a reason here.
  assert.doesNotMatch(
    result.stdout,
    /Codex did not return a final message/,
    "an interrupted turn is a failure, not a quiet success"
  );
  assert.match(result.stdout, /Codex turn failed/);
  assert.match(result.stdout, /reported no error detail/, "failureReasonFor's fallback must reach stdout");
});

// The OTHER failure shape (a standalone `error` notification with no turn/completed —
// the "terminal-error" fixture) used to reach no header at all: resolveFinalMessage has
// no finalTurn to read, so rawOutput is empty and renderTaskResult fell through to its
// failureMessage fallback, printing result.error.message unmarked. 1.6.2 gave the
// empty-output branch the reason too, so it IS marked now — see "a failed turn with no
// output and no error text", which drives the extreme version of this shape (no error
// text anywhere) and is the one that reds if that branch regresses.
//
// Nothing can DOUBLE there, though: with rawOutput empty there is no body to repeat
// against, so this shape cannot pin the conditional. The doubling needs turn.error,
// which is what the pair above drives.

// Same failure-hiding defect, one function over: BOTH review renders printed a
// non-empty body without consulting the failed status. The sequence is upstream-real,
// not a race — ReviewTask emits exit_review_mode (the item carrying the review text)
// before the terminal event (codex-rs/core/src/tasks/review.rs:87) while the turn's
// status is computed from the error recorded by the END of the turn
// (handle_turn_complete, codex-rs/app-server/src/bespoke_event_handling.rs), both at
// upstream 99660ab3c7. The "output-then-turn-error" fixture sends no `error`
// notification, so the client's terminal-error arm never fires: the render is the only
// place the failure can surface.
test("e2e: a failed native review does not render its captured review text as a finished review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "output-then-turn-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Codex review failed: .*401 Unauthorized/);
  assert.ok(
    result.stdout.indexOf("Codex review failed") < result.stdout.indexOf("No material issues found."),
    "the failure must sit above the review text, or a verbatim paste reads as a clean review"
  );
});

// The conditional half of the adversarial gate, exactly as on the task path: with NO
// agent message, finalMessage IS the error text, so the parse-error branch already
// prints it under "Raw final message:" and a header would say it twice. (The test below
// pins the other half: that the header exists at all.)
test("e2e: a failed adversarial review with NO agent message states the reason exactly once", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "turn-completed-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  // A count alone cannot see this: the fixture already puts the reason in the raw body,
  // so deleting the render's marker entirely still leaves exactly one occurrence and the
  // count passes. Assert the marker exists and sits above the body, THEN that the reason
  // is not restated — the three together are what pin "marked, once, in that order".
  assert.match(result.stdout, /Codex review failed/, "the marker must exist at all");
  assert.ok(
    result.stdout.indexOf("Codex review failed") < result.stdout.lastIndexOf("401 Unauthorized"),
    "the marker must sit above the body, or a verbatim paste reads as a clean review"
  );
  assert.equal(
    (result.stdout.match(/401 Unauthorized/g) ?? []).length,
    1,
    "the reason must not be repeated as a header on top of the body that already is it"
  );
});

test("e2e: a failed adversarial review does not render its valid verdict as a finished review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "output-then-turn-error");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Codex review failed: .*401 Unauthorized/);
  assert.ok(
    result.stdout.indexOf("Codex review failed") < result.stdout.indexOf("Verdict:"),
    "the failure must sit above the verdict it came with"
  );
});
