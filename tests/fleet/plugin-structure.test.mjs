import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("fleet plugin.json has the minimal shape and agrees with the marketplace", () => {
  const plugin = readJson(
    path.join(REPO_ROOT, "plugins/fleet/.claude-plugin/plugin.json"),
  );
  assert.equal(plugin.name, "fleet");
  assert.equal(typeof plugin.version, "string");
  assert.ok(plugin.description && plugin.description.length > 0);

  const marketplace = readJson(
    path.join(REPO_ROOT, ".claude-plugin/marketplace.json"),
  );
  const entry = marketplace.plugins.find((p) => p.name === "fleet");
  assert.ok(entry, "fleet missing from marketplace");
  assert.equal(entry.source, "./plugins/fleet");
  assert.equal(entry.version, plugin.version);
});

test("fleet plugin ships setup/doctor/status commands and scripts", () => {
  for (const command of ["setup.md", "doctor.md", "status.md"]) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "plugins/fleet/commands", command)),
      `${command} missing`,
    );
  }
  for (const script of ["fleet-doctor.mjs", "fleet-status.mjs"]) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, "plugins/fleet/scripts", script)),
      `${script} missing`,
    );
  }
});

test("setup.md drives the GUIDE-ONLY flow per spec §6", () => {
  const text = fs.readFileSync(
    path.join(REPO_ROOT, "plugins/fleet/commands/setup.md"),
    "utf8",
  );
  assert.ok(text.startsWith("---"), "setup.md missing frontmatter");
  assert.match(text, /description:/, "missing description");
  // §6 frontmatter contract: both allowed-tools must be present.
  assert.match(text, /allowed-tools:.*Bash\(node:\*\)/, "must allow Bash(node:*)");
  assert.match(text, /AskUserQuestion/, "must use AskUserQuestion");
  // §4/§6.2 path convention: doctor invoked via ${CLAUDE_PLUGIN_ROOT}/scripts/...
  assert.match(
    text,
    /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/fleet-doctor\.mjs/,
    "must invoke fleet-doctor.mjs via ${CLAUDE_PLUGIN_ROOT}/scripts/",
  );
  assert.match(text, /fleet-doctor\.mjs/, "must reference fleet-doctor.mjs");
  assert.match(text, /--json/, "must invoke doctor with --json");
  assert.match(text, /--only/, "must invoke doctor with --only");
  // §6.1 HARD zero-selection guard: stop message + do-not-run-doctor + multi-select.
  assert.match(text, /nothing to set up/, "must carry the zero-selection stop message");
  assert.match(text, /multi-select/i, "must instruct a multi-select first question");
  assert.match(
    text,
    /do NOT (run|invoke)[^\n]*fleet-doctor/i,
    "must instruct NOT to run the doctor on zero selections",
  );
  // lists the three engines
  assert.match(text, /codex/);
  assert.match(text, /antigravity/);
  assert.match(text, /delegate/);
  // GUIDE-ONLY: routes each deep fix to the engine's OWN setup, run by the USER.
  assert.match(text, /\/codex:setup/);
  assert.match(text, /\/antigravity:setup/);
  assert.match(text, /\/delegate:setup/);
  // §6.3 plugin-not-installed fallback.
  assert.match(text, /\/plugin install <engine>@agent-fleet/);
  // §6.3 confirm-by-re-running guidance (single-line, backtick adjacent to "re-run ").
  assert.match(text, /re-run `\/fleet:setup`/);
  // §6.4 auth-not-verified note (even when allReady) — single physical line.
  assert.match(text, /auth was NOT verified/, "must state auth was not verified");
  // §6.4 delegate real-smoke hint uses the REAL slash command.
  assert.match(text, /\/delegate:task "hello" --profile/);
  // GUIDE-ONLY guardrail: must NOT promise to invoke /<engine>:setup itself or
  // consume its re-check output. Pin the absence of the old in-flow phrasings.
  assert.doesNotMatch(text, /rely on its re-check output/i);
  assert.doesNotMatch(text, /delegate-companion\.mjs/);
});

test("doctor.md and status.md are safe read-only CLI wrappers", () => {
  const doctor = fs.readFileSync(
    path.join(REPO_ROOT, "plugins/fleet/commands/doctor.md"),
    "utf8",
  );
  const status = fs.readFileSync(
    path.join(REPO_ROOT, "plugins/fleet/commands/status.md"),
    "utf8",
  );

  assert.match(doctor, /disable-model-invocation:\s*true/);
  assert.match(doctor, /!\`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/fleet-doctor\.mjs"`/);
  assert.doesNotMatch(doctor, /\$ARGUMENTS/);
  assert.doesNotMatch(doctor, /<<'/);
  assert.doesNotMatch(doctor, /--raw-args-stdin/);
  assert.match(doctor, /does not inject user-provided text into a shell command/i);
  assert.doesNotMatch(doctor, /!\`[^\n]*\$ARGUMENTS/);
  assert.match(doctor, /does not verify auth/i);
  assert.match(status, /disable-model-invocation:\s*true/);
  assert.match(status, /!\`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/fleet-status\.mjs"`/);
  assert.doesNotMatch(status, /\$ARGUMENTS/);
  assert.doesNotMatch(status, /<<'/);
  assert.doesNotMatch(status, /--raw-args-stdin/);
  assert.match(status, /does not inject user-provided text into a shell command/i);
  assert.doesNotMatch(status, /!\`[^\n]*\$ARGUMENTS/);
  assert.match(status, /compact CLI board/i);
  assert.match(status, /not a full TUI/i);
});
