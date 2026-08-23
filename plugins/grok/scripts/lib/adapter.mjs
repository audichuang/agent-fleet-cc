// plugins/grok/scripts/lib/adapter.mjs
// GrokAdapter:grok — all engine knowledge for xAI Grok Build lives here.
// Job runtime (state/worker/cancel) is the vendored shared lib; this file
// touches no I/O lifecycle. Auth is delegated to the grok CLI (XAI_API_KEY or
// a cached token from `grok login`) — no secrets ever land in a job record.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promptFilePath } from "./shared/core/state-store.mjs";

// A single argv element is capped by Linux MAX_ARG_STRLEN (32 pages = 131071
// bytes) — NOT by ARG_MAX (~2MB, what `getconf ARG_MAX` reports). Cross it and
// node's spawn throws E2BIG synchronously, before grok ever runs (measured on
// Linux: 131071 ok, 131072 E2BIG). Reachable today via `/grok:task --prompt-file`,
// which reads an arbitrary user file into the prompt.
export const PROMPT_ARGV_LIMIT = 120_000;

export const RECURSION_MARKER = "GROK_FLEET_ACTIVE";

// Fan-out final-report sentinels (see commands/task.md). A multi-agent run
// concatenates every agent's text into one undelimited stream — grok headless
// exposes no agent id, so leaked subagent output cannot be demuxed. If the
// leader fences its final report with these, we keep only that.
export const FINAL_OPEN = "<<<GROK_FINAL>>>";
export const FINAL_CLOSE = "<<<GROK_END>>>";

// First-open → last-close: spans the whole fenced report even when the report
// body itself quotes the sentinel tokens (a report *about* grok will), while
// still dropping the subagent chatter that leaks in *before* the leader opens
// the fence. No fence → return the full text unchanged.
function extractFinalReport(text) {
  const open = text.indexOf(FINAL_OPEN);
  const close = text.lastIndexOf(FINAL_CLOSE);
  return open >= 0 && close > open
    ? text.slice(open + FINAL_OPEN.length, close).trim()
    : text;
}

// grok now stamps a usage object on the streaming-json `end` event, the
// `--output-format json` result, AND error events (verified against the CLI
// source: headless.rs attach_result_usage). It is snake_case; the shared job
// record wants { inputTokens, outputTokens } (see core/job.mjs) — same shape
// the cc adapter fills. Absent/partial usage → null (no fake zero telemetry).
function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : null;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : null;
  return inputTokens === null && outputTokens === null
    ? null
    : { inputTokens, outputTokens };
}

export function resolveDataRoot(env = process.env) {
  if (env.GROK_PLUGIN_DATA) return env.GROK_PLUGIN_DATA;
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok");
}

export function workspaceStateDir(dataRoot, cwd) {
  const slug =
    path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32) || "ws";
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return path.join(dataRoot, "state", `${slug}-${hash}`);
}

// stateDir is optional and only used to reach the prompt file the worker already
// wrote — an oversized prompt is handed to grok as `--prompt-file` instead of
// `-p` (see PROMPT_ARGV_LIMIT). Without it the adapter behaves exactly as before.
export function makeGrokAdapter({ stateDir = null } = {}) {
  // Per-run state. A JSON-schema job runs non-streaming (`--output-format json`,
  // implied by --json-schema): grok prints ONE multi-line result object instead
  // of a token stream, so parseEvent buffers lines until that object parses.
  let jsonMode = false;
  let jsonBuf = "";

  return {
    name: "grok",
    engine: "grok",
    recursionMarker: RECURSION_MARKER,
    wantsWatchdog: false,
    // 首輸出看門狗 —— **預設關閉,只在使用者明確設 GROK_FIRST_EVENT_TIMEOUT_MS 時啟用。**
    //
    // 它要防的卡頓是真的:cached token 過期或是 legacy WebLogin 時,acp_agent.rs:704-732 轉進
    // authenticate_after_cached_token_unavailable,後者若選到 grok.com 就把 meta 整個換成
    // {"use_oauth": true}(agent_ops.rs:1412-1416),原本的 headless 標記就此消失,然後瀏覽器
    // OAuth callback 等 600s(auth/oidc/login.rs)。`--background` 時完全不可見。headless.rs 的
    // authenticate 只在**方法選擇**那層 fail closed,擋不到這條。
    //
    // 但**沒有任何常數是安全的**,所以不能預設開。grok 的啟動階段刻意對 stdout 安靜:
    //   · `restore_progress_on_stdout: false`(headless.rs headless_materialize_ctx)—— remote
    //     restore 的進度只走 stderr;
    //   · `REMOTE_RESTORE_TIMEOUT = 90s`(app/session_startup.rs)—— 單是遠端還原就可以合法花 90 秒,
    //     之後才開 session、抓 model catalog。
    //   · model catalog 那段**其實有界**(BUDGET = STARTUP_AUTH_REFRESH + STARTUP_FETCH = 5s+5s)。
    //     真正沒有源碼保證上限的是 **session opening 本身** —— 那一項才是預設不安全的理由。
    // 也就是說一個健康的 `-r` resume 可以合法安靜遠超過任何我們敢設的預算:120s 曾經被設成
    // 預設,結果就是會殺掉健康的 run(被 review 抓到)。完整推導與錨點在 audit doc 的
    // startup-silence 列 —— 那裡是正本,別在此重抄(root AGENTS.md)。
    // 兩邊代價不對稱:漏抓 = 退回既有行為(那個卡頓本身有 600s 上限、最後會真的報錯);
    // 誤殺 = 直接摧毀使用者的工作。所以預設站在漏抓那邊,把選擇權交給真的踩過的人。
    //
    // 兩條 hard-won 的規則,啟用時也不准動:
    //  (1) 解除門檻是 stdout 上**任何非空行**,不是 parseEvent 解析成功。grok 的 parseEvent 只認
    //      text / end / error,available_commands / thought / tool_call / tool_call_update 全回 null。
    //  (2) `--json-schema` 一律不啟用,即使使用者設了環境變數。它是非串流的,終端物件之前 stdout
    //      一個位元組都不寫(真跑驗過:健康的 schema run 被 15s 預算殺掉),所以那個模式下這道關
    //      只會誤殺。jsonMode 由 buildInvocation 設定,worker 在那之後才讀這個 getter。
    get firstEventTimeoutMs() {
      if (jsonMode) return null;
      const raw = process.env.GROK_FIRST_EVENT_TIMEOUT_MS;
      if (raw === undefined || raw.trim() === "") return null; // 沒 opt-in
      // 有設但解不出正有限數(`abc`、`30s`、`0`、`Infinity`)→ 回那個壞值,不要回 null。
      // 回 null 等於安靜關掉,使用者會以為自己開了防護;交給 worker 記一筆 adapter-warning。
      return Number(raw);
    },
    buildInvocation({ job, prompt }) {
      const r = job.request ?? {};
      jsonMode = Boolean(r.jsonSchema);
      const head = r.binaryArgv ?? [process.env.GROK_BIN ?? "grok"];
      // Prompt inline via -p until it would blow MAX_ARG_STRLEN (PROMPT_ARGV_LIMIT
      // above). Past that, hand grok the prompt file the worker ALREADY wrote at
      // <jobDir>/prompt.txt — no new file, nothing to clean up. `.txt` matters:
      // grok parses a `.json` prompt file as ACP content blocks and everything
      // else as plain text (headless/cli.rs:58-68). `--prompt-file` is
      // `conflicts_with_all = ["single","prompt_json"]` (cli.rs:502-509), so this
      // is a swap for `-p`, not an addition, and it triggers headless on its own.
      const oversized = Buffer.byteLength(prompt) > PROMPT_ARGV_LIMIT;
      const promptPath = oversized && stateDir && job.id
        ? promptFilePath(stateDir, job.id)
        : null;
      const argv = promptPath
        ? [...head, "--prompt-file", promptPath]
        : [...head, "-p", prompt];
      if (jsonMode) {
        // --json-schema constrains the model to the schema and IMPLIES
        // --output-format json (one result object: .text = the JSON string,
        // .structuredOutput = the parsed object). No token stream → no live
        // logs and no fan-out sentinel needed for this job.
        argv.push("--json-schema", r.jsonSchema);
      } else {
        argv.push("--output-format", "streaming-json");
      }
      argv.push(
        "--always-approve",
        "--no-auto-update",
        "--no-alt-screen",
        "-m", r.model ?? process.env.GROK_DEFAULT_MODEL ?? "grok-4.5",
      );
      const cwd = job.cwd ?? r.cwd;
      if (cwd) argv.push("--cwd", cwd);
      const effort = r.effort ?? process.env.GROK_DEFAULT_EFFORT;
      if (effort) argv.push("--reasoning-effort", effort);
      if (r.noSubagents) argv.push("--no-subagents"); // disable fan-out (deterministic single agent)
      // Opt-in read-only (r.readOnly). Default is unchanged: no --sandbox → grok's
      // `off` profile — no sandbox, full read+write+network (xai-grok-shell config.rs
      // resolve_profile falls back to "off").
      // grok 1.0.0 has THREE different failure modes here — do not collapse them:
      //  (a) STARTUP is fail-CLOSED, on Linux/macOS only. read-only enforces hook write-deny
      //      (profile_enforces_hook_write_deny is true for everything except
      //      devbox/off — hook_write_deny.rs:19-21, lib.rs:49-60), so on Linux
      //      requires_bwrap is TRUE (shell config/mod.rs:1486) and grok re-execs
      //      under bwrap. Missing/failing bwrap, an unpreparable hook plan, or an
      //      unappliable macOS Seatbelt profile print "Refusing to start …" and
      //      exit(1) (config/mod.rs:1495-1504 / 1524-1529 / 1549-1562).
      //      => bubblewrap is a de-facto prerequisite on Linux; classifyError
      //      buckets that refusal as "config" so the user sees why.
      //  (b) ENFORCEMENT is still fail-OPEN. bwrap binds `/` READ-WRITE
      //      (lib.rs:319) and only ro-binds the protected paths (lib.rs:322, hook
      //      leaves hook_write_deny.rs:359) — it is not the no-write layer. Landlock is,
      //      and when it is unsupported or fails to apply SandboxManager::apply
      //      warns "continuing without sandbox" and returns Ok with applied=false
      //      (lib.rs:194+201, 225+232). The refusal that would catch that is
      //      skipped once we are inside bwrap (`&& !is_inside_bwrap()`,
      //      config/mod.rs:1551-1553) — and read-only ALWAYS is. So on a kernel
      //      without Landlock the workspace stays writable, with --always-approve
      //      auto-answering tool prompts.
      //  (c) WINDOWS: for a fresh (or same-profile) session, no sandbox at all and
      //      no refusal either. `apply` is a stub for
      //      `cfg(not(all(feature="enforce", unix)))` that just logs and returns Ok
      //      (lib.rs:236-243), and the whole refusal block is `cfg(any(linux,
      //      macos))` (config/mod.rs:1535/1546). Upstream ships Windows binaries
      //      (README), so there `--read-only` starts happily and enforces nothing.
      //      The ONE Windows exit(1) is the resume-conflict check below — it is
      //      pure flag-vs-saved-profile comparison with no cfg gate
      //      (resolve_startup_sandbox, cli.rs:1006; handled main.rs:1948), so it
      //      fires on every OS.
      // Net: `--read-only` can refuse to start, and can silently not prevent
      // writes. Both are why it is opt-in rather than a codex/antigravity-style
      // default. A managed requirements.toml profile also still outranks the flag
      // (resolve_profile precedence requirement > CLI > env > config > "off").
      // It blocks FS writes + CHILD-process network only; grok's in-process
      // web_search/web_fetch stay online, so read-only does NOT break web research.
      // --always-approve still auto-answers read prompts. On resume grok exit(1)s if
      // this conflicts with a session's *persisted* profile (SandboxStartup::Conflict);
      // a legacy session with no saved profile just applies read-only.
      // Anchors + the full mechanism live in docs/grok-cli-contract-audit.md Part 3.
      if (r.readOnly) argv.push("--sandbox", "read-only");
      // Opt-in research mode (r.research): swaps the built-in toolset for a curated
      // read/search set. `--tools` AUTHORITATIVELY replaces the agent's tool
      // definition (CliAgentOverrides.tools → apply_to_definition overwrites
      // def.tools outright, xai-grok-shell/src/agent/config.rs:1649-1650; subagents
      // get the session-clamped variant, config.rs:1666-1667) — every non-listed built-in tool (shell, edit,
      // write, read, …) simply does not exist for this run, a harder guarantee than
      // `--sandbox read-only`'s best-effort FS enforcement. Hosted tools gate through
      // the SAME allowlist (hosted_tool_allowed, xai-grok-agent/src/config.rs:1349-
      // 1357; canonical names builder.rs:1175-1182, HostedTool::XSearch=>"x_search",
      // sampling-types/conversation.rs:495) — hence x_search/web_search/web_fetch.
      // MCP tools are a SEPARATE, weaker layer: headless always loads the user's MCP
      // servers regardless of `--tools` (headless.rs) and nothing in source
      // proves the whitelist covers them, so `--deny MCPTool` (cli.rs:476-482) rides
      // along as a COOPERATIVE backstop — same permission-layer tier as Part 3's
      // `--deny` rows, not a hard guarantee like the built-in whitelist above.
      if (r.research) argv.push("--tools", "x_search,web_search,web_fetch", "--deny", "MCPTool");
      // Opt-in agent-turn ceiling (r.maxTurns) — a runaway-cost fuse, chiefly for
      // background jobs nobody is watching live. cli.rs:684-689: value_parser u32
      // range 1.. ("Maximum number of agent turns") → CliAgentOverrides.max_turns.
      // The companion validates it's a positive integer
      // before a job record is even created.
      if (r.maxTurns) argv.push("--max-turns", String(r.maxTurns));
      // Opt-in r.noMemory: skip cross-session memory for a one-off delegated task
      // so the result stays reproducible and never reads/writes the user's grok
      // memory. `--no-memory` (cli.rs:664-670, now hide=true and relabelled
      // "Legacy compatibility flag") is TUI/ACP-ONLY in this build and does NOT
      // reach headless: PagerArgs::memory_enabled_override() is consumed only by
      // the interactive ConnectFlags literal (app/mod.rs:798-799), and `-p`
      // dispatches headless::run_single_turn, which hardcodes
      // `memory_enabled_override: None` (headless.rs:795) — HeadlessOptions has no
      // memory field at all. Memory then resolves through
      // BoolFlag::env("GROK_MEMORY").cli(None).config(memory.enabled)
      // .feature_flag(remote).default(false) (config-types/memory.rs:607-612),
      // precedence requirement > cli > env > config > managed > remote > default
      // (config-types/flags.rs:118-135). So the env tier is the ONLY one that can
      // beat a user's `[memory] enabled = true`, and upstream's own test pins it
      // ("GROK_MEMORY=0 should force-disable even when TOML enables memory",
      // shell/src/config/tests.rs:283). Keep the flag too — it costs nothing and
      // covers upstream ever wiring it through.
      if (r.noMemory) argv.push("--no-memory");
      // r.sessionId is minted client-side BEFORE spawn (grok-companion.mjs
      // startJob, via crypto.randomUUID()) and persisted into the job record's
      // request BEFORE createJob writes it to disk — so a worker crash mid-run
      // (no `end` event, extractResult's post-hoc sessionId never captured)
      // still leaves a resumable id (see resolveResumeSource's request.sessionId
      // fallback). New-conversation only: cli.rs:588-594 documents `-s`/`--session-id`
      // as "a specific session UUID for a NEW conversation", invalid combined
      // with `--resume` unless `--fork-session` is also given (we never pass
      // that). Always mutually exclusive with resumeSessionId; resume wins when
      // (in principle) both are set. Consequence we accept today: a resume chain
      // is linear and rewrites the parent's session — see the audit doc Part 4.
      if (r.resumeSessionId) argv.push("-r", r.resumeSessionId);
      else if (r.sessionId) argv.push("-s", r.sessionId);
      // env: conformance/e2e can inject via request.env; secrets are NOT set here.
      // GROK_MEMORY goes LAST so it also beats a GROK_MEMORY=1 in the user's shell
      // (buildEngineEnv applies invocation.env after baseEnv, core/env.mjs:20-31);
      // "0" is an accepted false token (xai-grok-config/src/lib.rs:84-92 env_bool).
      return {
        argv,
        env: { ...(r.env ?? {}), ...(r.noMemory ? { GROK_MEMORY: "0" } : {}) },
        stdinPayload: null,
      };
    },
    parseEvent(line) {
      if (jsonMode) {
        // Buffer the single non-streaming result object; only attempt a parse on
        // a line that closes an object (cheap — the final line is a bare `}`).
        jsonBuf += line + "\n";
        if (!line.trimEnd().endsWith("}")) return null;
        let obj;
        try { obj = JSON.parse(jsonBuf.trim()); } catch { return null; }
        jsonBuf = "";
        if (obj?.type === "error") {
          return { kind: "error", message: typeof obj.message === "string" ? obj.message : "" };
        }
        // A --json-schema run whose model answered in prose instead of schema-valid
        // JSON still EXITS 0; grok signals it only by stamping structuredOutput:null
        // + structuredOutputError ("model did not produce structured output"). Without
        // catching it the job is recorded `completed` and resultText is the un-schema'd
        // prose — a caller parsing it as JSON fails far from the cause.
        // Flag it on the json event rather than returning kind:"error": an error event
        // would throw away sessionId and usage, leaving the job unresumable and its
        // cost unrecorded. extractResult turns the flag into ok:false.
        return {
          kind: "json",
          text: typeof obj?.text === "string" ? obj.text : "",
          structured: obj?.structuredOutput ?? null,
          structuredError: typeof obj?.structuredOutputError === "string"
            ? obj.structuredOutputError
            : null,
          stopReason: obj?.stopReason ?? null,
          sessionId: typeof obj?.sessionId === "string" ? obj.sessionId : null,
          usage: normalizeUsage(obj?.usage),
        };
      }
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return null; // junk — tolerate, never fatal
      }
      if (event.type === "text") {
        return { kind: "text", text: typeof event.data === "string" ? event.data : "" };
      }
      if (event.type === "end") {
        return {
          kind: "end",
          sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
          stopReason: event.stopReason ?? null,
          usage: normalizeUsage(event.usage),
        };
      }
      // grok emits {type:"error",message} on stdout for bad model / bad effort /
      // no-auth etc. (verified against 0.2.93). Capture it so the failure message
      // survives even when nothing lands on stderr.
      if (event.type === "error") {
        return { kind: "error", message: typeof event.message === "string" ? event.message : "" };
      }
      return null; // thought / tool / anything else → raw line stays in the log
    },
    extractResult(events, exitCode) {
      const errored = events.some((e) => e.kind === "error");
      const jsonEvent = events.find((e) => e.kind === "json");
      if (jsonEvent) {
        // Structured-output mode: prefer grok's JSON string (`.text`); fall back
        // to serializing the parsed `.structuredOutput`. No sentinel stripping —
        // the schema already constrains the answer.
        const structuredText = jsonEvent.text
          || (jsonEvent.structured != null ? JSON.stringify(jsonEvent.structured, null, 2) : "");
        // grok exits 0 even when it produced no schema-valid output, so the exit
        // code cannot carry this failure — gate on the flag. sessionId/usage are
        // preserved so the job stays resumable and its cost recorded, and `error`
        // carries the reason to the job record: without it the worker would fall
        // back to the empty stderr tail and persist "engine exited nonzero" on a
        // job whose exit code was 0 (see shared adapter-api.md).
        const structuredFailed = typeof jsonEvent.structuredError === "string";
        return {
          ok: exitCode === 0 && !errored && !structuredFailed,
          resultText: structuredFailed || !structuredText.length ? null : structuredText,
          sessionId: jsonEvent.sessionId,
          usage: jsonEvent.usage ?? null,
          ...(structuredFailed ? { error: jsonEvent.structuredError } : {}),
        };
      }
      const end = events.find((e) => e.kind === "end");
      const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
      // Sentinels present (fan-out with the task.md contract) → keep only the
      // fenced final report, dropping leaked subagent chatter. Absent (single
      // agent, or caller didn't opt in) → full text, unchanged. Either way the
      // full raw stream is still in the job log for `/grok:logs`.
      const clean = extractFinalReport(text);
      return {
        // Trust the exit code + a terminal `end` event; do NOT gate on the exact
        // stopReason. grok exits nonzero on real failures (cancelled/max-turns,
        // bad model/effort), so exitCode already rejects those — over-constraining
        // on stopReason==="end_turn" wrongly failed legitimate non-end_turn ends
        // (e.g. max_tokens) that still carried a full answer. A stdout error event
        // also fails it. Wire tokens are snake_case as of grok 1.0.0
        // (end_turn|max_tokens|max_turn_requests|refusal|cancelled — headless.rs
        // stop_reason_wire); nothing here compares them, which is why that
        // upstream rename was a non-event for this adapter.
        ok: exitCode === 0 && Boolean(end) && !errored,
        resultText: clean.length ? clean : null,
        sessionId: end?.sessionId ?? null,
        usage: end?.usage ?? null, // {inputTokens, outputTokens} from the `end` event
      };
    },
    classifyError(stderrTail, exitCode) {
      const s = String(stderrTail ?? "");
      // FIRST, above even the refusal phrase: the CANONICAL spawn-throw shape. What
      // classifyError gets on a spawn failure is Node's own message verbatim
      // (`spawn /opt/relay/grok ENOENT` — state.spawnError, runtime/worker.mjs), and it
      // embeds a user-controlled PATH, so ANY later regex can steal a missing binary — the
      // refusal matcher below included (`GROK_BIN=/tmp/refusing to start/grok`). Matching
      // the whole one-line shape rather than a bare token is what makes this safe to put
      // first: refusal PROSE that merely mentions such a path is multi-line and/or does not
      // end in ENOENT, so it stays with the refusal bucket where it belongs (no /m flag,
      // deliberately). exit-127 / "command not found" stay BELOW the refusal — they are
      // shell prose, not this shape.
      if (/^spawn .*ENOENT$/i.test(s.trim())) return "not-installed";
      // SECOND: grok's sandbox startup refusal. The phrase is
      // unambiguous (grok prints it only from refuse_unprotected / the macOS gate),
      // and it has to outrank every generic bucket because the refusal text embeds
      // user-controlled paths verbatim — a configured hooks-path of `/tmp/quota`,
      // `/srv/relay` or `/opt/ENOENT` would otherwise be classified
      // `quota` / `endpoint` / `not-installed`
      // (HookWriteDenyError::MissingConfigured, hook_write_deny.rs:27-31).
      if (/refusing to start/i.test(s)) return "config";
      // THIRD: the remaining spawn-level evidence — exit 127 and shell "command not
      // found". Same reasoning as the ENOENT shape above (the binary never executed, so no
      // later bucket's claim about grok's behaviour can be true), and still ahead of every
      // prose bucket because this text too can embed a user-controlled PATH: any bucket
      // whose regex matches a substring of the path steals a missing binary. The bare
      // `relay` token that used to sit in `endpoint` did exactly that;
      // it is gone (grok only ever says "relay" about session-SHARE connections —
      // extensions/notification.rs:1214-1225, "Status updates for relay sync (session
      // sharing) feature" — never in headless failure prose).
      if (exitCode === 127 || /command not found|ENOENT/i.test(s)) return "not-installed";
      // Buckets widened against real grok 0.2.93 failure strings (verified by running).
      // `authenticat` (not `authenticate`) so grok's own "Authentication temporarily
      // unavailable" lands here instead of falling through to `unknown`: the endpoint
      // bucket deliberately requires the FULL "grok is temporarily unavailable" so it
      // cannot steal this string, which left nobody catching it. It names the right
      // subsystem even though the failure is transient — `errorKind` is a label, not a
      // retry signal (only render.mjs and the job record read it).
      // `forbidden` / HTTP 403 is deliberately NOT here. Upstream says so in as many
      // words: "403 Forbidden is NOT an auth error — the request was authenticated, but
      // the action is not permitted (content-safety blocks, ZDR-gated operations,
      // remote-settings-blocked users)" (xai-grok-shell/src/sampling/error.rs:127-136,
      // which maps it to internal_error precisely so the client does not run its
      // re-auth flow), and xai-grok-sampling-types/src/error.rs:1206-1217 pins it with a
      // regression test ("403 Forbidden must not be treated as an auth error"). Sending
      // a policy denial here would tell the user to fix a login that is already fine.
      if (/401|unauthorized|not logged in|no cached credentials|waiting for authorization|XAI_API_KEY|authenticat|token expired|grok login|sign in/i.test(s)) return "auth";
      // quota also owns the ONE 403 that is an entitlement limit rather than a policy
      // denial: "The model 'grok-build' requires a Grok subscription."
      // (xai-grok-shell/src/sampling/error.rs:696) — the message upstream special-cases
      // at :134. The fix is to get the plan, which is a quota story, not "change the
      // request". If the user ALSO has an API key set, upstream appends "You have an API
      // key set (XAI_API_KEY) … run `grok logout`" (error.rs:134-141) and the auth bucket
      // above claims that variant first — correct: there the fix really is auth state.
      if (/429|too many requests|rate limit|usage limit|quota|requires a grok subscription/i.test(s)) return "quota";
      // endpoint BEFORE config, deliberately: grok's resume-failure prose EMBEDS the
      // transport failure that caused it ("Failed to restore session from remote: Grok
      // is temporarily unavailable. (HTTP 503)"), and that run failed because the
      // endpoint was down, not because the user named a bad session. The swap costs
      // config nothing: classifyError sees ONE source (spawnError || adapter error ||
      // stderrTail, runtime/worker.mjs), and every config token below is a local
      // decision grok makes without a request — none can co-occur with 5xx prose.
      // grok is a Rust CLI, so its capacity/5xx/transport failures arrive as PROSE,
      // not as Node/undici codes — the codes are kept because they still cover a
      // spawn-level failure in this process. Verified strings (all present in the
      // shipped 1.0.5 binary): sampling-types/error.rs:593-617 status_user_message
      // ("Grok is temporarily unavailable … (HTTP 502)", "Grok is temporarily
      // overloaded … (HTTP 529)", "Connection to Grok timed out or was interrupted
      // … (HTTP 520)", "Secure connection to Grok failed. (HTTP 525)", "Something
      // went wrong on the server (HTTP 500)"); shell/sampling/error.rs:101
      // OVERLOADED_USER_MESSAGE ("Model is temporarily overloaded. Try again in a
      // moment."); :119-121 ("http client init failed: {e}");
      // sampling-types/error.rs:179 ("reqwest error stream: …").
      // Two constraints, both load-bearing:
      //  - the FULL phrase "grok is temporarily unavailable", never a bare
      //    "temporarily unavailable": the binary also carries "Authentication
      //    temporarily unavailable" (app/error_display.rs:230). The auth bucket DOES
      //    catch that one (`authenticat` matches it case-insensitively) and runs
      //    first, so this is now belt-and-braces — keep it anyway: the short token
      //    would swallow any other "<subsystem> temporarily unavailable" prose too.
      //  - grok's idle timeout ("No response from model for {n}s — the model may
      //    be stuck", shell/sampling/error.rs:181) is deliberately LEFT OUT: the
      //    `timeout` kind already has an owner (the worker's wall-clock fuse,
      //    runtime/worker.mjs), and upstream calls this one NOT retryable, so
      //    labelling it `endpoint` ("transport, try again") would mislead.
      // Ordering is safe: auth (HTTP 401) and quota (HTTP 429) are checked above
      // and `HTTP 5\d\d` cannot collide with either.
      if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(s)) return "endpoint";
      if (/grok is temporarily unavailable|temporarily overloaded|connection to grok timed out|secure connection to grok failed|something went wrong on the server|HTTP 5\d\d|http client init failed|reqwest error stream/i.test(s)) return "endpoint";
      // "model did not produce structured output" — a --json-schema run the model
      // could not satisfy. Actionable in the same way a bad model id is: simplify
      // the schema or change the model, so it belongs in the config bucket.
      // A failed `-r` resume also lands here — same shape of fix (pick a real
      // session or start fresh). "Failed to restore session from remote"
      // (app/session_startup.rs:1285/1288) is the primary token; "Session does not
      // exist" (headless.rs:559) is the local miss. Both only reach this line when the
      // same text carried no transport evidence (endpoint is checked above).
      // Deliberately NOT matched: "not found locally, restoring conversation from
      // remote" (session_startup.rs:1134) — grok prints that even when the restore
      // SUCCEEDS, so matching it would relabel any later failure in the same run.
      // Last token: a 403 policy denial (see the auth bucket for why it is not auth).
      // `config` is the closest honest bucket — the request as written is not permitted,
      // so the fix is to change the request (rephrase the prompt, drop the ZDR-gated
      // operation). Matching `forbidden` and `HTTP 403` rather than a bare `403` keeps
      // it off ordinary numbers in paths and ports; the entitlement 403 was already
      // claimed by quota above.
      if (/unknown model id|unknown effort level|did not produce structured output|failed to restore session from remote|session does not exist|forbidden|HTTP 403/i.test(s)) return "config";
      // Weaker sandbox signals, deliberately LAST: unlike "Refusing to start" above,
      // these words also occur in ordinary paths and hostnames (a relay host named
      // bubblewrap; GROK_BIN=/opt/bwrap/grok, though that one is now caught as
      // `not-installed` two checks up), so every earlier bucket is a more specific
      // claim. This is the belt-and-braces net for a refusal whose wording changes
      // upstream — the five shapes we know today all carry "Refusing to start".
      if (/bwrap|bubblewrap|write-deny|sandbox profile|sandbox deny/i.test(s)) return "config";
      return "unknown";
    },
    resumeArgs(sessionId) {
      return ["-r", sessionId];
    },
  };
}
