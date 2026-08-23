import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../plugins/grok");

test("plugin exposes the nine fleet commands (incl. the live-shell + image verbs)", () => {
  const cmds = fs.readdirSync(path.join(ROOT, "commands")).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(cmds, ["cancel.md", "image.md", "live.md", "logs.md", "result.md", "setup.md", "status.md", "task.md", "wait.md"]);
});

test("every command shells the grok companion", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "commands"))) {
    const body = fs.readFileSync(path.join(ROOT, "commands", f), "utf8");
    assert.match(body, /scripts\/grok-companion\.mjs/, `${f} must invoke the companion`);
  }
});

const frontmatter = (name) => {
  const body = fs.readFileSync(path.join(ROOT, "commands", `${name}.md`), "utf8");
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
};

test("delegation-entry verbs (task, live, image) are model-invocable; lifecycle/query verbs are user-run", () => {
  // The delegation-entry verbs (task, live, image) stay model-invocable so the commander
  // can reach for grok itself; the lifecycle/query verbs are gated to user-run so
  // the model cannot auto-fire them (matches codex/antigravity). The watch loop
  // still drives wait/status by shelling the companion, which the flag does not block.
  const gated = ["cancel", "logs", "result", "setup", "status", "wait"];
  for (const name of gated) {
    assert.match(
      frontmatter(name),
      /^disable-model-invocation:\s*true\s*$/m,
      `${name} must be user-run (disable-model-invocation: true)`,
    );
  }
  for (const name of ["task", "live", "image"]) {
    assert.doesNotMatch(
      frontmatter(name),
      /disable-model-invocation/,
      `${name} must stay model-invocable`,
    );
  }
});

test("live is a run_in_background live shell over task --live, with a path guard", () => {
  const body = fs.readFileSync(path.join(ROOT, "commands", "live.md"), "utf8");
  // launched inside a Claude Code background shell (parity with codex handoff --background)
  assert.match(body, /run_in_background/, "live must launch via run_in_background");
  // the ACTUAL launch command drives task --live from the inline-substituted plugin
  // root — never a hardcoded versioned cache path (the guard's negative example may
  // still name a cache path in prose, so scope the check to the launch line).
  const launch = body.split("\n").find((l) => /grok-companion\.mjs.*task --live/.test(l));
  assert.ok(launch, "live must shell `grok-companion.mjs ... task --live`");
  assert.match(launch, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/grok-companion\.mjs/);
  assert.doesNotMatch(launch, /cache\//, "the launch command must not hardcode a cache path");
  // the guard prose survives substitution and warns against reconstructing the path
  assert.match(body, /verbatim|exact string|as shown/i, "live must tell the model to copy the path verbatim");
});

test("live's path guard survives ${CLAUDE_PLUGIN_ROOT} substitution without contradicting itself", () => {
  const src = fs.readFileSync(path.join(ROOT, "commands", "live.md"), "utf8");
  // Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} inline BEFORE the model reads the
  // command body — and it expands to a versioned cache path. Simulate that and
  // assert the guard still makes sense (this is exactly what a source-only test misses).
  const FAKE_ROOT = "/home/u/.claude/plugins/cache/agent-fleet/grok/9.9.9";
  const rendered = src.split("${CLAUDE_PLUGIN_ROOT}").join(FAKE_ROOT);
  // no unexpanded placeholder may remain anywhere in what the model actually reads
  assert.doesNotMatch(rendered, /\$\{CLAUDE_PLUGIN_ROOT\}/, "every ${CLAUDE_PLUGIN_ROOT} must substitute away");
  // the launch command resolves to the concrete path
  const launch = rendered.split("\n").find((l) => /grok-companion\.mjs.*task --live/.test(l));
  assert.ok(launch && launch.includes(`${FAKE_ROOT}/scripts/grok-companion.mjs`), "launch line must resolve to the concrete path");
  // the guard must NOT prohibit the very (concrete) path it just told the model to
  // copy — the self-erasing/contradicting warning that this test exists to catch
  for (const line of rendered.split("\n")) {
    if (/\b(never|do not|don't)\b/i.test(line)) {
      assert.ok(!line.includes(FAKE_ROOT), `guard contradicts itself — prohibits the concrete path it told the model to copy:\n${line}`);
    }
  }
  // the version-drift warning uses a placeholder token that survives substitution
  assert.match(rendered, /<version>/, "guard must still warn against reconstructing the <version> segment");
});

test("CLI entry drains stdio via process.exitCode, never process.exit() (F1: no pipe truncation)", () => {
  // process.exit() drops buffered pipe writes on exit — under run_in_background
  // stdout/stderr are pipes, so a large --live stream or result would lose its tail
  // (incl. the terminal event). The entry must set process.exitCode and let stdio
  // drain naturally. This is a structural guard: the truncation itself can't be
  // reproduced hermetically (an eager reader drains the pipe before exit).
  const body = fs.readFileSync(path.join(ROOT, "scripts", "grok-companion.mjs"), "utf8");
  // strip line comments so the anti-pattern check sees CODE, not the explanation of it
  const entry = body
    .slice(body.indexOf("isCliEntry"))
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.match(entry, /process\.exitCode\s*=/, "CLI entry must set process.exitCode");
  assert.doesNotMatch(entry, /process\.exit\(/, "CLI entry must NOT call process.exit() (truncates buffered pipe output)");
  // and it must tolerate a consumer that closes the pipe early (EPIPE) instead of crashing
  assert.match(entry, /EPIPE/, "CLI entry must swallow EPIPE so a closed consumer isn't a false failure");
});

test("bin launcher is executable", () => {
  const st = fs.statSync(path.join(ROOT, "bin", "grok-companion"));
  assert.ok(st.mode & 0o111, "bin/grok-companion must be executable");
});
