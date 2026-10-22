import test from "node:test";
import assert from "node:assert/strict";

import {
  collectErrorInfoTags,
  collectSchemaMethods,
  contentDeletions,
  extractNameLiterals,
  knownMethods,
  makeGit,
  missingNames,
  parseCliVersion,
  parseAuditedShas,
  parseErrorVariants,
  parseLastPin,
  parseNewestAuditedSha,
  rangeReport
} from "../../.claude/skills/codex-upstream-sync/scripts/upstream-check.mjs";

const AUDIT_DOC = `# Audit

| Codex HEAD | \`99660ab3c7\` (baseline table, not the log) |

## Audit log

| Date | Codex HEAD | Plugin | Outcome |
|---|---|---|---|
| 2026-10-22 | \`c2d5ea52e1\` (main; 42 commits) | skill | No drift. |
| 2026-10-21 | \`a6839a4812\` (main) | skill | No drift. |
`;

test("the newest audited commit is the first log row that names one", () => {
  assert.equal(parseNewestAuditedSha(AUDIT_DOC), "c2d5ea52e1");
  const catalogOnlyFirst = AUDIT_DOC.replace("| 2026-10-22 | `c2d5ea52e1` (main; 42 commits)", "| 2026-10-22 | installed CLI 0.163.0");
  assert.equal(parseNewestAuditedSha(catalogOnlyFirst), "a6839a4812");
  assert.equal(parseNewestAuditedSha("# no log here"), null);
  assert.deepEqual(parseAuditedShas(AUDIT_DOC), ["c2d5ea52e1", "a6839a4812"]);
});

test("the last checked pin is the newest row that recorded one", () => {
  const doc = AUDIT_DOC.replace("(main; 42 commits)", "(main; installed 0.163.0, pin `origin/release/0.163.0-alpha.10.2` @ `30c1058df6`)");
  assert.deepEqual(parseLastPin(doc), { ref: "origin/release/0.163.0-alpha.10.2", sha: "30c1058df6" });
  assert.equal(parseLastPin(AUDIT_DOC), null);
});

test("the installed version is read from codex --version", () => {
  assert.equal(parseCliVersion("codex-cli 0.163.0"), "0.163.0");
  assert.equal(parseCliVersion("codex-cli 0.164.0-alpha.11"), "0.164.0-alpha.11");
  assert.equal(parseCliVersion("command not found"), null);
});

const schema = (...methods) =>
  JSON.stringify({
    oneOf: methods.map((m) => ({ properties: { id: {}, method: { enum: [m], type: "string" } } }))
  });

test("method names come from every variant's method enum", () => {
  assert.deepEqual([...collectSchemaMethods(schema("turn/start", "thread/start"))].sort(), ["thread/start", "turn/start"]);
});

test("a method the companion uses that upstream dropped is reported, and nothing else", () => {
  const source = `client.request("turn/start", p); client.request("thread/sample", q);
    if (status === "completed") {} case "broker/shutdown": path.join(dir, 'jobs/x');`;
  const referenced = extractNameLiterals(source);
  const before = collectSchemaMethods(schema("turn/start", "thread/sample", "feedback/save"));
  const after = collectSchemaMethods(schema("thread/sample", "feedback/save", "completed"));
  // turn/start is gone; "completed" was never an upstream method before; broker/shutdown and
  // jobs/x are the companion's own strings; feedback/save is upstream-only.
  assert.deepEqual(missingNames(referenced, before, after), ["turn/start"]);
  assert.deepEqual(missingNames(referenced, before, collectSchemaMethods(schema("turn/start", "thread/sample"))), []);
});

test("the real companion source yields the methods it sends", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../skills/codex/scripts/lib/codex.mjs", import.meta.url), "utf8");
  const names = extractNameLiterals(src);
  for (const m of ["thread/start", "turn/start", "review/start", "turn/completed"]) assert.ok(names.has(m), m);
});

const ERROR_RS = `pub enum CodexErrorDetails {
    #[error("{0}")]
    CyberPolicy { message: String },
    /// doc comment
    ServerOverloaded,
    GatewayLoginRequired(String),
}

impl CodexErr {
    pub fn retry_delay(&self, retry_count: u64) -> Option<Duration> {
        match self.details() {
            CodexErrorDetails::CyberPolicy { .. }
            | CodexErrorDetails::GatewayLoginRequired(_) => None,
            CodexErrorDetails::ServerOverloaded => self.server_retry_delay(),
        }
    }
}
`;

test("error variants are split into terminal and the rest", () => {
  const { variants, terminal } = parseErrorVariants(ERROR_RS);
  assert.deepEqual([...variants].sort(), ["CyberPolicy", "GatewayLoginRequired", "ServerOverloaded"]);
  assert.deepEqual([...terminal].sort(), ["CyberPolicy", "GatewayLoginRequired"]);
});

test("wire error tags include string and object variants", () => {
  const text = JSON.stringify({
    definitions: {
      CodexErrorInfo: { anyOf: [{ enum: ["cyberPolicy", "other"] }, { required: ["httpConnectionFailed"], properties: {} }] }
    }
  });
  assert.deepEqual([...collectErrorInfoTags(text)].sort(), ["cyberPolicy", "httpConnectionFailed", "other"]);
});

test("only content deletions count, not file headers or comments", () => {
  const diff = ["--- a/x.json", "+++ b/x.json", '-  "removed": 1,', "-  // a comment", "-   * doc line", "-", '+  "added": 2'].join("\n");
  assert.deepEqual(contentDeletions(diff), ['-  "removed": 1,']);
});

test("a release branch forked before the audited commit is diffed from the merge-base", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-check-"));
  const g = (...args) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (methods) => {
    const p = path.join(dir, "codex-rs/app-server-protocol/schema/json/ClientRequest.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(JSON.parse(schema(...methods)), null, 2));
  };
  try {
    g("init", "-q", "-b", "main");
    write(["turn/start"]);
    g("add", "-A");
    g("commit", "-qm", "fork point");
    g("branch", "release");
    write(["turn/start", "thread/sample"]);
    g("commit", "-qam", "main adds a method");
    const since = g("rev-parse", "HEAD");

    const atRelease = rangeReport(makeGit(dir), since, "release", new Set(["turn/start"]));
    assert.deepEqual(atRelease.schema.deletions, [], "main-only additions are not deletions on the branch");
    assert.equal(atRelease.breaking, false);

    g("checkout", "-q", "release");
    write([]);
    g("commit", "-qam", "release drops turn/start");
    const dropped = rangeReport(makeGit(dir), since, "release", new Set(["turn/start"]));
    assert.deepEqual(dropped.missing, ["turn/start"]);
    assert.equal(dropped.breaking, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a removal recorded as a forward look is still caught once it ships", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-check-"));
  const g = (...args) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (methods) => {
    const p = path.join(dir, "codex-rs/app-server-protocol/schema/json/ServerNotification.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(JSON.parse(schema(...methods)), null, 2));
  };
  try {
    g("init", "-q", "-b", "main");
    write(["turn/completed", "turn/started"]);
    g("add", "-A");
    g("commit", "-qm", "first audited pass");
    const first = g("rev-parse", "HEAD");
    write(["turn/started"]);
    g("commit", "-qam", "main drops turn/completed (seen as a forward look, row recorded here)");
    const second = g("rev-parse", "HEAD");
    g("branch", "release", second); // the next release ships the removal
    const git = makeGit(dir);
    const referenced = new Set(["turn/completed", "turn/started"]);

    // Starting from the newer row alone, the removal is invisible: base and since both lack it.
    assert.deepEqual(rangeReport(git, second, "release", referenced).missing, []);
    // The audit log's commits keep it in view; a commit the checkout lacks is skipped.
    const known = knownMethods(git, [second, first, "0123456789"]);
    const report = rangeReport(git, second, "release", referenced, known);
    assert.deepEqual(report.missing, ["turn/completed"]);
    assert.equal(report.breaking, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload change first seen as a forward look is caught once it ships", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-check-"));
  const g = (...args) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const write = (field) => {
    const p = path.join(dir, "codex-rs/app-server-protocol/schema/json/v2/TurnCompletedNotification.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ properties: { [field]: { type: "object" } }, required: [field] }, null, 2));
  };
  try {
    g("init", "-q", "-b", "main");
    write("turn");
    g("add", "-A");
    g("commit", "-qm", "installed release forks here");
    g("branch", "release-old");
    const oldPin = g("rev-parse", "release-old");
    write("result");
    g("commit", "-qam", "main renames turn -> result (forward look; the row moves --since here)");
    const since = g("rev-parse", "HEAD");
    g("branch", "release-new"); // the next installed release carries the rename
    const git = makeGit(dir);
    const referenced = new Set();

    // From the moved --since the rename is behind the base: a false clean.
    assert.equal(rangeReport(git, since, "release-new", referenced).breaking, false);
    // From the last checked pin it is a deletion at the new pin.
    const report = rangeReport(git, oldPin, "release-new", referenced);
    assert.equal(report.breaking, true);
    assert.ok(report.schema.deletions.some((l) => l.includes('"turn"')), report.schema.deletions.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
