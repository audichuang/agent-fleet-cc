# Antigravity Plugin ↔ Google Antigravity CLI (`agy`) — Contract & Sync Audit

Living audit of whether the **`antigravity` plugin** (`plugins/antigravity/`) is still in sync
with the **Google Antigravity CLI** (`agy`) it shells out to. `agy` is a closed-source ~180 MB
single binary, so unlike `grok` there is **no source tree to anchor to** — the ground truth here is
the *released binary itself* (`agy --help`, `agy changelog`) plus dated real-machine runs. This
doc records what was checked, against which version, and by which evidence class, so the next
pass is a diff and not a rebuild.

> **Scope.** The plugin's dependency on `agy`'s **headless `--print` contract**: the argv it
> builds (`buildInvocation`) and the stdout/exit-code it reads (`parseEvent` / `extractResult` /
> `classifyError`) in `plugins/antigravity/scripts/lib/adapter.mjs`. **Not** a review of agy
> internals, nor of the shared job runtime (state/worker/cancel — that is `shared/lib/`).

> **Why `--print` and not ACP.** agy has **no ACP mode**: `agy --acp` → `flags provided but not
> defined: -acp`, and `--experimental-acp` is rejected too (verified on 1.0.1,
> `plugins/antigravity/docs/SPIKE-findings.md`). Third-party posts claiming agy inherits ACP from
> gemini-cli are wrong. `--print` is the only non-interactive surface, and depending on **only**
> the `agy` binary is what let this plugin outlive the June 18 2026 gemini-cli sunset.

> **Evidence classes** used in the tables below — always state which one a row rests on:
> `help` (present in `agy --help` of the baseline binary) · `changelog` (upstream release note,
> quoted + version) · `live` (we ran it against a real binary; carries a date) ·
> `inferred` (reasoned from the two above, **not** observed).

---

## How to keep this current

agy **self-updates in the background** (observed going 1.1.2 → 1.1.5 inside one session;
evidence: `~/.gemini/antigravity-cli/updater/`). So never assume the version this doc names is
the one on the machine — start every pass with step 1.

1. **Pin the version you are auditing:** `agy --version`. If it differs from the Baseline below,
   everything after this line is a claim about a *different binary*.
2. **Diff the flag surface:** `agy --help`, compared row-by-row against the `argv.push` calls in
   `scripts/lib/adapter.mjs → buildInvocation`. A flag we send that has vanished or changed its
   value-enum is `breaking`.
3. **Scan behavior changes:** `agy changelog` (grep for `headless`, `-p`, `--print`,
   `permission`, `sandbox`, `model`). This is where the contract silently moves — the flag
   surface can be stable while `--print` semantics change under it (see Part 3).
4. **List models:** `agy models` — `--model` slugs became "stable, user-facing" only at 1.1.5
   (changelog), so older pinned slugs are not guaranteed.
5. **Update** the Baseline block and append a dated row to the **Audit log**.
   **Keep the provenance of older behavioral checks.** A bare version bump silently upgrades a
   `live`-class claim to a binary it was never run against — if you did not re-run it, say so
   in the row (this is the same rule as `docs/grok-cli-contract-audit.md`).

**Severity language.** `breaking` (a flag we send would now be rejected, or output we read was
renamed/removed → silent data loss) → `should-upgrade` (adopt to match, nothing breaks) →
`cosmetic` (additive upstream, we ignore it fine) → `none`.

---

## Baseline

| What | Value |
| --- | --- |
| Plugin | `plugins/antigravity/` @ `0.6.0` |
| Binary audited | `agy 1.1.5` (`agy --version`, 2026-07-25) |
| Evidence gathered this pass | `agy --help` + `agy changelog` (full 1.1.1 → 1.1.5 read) — **no live `--print` run** in this pass |
| Prior live verification | 1.1.5 real-machine, 2026-07-22: no-`--apply` does not touch the job cwd; `--apply` writes into it. 1.1.2 real-machine: `--sandbox` does not stop `write_file`, and a global `deny: write_file(*)` did not either (**superseded — see Part 3**). 1.0.14: `--print` is plain text, `"OK\n"`, exit 0. 1.0.1: no ACP. |
| Contract surface | `scripts/lib/adapter.mjs` (`buildInvocation` / `parseEvent` / `extractResult` / `classifyError`) |
| Verdict | **none** on flags and output — every flag we send is present in 1.1.5 `--help` with matching semantics. One **open item**: Part 3's 1.1.2 write-guard observation is contradicted by the 1.1.5 changelog and has not been re-run. |

---

## Part 1 — Flags we send (durable checklist)

Built by `adapter.mjs → buildInvocation`, in this order. Every row confirmed present in
`agy --help` @ 1.1.5 unless noted.

| We send | When | 1.1.5 `--help` says | Evidence |
| --- | --- | --- | --- |
| `--continue` | `request.mode === "continue"` | "Continue the most recent conversation" | help |
| `--conversation <id>` | `mode === "conversation"`; also `resumeArgs()` | "Resume a previous conversation by ID" | help |
| `--model <id>` | `request.model` set | "Model for the current CLI session" | help |
| `--sandbox` | `request.sandbox` (review / adversarial-review default **on**) | "Run in a sandbox with **terminal restrictions** enabled" — note: terminal, not files (Part 3) | help |
| `--new-project --mode accept-edits` | `request.write` (`--apply`) | "Create a new project for this session" / "Set the agent execution mode (accept-edits, plan)" | help |
| `--dangerously-skip-permissions` | `request.skipPermissions` (gated behind `write`) | "Auto-approve all tool permission requests without prompting" | help |
| `--print-timeout <Ns>` | always (`toGoDuration`, Go duration string) | "Timeout for print mode wait (**default 5m0s**)" — matches `DEFAULT_PRINT_TIMEOUT_MS = 300000` | help |
| `--add-dir <path>` | per `request.addDirs` entry | "Add a directory to the workspace (**repeatable**)" | help |
| `--print <prompt>` | always, **last**; prompt is an argv **operand** | "Run a single prompt non-interactively and print the response" | help + live (bare `--print` → exit 2 `flag needs an argument: -print`) |
| `--version` | `probeAgy` only | **absent from `--help`** yet works (returned `1.1.5`) | live 2026-07-25 |

**Invariants worth not breaking**

- **`stdinPayload: ""`** — agy does not read the prompt from stdin, and since 1.1.1 explicitly
  does not read stdin at all when a prompt came from a flag ("Fixed `agy -p` hanging when run
  inside a shell script or subprocess by no longer reading stdin when a prompt is provided via a
  flag"). `runWorker`'s `stdin.end()` + EPIPE-on-exit-0 guard makes the empty closed stdin
  harmless. Do not start piping the prompt.
- **`--print-timeout` ≤ the Node backstop** (D-19, `resolveAgyTimeouts` clamps
  `hardMs = max(printMs + 60s, printMs)`): the engine must time out first, with its own clean
  error, before our hard kill.
- **`--mode` has a second value we never send** (`plan`). If a future verb wants a plan-only
  pass, that is the flag — not a prompt convention.

---

## Part 2 — Output we read (durable checklist)

| We read | Contract | Evidence |
| --- | --- | --- |
| stdout | **Plain text, no JSON event stream.** `parseEvent` emits one `{kind:"line"}` per line **including blank lines** so paragraph breaks survive (D-1); `extractResult` joins with `\n` and edge-trims only. | live 1.0.14 |
| `sessionId` | **Always `null`** — agy exposes no conversation id on stdout (D-2). Resume rides `--continue` / `--conversation`, never a session id. | live + help |
| `usage` | Always `null` — agy prints no usage object in `--print`. | live 1.0.14 |
| exit code | `ok = exitCode === 0 && no auth sentinel in the stdout tail`. Since **1.1.1** a server-side failure is no longer a false success ("Fixed print mode silently exiting with a success code and empty output when a request failed server-side, now writing the error to stderr and returning a non-zero exit code") — so exit 0 is meaningfully trustworthy at ≥1.1.1. | changelog 1.1.1 |
| auth failure | `AUTH_PATTERN` is checked on **both** channels — `stderrTail` (`classifyError`) and the joined stdout tail (`extractResult`) — because agy has printed auth prompts to stdout (D-3). Since **1.1.2** a truly headless run "fail[s] fast with an actionable message instead of blocking". | live + changelog 1.1.2 |
| `classifyError` buckets | `auth` → `endpoint` → `not-installed` → `unknown`. **Unresolvable `--model` lands in `unknown`**: since 1.1.2 print mode "hard-fail[s] with a non-zero exit and list[s] the available models" instead of silently downgrading. If that message ever needs its own bucket, add it here first. | changelog 1.1.2 |

---

## Part 3 — Read-only / write posture (`--apply` WIRED opt-in; read-only **not** guaranteed)

Two separate things, routinely conflated:

**(a) Writing is opt-in and it works.** The adapter sends **no** write flag by default —
rescue/task are "text in, text out". `--apply` sends `--new-project --mode accept-edits`:
`--new-project` binds the job cwd as the agy workspace, `accept-edits` auto-applies edits.
Without it, agy 1.1's `--print` either prints a plan or writes into `~/.gemini/.../scratch`
(**not** your repo) and still exits 0 — a false success. `--dangerously-skip-permissions` is a
second opt-in, gated behind `--apply`, because `accept-edits` auto-approves *edits* only and a
task that also runs commands would still prompt and stall headless.
*Verified live on 1.1.5, 2026-07-22: no-apply does not touch the job cwd; `--apply` writes.*

**(b) Read-only is best-effort, by prompt.** `review` / `adversarial-review` are read-only
**by instruction** — the prompt says "Do NOT modify files". There is no per-run hard guard:

- **`--sandbox` is not a write guard.** It is an OS *terminal* container (nsjail; settings key
  `enableTerminalSandbox`). It does apply in headless — `--help` itself says "terminal
  restrictions" — but it fences **shell commands, not `write_file`**, and the model can select
  `BypassSandbox: true`. We still pass it by default for terminal friction; `--no-sandbox` opts
  out. Do **not** describe it to users as read-only.
- **1.1.2 observation (now superseded, do not cite):** even a real global
  `deny: write_file(*)` was observed **not** to stop writes under `--print` — the fine-grained
  permission allow/deny/ask flow appeared to be interactive-TUI-only.
- **What changed since.** 1.1.3: "headless (`-p`) runs … now **soft-den[y]** such tools and
  print a stderr notice naming the allow-rule needed". 1.1.5: "Fixed headless (`-p` / `--print`)
  runs so they now **honor persisted `settings.json` policies, including `permissions`, file
  access, sandbox mode**, auto-execution, and artifact review." So on ≥1.1.5 a *persisted*
  policy plausibly **does** bind headless writes.
- **The plugin-side conclusion is nonetheless unchanged:** `settings.json` is **global,
  persisted** user state, not a per-run lever. Honoring it does not give *this* review run a
  read-only guarantee unless we mutate the user's global config — which we will not do. Until
  upstream ships per-run permissions, review's read-only stays prompt-only best-effort.

**Open item (next pass):** re-run the deny test on ≥1.1.5 (global `deny: write_file(*)` + a
`--print` run told to write a file) and record the result here. Until then the 1.1.2 row is
`live`-but-stale and the 1.1.5 rows are `changelog`-only.

---

## Part 4 — Engine surfaces we deliberately do NOT wire (yet)

Present in `agy --help` @ 1.1.5, unused by the adapter. Recorded so the next pass distinguishes
"not wired" from "not noticed".

| Surface | What it offers | Why unwired / worth revisiting |
| --- | --- | --- |
| `--effort low\|medium\|high` | Reasoning-effort variant at launch (**new in 1.1.5**, changelog) | The one real gap: `codex` and `grok` both expose effort; agy verbs currently cannot trade latency for depth. Best candidate to wire next. |
| `--agent <name>` + `agent`/`agents` subcommands | Launch as a custom agent; list them (**new in 1.1.1**, changelog) | We ship no agy-side custom agents; our roles are prompt-shaped. |
| `--mode plan` | Plan-only execution mode | Would be a cleaner "review, don't touch" than prompt instruction — but it is a *mode*, still not a write guard. |
| `--project <id>` | Bind an existing agy project | We create one per write-job with `--new-project`; reusing projects would need state we do not keep. |
| `--log-file <path>` | Override agy's own log path | We already capture stdout/stderr per job in the shared runtime. |
| `--prompt-interactive` / `-i` | Interactive initial prompt | Antithetical to headless delegation. |
| `models` / `changelog` / `update` / `plugin` subcommands | Model list, release notes, self-update, plugin management | Audit/ops tools, used by hand (see "How to keep this current"), not by the runtime. `update` especially: agy self-updates already. |

---

## Audit log

| Date | Binary | What was done | Verdict |
| --- | --- | --- | --- |
| 2026-07-25 | `agy 1.1.5` | First consolidated audit. Established this doc as the single home for agy contract findings (previously inlined in `plugins/antigravity/AGENTS.md`). Diffed all 10 sent flags against `agy --help`; read `agy changelog` 1.1.1→1.1.5 in full and dated every headless behavior change; sharpened Part 3 (1.1.2 deny observation superseded by 1.1.5 changelog, plugin-side conclusion unchanged); enumerated 7 unwired surfaces incl. the new `--effort`. **No live `--print` run this pass.** | **none** (flags/output); 1 open item in Part 3 |
| 2026-07-22 | `agy 1.1.5` | Real-machine re-verify of the write path: no-`--apply` leaves the job cwd untouched; `--apply` writes into it. | none |
| (1.1.2 era) | `agy 1.1.2` | Live: `--sandbox` does not block `write_file`; model can set `BypassSandbox: true`; global `deny: write_file(*)` did not block writes either. | superseded by 1.1.5 changelog — needs re-run |
| 2026-05-22 | `agy 1.0.1` | Phase 1 spike: no ACP mode; flag/subcommand surface catalogued. `plugins/antigravity/docs/SPIKE-findings.md`. | none |
