import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "skills", "codex", "scripts", "codex-companion.mjs");

// Review focus text used to have only one way in: argv. Callers wrote paragraphs of it,
// often CJK and full of code spans, and on 2026-10-21 a double-quoted focus holding
// `|| h < 400.` in backticks was run by the shell as a command — no job launched.
// --focus-file reads the focus the way task's --prompt-file reads a prompt.
function dirtyRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  return repo;
}

test("adversarial-review --focus-file sends the file's text as the focus, byte for byte", () => {
  const repo = dirtyRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const focus = "重點檢查 `|| h < 400.` 這行：\n$(rm -rf /) 與 \"quotes\" 都只是文字。\n";
  const focusFile = path.join(makeTempDir(), "focus.md");
  fs.writeFileSync(focusFile, focus);

  const result = run("node", [SCRIPT, "adversarial-review", "--focus-file", focusFile], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(fakeState.lastTurnStart.prompt.includes(focus.trim()), "the focus reaches Codex unchanged");
});

test("adversarial-review refuses --focus-file together with inline focus text", () => {
  const repo = makeTempDir(); // the option check fails before any repo is read
  const focusFile = path.join(makeTempDir(), "focus.md");
  fs.writeFileSync(focusFile, "from the file\n");
  const result = spawnSync(process.execPath, [SCRIPT, "adversarial-review", "--focus-file", focusFile, "inline too"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: "" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /either --focus-file or inline focus text/i);
});

// The flag task uses for the same job; agents reach for it on review verbs too.
test("adversarial-review --prompt-file names --focus-file", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "adversarial-review", "--prompt-file", "focus.md"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /has no option `--prompt-file`\. Did you mean `--focus-file`/);
});

// The built-in `review` takes no focus at all. It shares the review parser, so it must not
// accept --focus-file (whose rejection then pasted the file back into an inline retry command,
// the very shell hazard the option exists to avoid), nor hint at a text file it does not take.
test("review has no --focus-file and suggests no text file", () => {
  for (const flag of ["--focus-file", "--prompt-file"]) {
    const result = spawnSync(process.execPath, [SCRIPT, "review", flag, "focus.md"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" }
    });
    assert.notEqual(result.status, 0);
    const out = result.stderr + result.stdout;
    assert.match(out, new RegExp(`has no option \`${flag}\``));
    assert.doesNotMatch(out, /Did you mean `--(focus|prompt)-file`|in --(focus|prompt)-file/, "no hint toward a file option review does not have");
  }
});

// A heredoc or redirect that went wrong leaves the file empty; that used to launch a full
// unfocused review with no warning, spending quota on a question nobody asked.
test("adversarial-review refuses an empty --focus-file", () => {
  const repo = makeTempDir(); // the option check fails before any repo is read
  const focusFile = path.join(makeTempDir(), "focus.md");
  fs.writeFileSync(focusFile, "  \n\n");
  const result = spawnSync(process.execPath, [SCRIPT, "adversarial-review", "--focus-file", focusFile], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: "" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--focus-file .* is empty/);
});

// An unset shell variable (`--focus-file "$F"`) arrives as an empty path; treating it as an
// omitted option launched an unfocused review (Codex review, 2026-10-22).
for (const argv of [["--focus-file", ""], ["--focus-file="]]) {
  test(`adversarial-review ${argv.join(" ")} is refused, not run unfocused`, () => {
    const result = spawnSync(process.execPath, [SCRIPT, "adversarial-review", ...argv], {
      cwd: makeTempDir(),
      encoding: "utf8",
      env: { ...process.env, PATH: "" }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /--focus-file needs a path/);
  });
}
