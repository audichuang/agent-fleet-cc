// plugins/antigravity/scripts/lib/adapter.mjs
// AntigravityAdapter: all agy engine knowledge lives here (spec §2/§5).
// Job runtime (state/worker/cancel/reconcile) is the vendored shared lib.
// agy --print is PLAIN-TEXT print mode: NO JSON event stream (verified live,
// agy v1.0.14: `agy --print "<prompt>"` -> "OK\n", exit 0, empty stderr).
// parseEvent therefore emits one event per line INCLUDING blank lines (so
// paragraph breaks survive - spec D-1) and extractResult joins + edge-trims.
// agy exposes no conversation id -> sessionId null (spec D-2).
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Recursion marker (spec D-15). buildEngineEnv force-injects it; a read-side
// guard is ADDED at the CLI entry (bin/antigravity.mjs), mirroring cc's
// cc-companion.mjs:91, so an agy-in-agy recursion is refused. New protection
// (antigravity had NO read-side before - grep-verified).
export const RECURSION_MARKER = "ANTIGRAVITY_ACTIVE";
export const DEFAULT_AGY_BIN = "agy";
export const DEFAULT_PRINT_TIMEOUT_MS = 300000; // agy print-mode default 5m (agent-runtime.mjs:19)

// --- state root (ported VERBATIM from state.mjs:50-61 - DO NOT relocate) ---
function stateRootDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA
    ? path.join(env.CLAUDE_PLUGIN_DATA, "state")
    : path.join(os.tmpdir(), "antigravity");
}
function slugify(v) {
  return String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 48);
}
// resolveDataRoot returns the ROOT (.../state or os.tmpdir()/antigravity);
// workspaceStateDir(dataRoot, cwd) appends "<slug>-<12hex sha256(gitRoot)>".
export function resolveDataRoot(env = process.env) {
  return stateRootDir(env);
}
export function workspaceStateDir(dataRoot, cwd) {
  const root = resolveWorkspaceRoot(cwd);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return path.join(dataRoot, `${slugify(path.basename(root))}-${hash}`);
}

export function resolveAgyBin(env = process.env) {
  if (env.AGY_BIN && existsSync(env.AGY_BIN)) return env.AGY_BIN;
  for (const dir of (env.PATH || env.Path || "").split(":").filter(Boolean)) {
    if (existsSync(path.join(dir, DEFAULT_AGY_BIN))) return path.join(dir, DEFAULT_AGY_BIN);
  }
  if (env.HOME && existsSync(path.join(env.HOME, ".local", "bin", DEFAULT_AGY_BIN)))
    return path.join(env.HOME, ".local", "bin", DEFAULT_AGY_BIN);
  return DEFAULT_AGY_BIN;
}
export function resolveAgyTimeouts(env = process.env) {
  const p = Number(env.AGY_PRINT_TIMEOUT_MS);
  const printMs = Number.isFinite(p) && p > 0 ? p : DEFAULT_PRINT_TIMEOUT_MS;
  const h = Number(env.AGY_JOB_TIMEOUT_MS);
  const rawHard = Number.isFinite(h) && h > 0 ? h : printMs + 60000;
  // D-19 invariant: the Node backstop must NEVER fire before agy's own
  // --print-timeout (let the engine time out first with a clean error).
  const hardMs = Math.max(rawHard, printMs);
  return { printMs, hardMs };
}
export async function probeAgy({ bin = resolveAgyBin(), timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve({ ok: false, reason: "timeout" }); }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.code === "ENOENT" ? "not-installed" : e.message }); });
    child.on("exit", (code) => { clearTimeout(timer); code !== 0 ? resolve({ ok: false, reason: `exit ${code}` }) : resolve({ ok: true, version: stdout.trim().split(/\s+/)[0] || "unknown" }); });
  });
}
function toGoDuration(ms) { return `${Math.max(1, Math.ceil(Number(ms) / 1000))}s`; }

// Auth sentinels the old runtime scraped (agent-runtime.mjs:41-45) + the URL.
// Checked on BOTH channels: stderrTail (classifyError) and joined stdout tail
// (extractResult) - see BEHAVIOR CHANGE 1's auth-channel note (spec D-3).
const AUTH_PATTERN =
  /Authentication required|Waiting for authentication|accounts\.google\.com\/o\/oauth2\/auth|not (?:authenticated|logged in)|unauthorized|\b401\b/i;

export function makeAntigravityAdapter({ env = process.env } = {}) {
  const bin = resolveAgyBin(env);
  const { printMs } = resolveAgyTimeouts(env);
  return {
    name: "antigravity",
    engine: "antigravity",
    recursionMarker: RECURSION_MARKER,
    wantsWatchdog: false,
    // Prompt is an argv OPERAND of --print (verified live: bare `agy --print`
    // exits 2 "flag needs an argument: -print"; `agy --print "<prompt>"` -> OK).
    // stdinPayload:"" - agy stdio never reads the prompt from stdin
    // (agent-runtime.mjs:135,140); runWorker's stdin.end()+EPIPE-on-exit-0
    // guard (worker.mjs:243) makes the empty closed stdin harmless.
    buildInvocation({ job, prompt }) {
      const r = job.request ?? {};
      const argv = [r.binaryArgv ? undefined : bin, ...(r.binaryArgv ?? [])].filter(Boolean);
      if (r.mode === "continue") argv.push("--continue");
      if (r.mode === "conversation") {
        if (!r.conversationId) throw new Error("antigravity: mode=conversation requires conversationId");
        argv.push("--conversation", String(r.conversationId));
      }
      if (r.model) argv.push("--model", String(r.model));
      if (r.sandbox) argv.push("--sandbox");
      // Write mode (opt-in): agy 1.1's --print defaults to review — a headless
      // run without a bound project + accept-edits either only prints a plan
      // (exit 0) or writes to ~/.gemini scratch, NOT the job cwd. --new-project
      // binds job.cwd as the workspace; --mode accept-edits auto-applies edits.
      // Off by default → the plain text-out contract is unchanged.
      if (r.write) argv.push("--new-project", "--mode", "accept-edits");
      // Separate opt-in: accept-edits auto-approves EDITS only; a task that also
      // runs commands still prompts (and stalls headless). This lifts all tool
      // permission gates. Command layer gates it behind r.write.
      if (r.skipPermissions) argv.push("--dangerously-skip-permissions");
      argv.push("--print-timeout", toGoDuration(r.printTimeoutMs ?? printMs));
      for (const d of r.addDirs ?? []) argv.push("--add-dir", String(d));
      argv.push("--print", prompt);
      return { argv, env: {}, stdinPayload: "" };
    },
    // No event stream - emit ONE event per line INCLUDING blank lines so
    // extractResult can rebuild paragraph structure losslessly (spec D-1).
    // The log is NOT byte-exact (readline re-joins line+"\n"), so resultText -
    // not the log - is the fidelity source. Never throws.
    parseEvent(rawLine) {
      const text = typeof rawLine === "string" ? rawLine : String(rawLine ?? "");
      return { kind: "line", text };
    },
    // Join ALL lines, then trim only leading/trailing whitespace - inner blank
    // lines (paragraph breaks) survive (spec D-1). sessionId always null (HARD
    // FACT 4). ok = exit 0 AND stdout carries no auth sentinel (auth-channel).
    extractResult(events, exitCode) {
      const joined = events.filter((e) => e.kind === "line").map((e) => e.text).join("\n").trim();
      const authInStdout = AUTH_PATTERN.test(joined.slice(-2000));
      return {
        ok: exitCode === 0 && !authInStdout,
        resultText: joined.length ? joined : null,
        sessionId: null,
        usage: null,
      };
    },
    classifyError(stderrTail, exitCode) {
      const s = String(stderrTail ?? "");
      if (AUTH_PATTERN.test(s)) return "auth";
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|ENETUNREACH/i.test(s)) return "endpoint";
      if (exitCode === 127 || /command not found|ENOENT|not found/i.test(s)) return "not-installed";
      return "unknown";
    },
    resumeArgs(sessionId) { return ["--conversation", String(sessionId)]; },
  };
}
