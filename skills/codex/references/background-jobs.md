# Following a background job

Launch with `--background --json`. The payload's `jobId` is the handle. Then run the `wait` loop
from SKILL.md as **one background Bash command**. It prints `wait exit: <code>`, and the last
`wait` report is in `${TMPDIR:-/tmp}/codex-wait.out`.

| Exit | Meaning |
| --- | --- |
| `0` | completed: `result <jobId>` prints the answer to relay |
| `1` | failed (including the time cap below) |
| `2` | cancelled |
| `10` | still running: the wait timed out, the job did not fail |

A one-off foreground `wait <jobId> --timeout-ms 100000` returns the same codes; keep the
timeout under the Bash call's own (2 minutes by default). Bare `wait` waits 4 minutes.

## At `wait exit: 10` (30-minute check-in)

Run `status <jobId>`. Each `Progress` line says how long ago it was written; `Last activity`
is the newest write to the log.

- `Last activity` under 30 minutes: it is working. Rerun the loop; a one-line progress note to
  the user is enough. A `! … process may be stuck` mark alone is not a stall: it shows after
  about 2 minutes of quiet, which a long think (`Thinking.`), `Compacting context.`,
  `Sleeping …` or a running command all cause.
- Quiet for 30 minutes or more, or looping (the log at `Log:` shows the same command failing
  the same way over and over, with no file changes in between): tell the user what you saw
  (the last line and how long ago) and offer `cancel <jobId>`, and rerun the loop while they
  decide. Never cancel unless the user says to.

## Time cap

A job still running after 3 hours is stopped and recorded as failed. Only a dead job is reaped
sooner, so a stuck-but-alive one runs to the cap; that is why you check in. To allow longer (or
a tighter cap), set `CODEX_JOB_TIMEOUT_MS` (milliseconds) in the environment you launch the job
from. The cap is read once at launch: a running job cannot be extended. A desktop job's turn is
interrupted in the app when the cap hits.

## Rules

- Finished means `Status` (`--json`: `job.status`) is no longer `queued` or `running`. `Phase`
  is a progress label: never decide completion from it. Prefer `wait`'s exit code.
- Do not pipe companion output into `head` or `tail`; redirect it to a file and read the file.
