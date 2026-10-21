# Following a background job

## Contents

- Exit codes, the one-off `wait`, and waiting when nothing notifies you (below)
- [At `wait exit: 10` (30-minute check-in)](#at-wait-exit-10-30-minute-check-in)
- [When the job failed (`wait exit: 1`)](#when-the-job-failed-wait-exit-1)
- [When `wait` or `status` cannot find the job](#when-wait-or-status-cannot-find-the-job)
- [Time cap](#time-cap)
- [Rules](#rules)

Launch with `--background --json`. The payload's `jobId` is the handle. Then run the `wait` loop
from SKILL.md as **one background Bash command**. It prints `wait exit: <code>`, and the last
`wait` report is in `${TMPDIR:-/tmp}/codex-wait-<jobId>.out` (one file per job, so two sessions
sharing `/tmp`, as on Linux, do not overwrite each other's report).

| Exit | Meaning |
| --- | --- |
| `0` | completed: `result <jobId>` prints the answer to relay |
| `1` | failed (including the time cap below) |
| `2` | cancelled |
| `10` | still running: the wait timed out, the job did not fail |

A one-off foreground `wait <jobId> --timeout-ms 100000` returns the same codes; keep the
timeout under the Bash call's own (2 minutes by default in Claude Code). Bare `wait` waits 4 minutes.

**Nothing will tell you the background command ended** — you run as a subagent or a workflow
step (your background commands die when your turn ends), or your host has no exit notice: repeat
that foreground `wait` one call at a time, each `--timeout-ms` under the call's own timeout,
until the exit is not `10`, and only then end your turn. A host with its own tool for waiting on a
command it started can wait on the background loop with that instead. Either way this is the loop, not the polling ruled out below. A host skill that says to
debug and resubmit a failed background job does not apply to a Codex job: report it (SKILL.md).

## At `wait exit: 10` (30-minute check-in)

`${TMPDIR:-/tmp}/codex-wait-<jobId>.out` holds the last `wait` report, which is the same report as
`status <jobId>`: no extra call is needed. Each `Progress` line says how long ago it was written;
`Last activity` is the newest write to the log; `Codex session ID` is the thread id, printed once
Codex has a thread (not in the first seconds): note it, it is the handle if the job record is
ever lost (below).

- `Last activity` under 30 minutes: it is working. Rerun the loop; a one-line progress note to
  the user is enough. A `! … process may be stuck` mark alone is not a stall: it shows after
  about 2 minutes of quiet, which a long think (`Thinking.`), `Compacting context.`,
  `Sleeping …` or a running command all cause.
- Quiet for 30 minutes or more, or looping (the log at `Log:` shows the same command failing
  the same way over and over, with no file changes in between): tell the user what you saw
  (the last line and how long ago) and offer `cancel <jobId>`, and rerun the loop while they
  decide. Never cancel unless the user says to.

A long run (a UI round of hours) is several check-ins in a row. That is the design, not a
problem to work around: do not swap the loop for your own polling of files, `find -newer…`
scans or `sleep` loops. They miss the job's own state, and `find`'s time flags differ between
macOS and Linux.

## When the job failed (`wait exit: 1`)

`result <jobId>` prints the reason. Three causes are on OpenAI's side and a relaunch can clear
them; report the failure to the user either way, and never let another reviewer stand in for the
run (SKILL.md). Whatever the cause, a failed task that edits files or drives a UI may already
have done part of its work: before any relaunch below, check what changed (`git status`, the
app), tell the user, and ask Codex only for what is left. A review has nothing to repeat.

| The reason says | What it means | Then |
| --- | --- | --- |
| `flagged for possible cybersecurity risk` (`[cyberPolicy]`) | The prompt's wording tripped a content filter. No review or answer was produced, and rerunning it unchanged was refused again every time it was tried. | Reword once as a code-correctness task, describing what the code must do rather than how it could be attacked or bypassed, and relaunch. Refused again, or a built-in `review` (it has no wording to change): report, and stop. |
| `Selected model is at capacity` (`[serverOverloaded]`) | The model was overloaded. | Relaunch unchanged once, after about two minutes. |
| `app-server disconnected before the turn completed` or `app-server exited unexpectedly` | The connection to Codex dropped mid-turn. An immediate relaunch during the same outage failed again. | Relaunch once after about two minutes; if `setup` then reports a problem, report that instead. |

Other policy flags (`[misalignmentPolicyViolation]`, "biological risk") are not wording problems
to route around: report them. `Reconnecting... N/M` lines in the log are Codex retrying on its
own, not a failure.

Any other reason (auth, a usage limit, a turn error that names your prompt or repo): report it as
printed and stop. A `setup` that says to log in is the answer only after a rerun of `setup`
agrees.

## When `wait` or `status` cannot find the job

`No job found for "<id>"` for a job you launched does not prove the record is gone, nor that the
run is still going.

1. Retry with the **full** job id: `wait`, `status` and `result` look across workspaces for a
   full id, not for a prefix.
2. Retry with the launch's environment. Records live under `CODEX_COMPANION_DATA` (default
   `~/.local/state/codex-companion`); a launch that set it is found only where it pointed. The
   launch JSON's `logFile` shows which directory that was.
3. Still missing: the outcome is unknown. Say so, with the thread id from an earlier report,
   and ask the user to look at that thread (a desktop turn shows in the app). Do not report it
   as running, finished or failed.
4. Once the user has seen the thread end, collect its answer on the record with
   `task --backend desktop --thread <id>` (or `--thread <id>` alone for a CLI thread) and a
   prompt that asks for the final report. A report file the prompt had Codex write can be
   relayed too: say it came from the file, not from `result`.

Never relaunch the prompt as a fresh run: if the first one is still working, two runs on one
screen or one checkout spoil each other.

## Time cap

A job still running after 3 hours (`10800000` ms) is stopped and recorded as failed. Only a
dead job is reaped sooner, so a stuck-but-alive one runs to the cap; that is why you check in. To
allow longer, set a larger `CODEX_JOB_TIMEOUT_MS` (milliseconds) in the environment you launch
the job from; a smaller one only cuts a healthy run short. The cap is read once at launch: a running job cannot be extended. A desktop job's turn is
interrupted in the app when the cap hits.

## Rules

- Finished means `Status` (`--json`: `job.status`) is no longer `queued` or `running`. `Phase`
  is a progress label: never decide completion from it. Prefer `wait`'s exit code.
- Do not pipe companion output into `head` or `tail`; redirect it to a file and read the whole
  file. `head` or `tail` on that file truncates the report you are about to relay just the same.
