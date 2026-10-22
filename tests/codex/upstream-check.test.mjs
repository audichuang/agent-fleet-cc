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
  rangeReport,
  refMatchesVersion,
  resolvePinFrom
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

test("a release ref matches its own version, not a longer numeric continuation", () => {
  assert.ok(refMatchesVersion("origin/release/0.163.0-alpha.10.2", "0.163.0"));
  assert.ok(refMatchesVersion("origin/release/0.163.0", "0.163.0"));
  assert.ok(refMatchesVersion("release/99.0.0-alpha.1.2", "99.0.0-alpha.1"));
  assert.ok(!refMatchesVersion("origin/release/99.0.0-alpha.10.1", "99.0.0-alpha.1"));
  assert.ok(!refMatchesVersion("origin/release/0.163.01", "0.163.0"));
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

test("the pin baseline is the recorded pin or --pin-from, and never falls back", () => {
  const has = (ref) => ref !== "missing000";
  assert.deepEqual(resolvePinFrom({ ref: "release/x", sha: "30c1058df6" }, null, has), { sha: "30c1058df6" });
  assert.deepEqual(resolvePinFrom({ ref: "release/x", sha: "30c1058df6" }, "abc1234", has), { sha: "abc1234" });
  assert.match(resolvePinFrom(null, null, has).error, /no recorded pin/);
  assert.match(resolvePinFrom({ ref: "release/x", sha: "missing000" }, null, has).error, /not in the codex checkout/);
});

// A throwaway codex checkout: `commit(files, message)` writes schema files and commits them.
async function withCodexRepo(fn) {
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
  const commit = (files, message) => {
    for (const [rel, value] of Object.entries(files)) {
      const p = path.join(dir, "codex-rs/app-server-protocol/schema/json", rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(value, null, 2));
    }
    g("add", "-A");
    g("commit", "-qm", message);
    return g("rev-parse", "HEAD");
  };
  try {
    g("init", "-q", "-b", "main");
    return await fn({ g, commit, git: makeGit(dir) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const notification = (methods) => JSON.parse(schema(...methods));
const payload = (field) => ({ properties: { [field]: { type: "object" } }, required: [field] });

test("a removal recorded as a forward look is still caught once it ships", () =>
  withCodexRepo(({ g, commit, git }) => {
    const first = commit({ "ServerNotification.json": notification(["turn/completed", "turn/started"]) }, "first audited pass");
    const second = commit({ "ServerNotification.json": notification(["turn/started"]) }, "main drops turn/completed");
    g("branch", "release", second);
    const referenced = new Set(["turn/completed", "turn/started"]);
    // Starting from the newer row alone, the removal is invisible.
    assert.deepEqual(rangeReport(git, second, "release", referenced).missing, []);
    // The audit log's commits keep it in view; a commit the checkout lacks is skipped.
    const report = rangeReport(git, second, "release", referenced, knownMethods(git, [second, first, "0123456789"]));
    assert.deepEqual(report.missing, ["turn/completed"]);
    assert.equal(report.breaking, true);
  }));

test("a payload change first seen as a forward look is caught once it ships", () =>
  withCodexRepo(({ g, commit, git }) => {
    const oldPin = commit({ "v2/TurnCompletedNotification.json": payload("turn") }, "installed release forks here");
    const since = commit({ "v2/TurnCompletedNotification.json": payload("result") }, "main renames turn -> result");
    g("branch", "release-new", since);
    // From the moved --since there is nothing to see; from the last checked pin it is a deletion.
    assert.equal(rangeReport(git, since, "release-new", new Set()).breaking, false);
    const report = rangeReport(git, oldPin, "release-new", new Set());
    assert.equal(report.breaking, true);
    assert.ok(report.schema.deletions.some((l) => l.includes('"turn"')), report.schema.deletions.join("\n"));
  }));

test("a release-only change the next release lacks is a removal between the two pins", () =>
  withCodexRepo(({ g, commit, git }) => {
    commit({ "v2/TurnCompletedNotification.json": payload("result") }, "fork point");
    g("checkout", "-q", "-b", "release-old");
    const oldPin = commit({ "v2/TurnCompletedNotification.json": payload("turn") }, "old release patches in turn");
    g("checkout", "-q", "main");
    g("branch", "release-new");
    const report = rangeReport(git, oldPin, "release-new", new Set());
    assert.equal(report.breaking, true);
    assert.ok(report.schema.deletions.some((l) => l.includes('"turn"')), report.schema.deletions.join("\n"));
  }));

test("an additive params change is listed for the manual params read", () =>
  withCodexRepo(({ commit, git }) => {
    const oldPin = commit({ "v2/TurnStartParams.json": { required: ["threadId"] } }, "old");
    const newPin = commit({ "v2/TurnStartParams.json": { required: ["apiVersion", "threadId"] } }, "adds a required field");
    const report = rangeReport(git, oldPin, newPin, new Set());
    assert.deepEqual(report.schema.changed.map((f) => f.file), ["v2/TurnStartParams.json"]);
  }));

test("a runtime fix only the old release carried is reported as dropped", () =>
  withCodexRepo(async ({ g, git }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = g("rev-parse", "--show-toplevel");
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write("codex-rs/app-server/src/config.rs", "fn accept_override() -> bool { false }\n");
    g("add", "-A");
    g("commit", "-qm", "fork point");
    g("checkout", "-q", "-b", "release-old");
    write("codex-rs/app-server/src/config.rs", "fn accept_override() -> bool { true }\n");
    g("commit", "-qam", "old release accepts the override");
    const oldPin = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    write("codex-rs/app-server/src/other.rs", "fn unrelated() {}\n");
    g("add", "-A");
    g("commit", "-qm", "main moves on without the fix");
    g("branch", "release-new");
    const report = rangeReport(git, oldPin, "release-new", new Set());
    assert.equal(report.dropped.length, 1, report.dropped.join("\n"));
    assert.match(report.dropped[0], /old release accepts the override/);
    assert.equal(report.breaking, true);
    // Cherry-picked into the next release, it is no longer dropped.
    g("checkout", "-q", "release-new");
    g("-c", "core.editor=true", "cherry-pick", oldPin);
    assert.deepEqual(rangeReport(git, oldPin, "release-new", new Set()).dropped, []);
  }));
