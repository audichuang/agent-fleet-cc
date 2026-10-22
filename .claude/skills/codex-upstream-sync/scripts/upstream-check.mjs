#!/usr/bin/env node
// upstream-check.mjs — the deterministic half of a codex upstream-sync pass: is the codex skill
// still compatible with the Codex CLI that is installed, and with what upstream main is about to
// ship? It reads a local codex checkout and this repo, never writes to either, and never touches
// the network (fetch the checkout first; ../SKILL.md says how).
//
//   node .claude/skills/codex-upstream-sync/scripts/upstream-check.mjs [--codex <dir>] [--since <sha>] [--json]
//
// --codex defaults to $CODEX_REPO, then the sibling ../codex of this repo's main checkout (so a
// run from a linked worktree under .claude/worktrees still finds it).
// --since defaults to the commit on the newest row of docs/codex-protocol-sync-audit.md's Audit log.
//
// Exit 0: no drift at the installed pin. Exit 1: drift at the pin that needs a reviewer (a schema
// deletion, a method name the companion uses gone, an error variant removed). Exit 2: the check
// could not run. Drift that exists only on main is a forward look: reported, exit stays 0.
//
// Zero-dependency ESM. The pure helpers are exported for tests/codex/upstream-check.test.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .claude/skills/codex-upstream-sync/scripts -> repo root is 4 levels up.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUDIT_DOC = path.join(REPO, "docs/codex-protocol-sync-audit.md");
const COMPANION_DIR = path.join(REPO, "skills/codex/scripts");
const SCHEMA_DIR = "codex-rs/app-server-protocol/schema/json";
const PROTOCOL_SRC = "codex-rs/app-server-protocol/src";
const ERROR_RS = "codex-rs/protocol/src/error.rs";
const PROTOCOL_PATHS = ["codex-rs/app-server-protocol", "codex-rs/app-server", "codex-rs/protocol/src"];
const METHOD_SCHEMAS = ["ClientRequest.json", "ServerNotification.json", "ServerRequest.json"];

// ---- pure helpers -------------------------------------------------------------------------

// The commit in each Audit-log row's "Codex HEAD" cell, newest first. Rows without one
// (catalog-only passes) are skipped.
export function parseAuditedShas(docText) {
  const log = docText.split(/^## Audit log\s*$/m)[1];
  if (!log) return [];
  return log
    .split("\n")
    .map((line) => line.match(/^\|\s*\d{4}-\d{2}-\d{2}[^|]*\|\s*`([0-9a-f]{7,40})`/)?.[1])
    .filter(Boolean);
}

export function parseNewestAuditedSha(docText) {
  return parseAuditedShas(docText)[0] ?? null;
}

// The installed release the newest row that recorded one was checked against, written by the row
// skeleton as "pin `<ref>` @ `<sha>`". The pin section starts there, not at `since`: `since`
// follows main, so a change first seen as a forward look is behind it by the time it ships.
export function parseLastPin(docText) {
  const log = docText.split(/^## Audit log\s*$/m)[1] ?? "";
  const m = log.match(/^\|\s*\d{4}-\d{2}-\d{2}.*?pin `([^`]+)` @ `([0-9a-f]{7,40})`/m);
  return m ? { ref: m[1], sha: m[2] } : null;
}

export function parseCliVersion(text) {
  return text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/)?.[1] ?? null;
}

// Every JSON-RPC method name a schema file declares: each variant carries it as
// `properties.method.enum`.
export function collectSchemaMethods(schemaText) {
  const out = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const values = node.properties?.method?.enum;
    if (Array.isArray(values)) for (const v of values) if (typeof v === "string") out.add(v);
    for (const v of Object.values(node)) walk(v);
  };
  walk(JSON.parse(schemaText));
  return out;
}

// Every string literal in the companion source that could be a method name. No grammar to get
// wrong: the caller intersects this with the names upstream actually declared, so a literal
// like "completed" only counts if upstream has a method by that name.
export function extractNameLiterals(sourceText) {
  const out = new Set();
  for (const m of sourceText.matchAll(/(["'`])([A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z0-9]+)*)\1/g)) out.add(m[2]);
  return out;
}

// Names the companion mentions that upstream declared at `before` and no longer declares.
export function missingNames(referenced, before, after) {
  return [...referenced].filter((n) => before.has(n) && !after.has(n)).sort();
}

// The wire error tags (`codexErrorInfo`): string variants plus the key of each object variant.
export function collectErrorInfoTags(serverNotificationText) {
  const def = JSON.parse(serverNotificationText).definitions?.CodexErrorInfo;
  const out = new Set();
  for (const variant of def?.anyOf ?? def?.oneOf ?? []) {
    for (const v of variant.enum ?? []) out.add(v);
    for (const k of variant.required ?? []) out.add(k);
  }
  return out;
}

// CodexErrorDetails variants, and which of them sit in retry_delay's terminal (`=> None`) arm.
export function parseErrorVariants(errorRs) {
  const variants = new Set();
  const body = errorRs.match(/pub enum CodexErrorDetails \{\n([\s\S]*?)\n\}/)?.[1] ?? "";
  for (const m of body.matchAll(/^ {4}([A-Z][A-Za-z0-9]*)\b/gm)) variants.add(m[1]);
  const terminal = new Set();
  const retry = errorRs.split(/fn retry_delay\b/)[1]?.split("=> None")[0] ?? "";
  for (const m of retry.matchAll(/CodexErrorDetails::([A-Z][A-Za-z0-9]*)/g)) terminal.add(m[1]);
  return { variants, terminal };
}

export function setDiff(a, b) {
  return { added: [...b].filter((x) => !a.has(x)).sort(), removed: [...a].filter((x) => !b.has(x)).sort() };
}

// Deleted lines of a unified diff that carry content: no file headers, no Rust comments.
export function contentDeletions(diffText) {
  return diffText
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .filter((l) => !/^-\s*(\/\/|\*|\/\*)/.test(l) && l.trim() !== "-");
}

// ---- git / filesystem ---------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

export function makeGit(codexDir) {
  const git = (...args) => {
    const r = sh("git", ["-C", codexDir, ...args]);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  git.show = (ref, file) => {
    const r = sh("git", ["-C", codexDir, "show", `${ref}:${file}`]);
    return r.status === 0 ? r.stdout : null;
  };
  git.ok = (...args) => sh("git", ["-C", codexDir, ...args]).status === 0;
  return git;
}

// Every method name declared at any of `refs`; refs the checkout lacks are skipped.
export function knownMethods(git, refs) {
  const out = new Set();
  for (const ref of refs) if (git.ok("cat-file", "-e", `${ref}^{commit}`)) for (const m of methodsAt(git, ref)) out.add(m);
  return out;
}

function methodsAt(git, ref) {
  const out = new Set();
  for (const f of METHOD_SCHEMAS) {
    const text = git.show(ref, `${SCHEMA_DIR}/${f}`);
    if (text) for (const m of collectSchemaMethods(text)) out.add(m);
  }
  return out;
}

function companionLiterals() {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) for (const n of extractNameLiterals(fs.readFileSync(p, "utf8"))) out.add(n);
    }
  };
  walk(COMPANION_DIR);
  return out;
}

// The installed binary's release ref. A `rust-v<version>` tag when one exists; otherwise the
// release branches whose checked-in schema/json equals what the binary exports, file for file.
function findPin(git, version, tmp) {
  const tag = `rust-v${version}`;
  if (git.ok("rev-parse", "--verify", "-q", `refs/tags/${tag}`)) return { ref: tag, how: "tag", matches: [tag] };
  const out = path.join(tmp, "schema");
  const gen = sh("codex", ["app-server", "generate-json-schema", "--out", out]);
  if (gen.status !== 0) throw new Error(`codex app-server generate-json-schema failed: ${gen.stderr.trim()}`);
  const exported = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else exported.set(path.relative(out, p).split(path.sep).join("/"), p);
    }
  };
  walk(out);
  const rels = [...exported.keys()];
  const hashes = sh("git", ["hash-object", "--stdin-paths"], { input: rels.map((r) => exported.get(r)).join("\n") })
    .stdout.trim()
    .split("\n");
  const want = new Map(rels.map((r, i) => [r, hashes[i]]));
  const refs = git("for-each-ref", "--format=%(refname:short)", `refs/remotes/origin/release/${version}*`, `refs/heads/release/${version}*`)
    .split("\n")
    .filter(Boolean);
  const matches = refs.filter((ref) => {
    const tree = git("ls-tree", "-r", ref, "--", SCHEMA_DIR).split("\n").filter(Boolean);
    if (tree.length !== want.size) return false;
    return tree.every((line) => {
      const [meta, file] = line.split("\t");
      return want.get(file.slice(SCHEMA_DIR.length + 1)) === meta.split(" ")[2];
    });
  });
  matches.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { ref: matches.at(-1) ?? null, how: "schema", matches };
}

// The diff runs from merge-base(from, ref). For the installed pin `from` is the last recorded pin,
// so the range is everything the binary gained since the last checked one, wherever main stood;
// for the forward look it is `since`. A release branch usually forks from main before either,
// and the merge-base keeps later main additions the branch lacks from reading as deletions.
// `known` is every method declared at any audited commit, for the companion-name check.
export function rangeReport(git, from, ref, referenced, known = methodsAt(git, from)) {
  const base = git("merge-base", from, ref).trim();
  const numstat = git("diff", "--numstat", base, ref, "--", SCHEMA_DIR)
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .map(([add, del, file]) => ({ file, add: Number(add) || 0, del: Number(del) || 0 }));
  const schemaDeletions = contentDeletions(git("diff", base, ref, "--", SCHEMA_DIR));
  const srcDeletions = contentDeletions(git("diff", base, ref, "--", PROTOCOL_SRC));
  const before = methodsAt(git, base);
  const after = methodsAt(git, ref);
  const methods = setDiff(before, after);
  const missing = missingNames(referenced, new Set([...before, ...known]), after);
  const errBefore = parseErrorVariants(git.show(base, ERROR_RS) ?? "");
  const errAfter = parseErrorVariants(git.show(ref, ERROR_RS) ?? "");
  const variants = setDiff(errBefore.variants, errAfter.variants);
  const tagsOf = (r) => collectErrorInfoTags(git.show(r, `${SCHEMA_DIR}/ServerNotification.json`) ?? "{}");
  const tags = setDiff(tagsOf(base), tagsOf(ref));
  const commits = git("log", "--oneline", `${base}..${ref}`, "--", ...PROTOCOL_PATHS).split("\n").filter(Boolean);
  const total = Number(git("rev-list", "--count", `${base}..${ref}`).trim());
  return {
    ref,
    base: git("rev-parse", "--short=10", base).trim(),
    head: git("rev-parse", "--short=10", ref).trim(),
    total,
    commits,
    schema: {
      files: numstat.length,
      add: numstat.reduce((s, x) => s + x.add, 0),
      del: numstat.reduce((s, x) => s + x.del, 0),
      filesWithDeletions: numstat.filter((x) => x.del > 0).map((x) => x.file),
      deletions: schemaDeletions
    },
    srcDeletions,
    methods,
    missing,
    errorVariants: {
      added: variants.added.map((v) => ({ name: v, terminal: errAfter.terminal.has(v) })),
      removed: variants.removed
    },
    errorInfoTags: tags,
    breaking: schemaDeletions.length > 0 || missing.length > 0 || variants.removed.length > 0 || tags.removed.length > 0
  };
}

function lastFetchHours(git) {
  const file = path.resolve(git("rev-parse", "--absolute-git-dir").trim(), "FETCH_HEAD");
  return fs.existsSync(file) ? (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000 : null;
}

function modelCatalog(defaultModel) {
  const file = path.join(os.homedir(), ".codex/models_cache.json");
  if (!fs.existsSync(file)) return { file, present: false };
  const cache = JSON.parse(fs.readFileSync(file, "utf8"));
  const model = (cache.models ?? []).find((m) => m.slug === defaultModel);
  return {
    file,
    present: true,
    fetchedAt: cache.fetched_at ?? null,
    clientVersion: cache.client_version ?? null,
    defaultModel,
    listed: Boolean(model),
    visibility: model?.visibility ?? null,
    levels: (model?.supported_reasoning_levels ?? []).map((l) => l.effort ?? l)
  };
}

function resolveDefaultModel() {
  if (process.env.CODEX_DEFAULT_MODEL?.trim()) return process.env.CODEX_DEFAULT_MODEL.trim();
  const src = fs.readFileSync(path.join(COMPANION_DIR, "codex-companion.mjs"), "utf8");
  return src.match(/fromEnv \|\| "([^"]+)"/)?.[1] ?? null;
}

// ---- report -------------------------------------------------------------------------------

function printRange(label, r, limit = 40) {
  const lines = [];
  lines.push(`\n## ${label}: ${r.base}..${r.ref} (${r.head}) — ${r.total} commits, ${r.commits.length} on protocol paths`);
  for (const c of r.commits.slice(0, limit)) lines.push(`  ${c}`);
  if (r.commits.length > limit) lines.push(`  … ${r.commits.length - limit} more`);
  lines.push(`schema/json: ${r.schema.files} files, +${r.schema.add}/−${r.schema.del}`);
  if (r.schema.filesWithDeletions.length) {
    lines.push(`  files with deletions (read these): ${r.schema.filesWithDeletions.join(", ")}`);
    for (const d of r.schema.deletions.slice(0, limit)) lines.push(`  ${d}`);
  }
  lines.push(`app-server-protocol/src non-comment deletions: ${r.srcDeletions.length}`);
  for (const d of r.srcDeletions.slice(0, limit)) lines.push(`  ${d}`);
  lines.push(`methods: +${r.methods.added.length} [${r.methods.added.join(", ")}] −${r.methods.removed.length} [${r.methods.removed.join(", ")}]`);
  lines.push(`companion names gone upstream: ${r.missing.length ? r.missing.join(", ") : "none"}`);
  const v = r.errorVariants;
  lines.push(
    `CodexErrorDetails: +[${v.added.map((x) => `${x.name}${x.terminal ? " (terminal)" : " (retryable or unclassified)"}`).join(", ")}] −[${v.removed.join(", ")}]`
  );
  lines.push(`codexErrorInfo wire tags: +[${r.errorInfoTags.added.join(", ")}] −[${r.errorInfoTags.removed.join(", ")}]`);
  lines.push(`verdict for this range: ${r.breaking ? "NEEDS REVIEW (deletion or removal above)" : "no removals — additive only"}`);
  return lines.join("\n");
}

// The main checkout's parent, not this file's: a linked worktree's ../codex is not the sibling.
function defaultCodexDir() {
  const r = sh("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const mainCheckout = r.status === 0 ? path.dirname(r.stdout.trim()) : REPO;
  return path.resolve(mainCheckout, "../codex");
}

function parseArgs(argv) {
  const opts = { codex: process.env.CODEX_REPO || defaultCodexDir(), since: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === "--codex") opts.codex = path.resolve(value());
    else if (flag === "--since") opts.since = value();
    else if (flag === "--json") opts.json = true;
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(opts.codex, "codex-rs"))) throw new Error(`no codex checkout at ${opts.codex} (pass --codex or set CODEX_REPO)`);
  const git = makeGit(opts.codex);
  const doc = fs.readFileSync(AUDIT_DOC, "utf8");
  const audited = parseAuditedShas(doc);
  const since = opts.since ?? audited[0];
  const lastPin = parseLastPin(doc);
  if (!since) throw new Error("no --since and no commit on the newest Audit-log row");
  if (!git.ok("cat-file", "-e", `${since}^{commit}`)) throw new Error(`${since} is not in ${opts.codex}; fetch it first`);

  const versionText = sh("codex", ["--version"]).stdout.trim();
  const version = parseCliVersion(versionText);
  if (!version) throw new Error(`cannot read the installed version from "${versionText}"`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-check-"));
  try {
    const pin = findPin(git, version, tmp);
    const main = git.ok("rev-parse", "--verify", "-q", "refs/remotes/origin/main") ? "origin/main" : "HEAD";
    const referenced = companionLiterals();
    const known = knownMethods(git, [since, ...audited, main]);
    const pinFrom = lastPin && git.ok("cat-file", "-e", `${lastPin.sha}^{commit}`) ? lastPin.sha : since;
    // A schema match does not pin the source: byte-identical release branches can differ in
    // error variants or behaviour, so every candidate is reported and any break fails the run.
    const pinReports = pin.matches.map((ref) => rangeReport(git, pinFrom, ref, referenced, known));
    const atMain = rangeReport(git, since, main, referenced, known);
    const fetchAge = lastFetchHours(git);
    const catalog = modelCatalog(resolveDefaultModel());
    const knownAtPin = pin.ref ? methodsAt(git, pin.ref) : new Set();
    const result = {
      codexRepo: opts.codex,
      since,
      lastPin,
      pinFrom,
      installed: versionText,
      lastFetchHours: fetchAge,
      version,
      pin,
      companionMethodNames: [...referenced].filter((n) => knownAtPin.has(n)).sort(),
      pinReports,
      atMain,
      catalog
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const out = [];
      out.push(`# codex upstream check — since ${since}`);
      out.push(`codex checkout: ${opts.codex}`);
      out.push(
        fetchAge == null
          ? "last fetch: never — the refs below may be stale; fetch first"
          : `last fetch: ${fetchAge.toFixed(1)} h ago${fetchAge > 24 ? " — STALE, fetch first" : ""}`
      );
      out.push(`installed: ${versionText}`);
      out.push(
        lastPin && pinFrom === lastPin.sha
          ? `last checked pin: ${lastPin.ref} @ ${lastPin.sha}`
          : `last checked pin: ${lastPin ? `${lastPin.sha} not in the checkout` : "none recorded"} — pin ranges start from ${since} instead`
      );
      out.push(
        pin.ref
          ? `pin: ${pin.matches.join(", ")} (by ${pin.how}${pin.matches.length > 1 ? "; schema-identical candidates, each reported below" : ""})`
          : `pin: NONE — no rust-v${version} tag and no release/${version}* branch matches the exported schema. Fetch, or pass a ref by hand.`
      );
      out.push(`companion method names declared at the pin: ${result.companionMethodNames.length}`);
      for (const r of pinReports) out.push(printRange("At the installed pin", r));
      out.push(printRange(`Forward look (${main}, not shipped yet)`, atMain));
      out.push(
        catalog.present
          ? `\n## Model catalog\n${catalog.file}: fetched ${catalog.fetchedAt} by ${catalog.clientVersion}; default ${catalog.defaultModel} ${catalog.listed ? `listed (${catalog.visibility}; levels ${catalog.levels.join(",")})` : "NOT LISTED"}`
          : `\n## Model catalog\n${catalog.file} missing — run any codex command once, or skip`
      );
      out.push(
        `\n## Audit-log row skeleton\n| ${new Date().toISOString().slice(0, 10)} | \`${atMain.head}\` (main; ${atMain.total} commits past \`${since}\`; installed ${versionText}, pin \`${pin.ref ?? "?"}\` @ \`${pinReports.at(-1)?.head ?? "?"}\`) | skill (unversioned) | **<verdict>.** <what changed that the companion touches, with anchors>. **Not run:** <…> |`
      );
      console.log(out.join("\n"));
    }
    if (!pinReports.length) return 2;
    return pinReports.some((r) => r.breaking) ? 1 : 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`upstream-check: ${error.message}`);
      process.exit(2);
    }
  );
}
