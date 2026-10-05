# Following a background job

1. Launch with `--background --json`. The payload's `jobId` is the handle.
2. Run `wait <jobId> --timeout-ms 100000`. Keep the timeout under the Bash call's own
   (2 minutes by default); `wait` alone waits 4 minutes.
3. Read `wait`'s exit code:

   | Exit | Meaning |
   | --- | --- |
   | `0` | completed |
   | `1` | failed |
   | `2` | cancelled |
   | `10` | still running: the wait timed out, the job did not fail. Run `wait` again. |

4. After `0`, `result <jobId>` prints the answer to relay.

## Being told when it ends, and checking in on a long one

One `wait` ends at its own timeout, so a single background `wait` is not a completion
notification: a job that outlives it leaves no one waiting. Run the loop below as one
background Bash command instead of polling. It ends on a terminal exit code, or after
30 minutes with the job still running, and prints the last code. The last `wait` report is in
`${TMPDIR:-/tmp}/codex-wait.out`.

```bash
start=$SECONDS; while :; do code=0; node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait <jobId> --timeout-ms 100000 > "${TMPDIR:-/tmp}/codex-wait.out" || code=$?; [ "$code" -ne 10 ] && break; [ $((SECONDS - start)) -ge 1800 ] && break; done; echo "wait exit: $code"
```

A terminal code goes to step 3. `wait exit: 10` is the 30-minute check-in: the job is still
running, and a job that is alive but stuck is not killed for hours (see below). Run
`status <jobId>` and compare it with the previous check-in:

- `Progress` moved on, or `Last activity` is recent: it is working. Start the loop again.
- No new `Progress` since the last check-in, a `Last activity` line marked `no log output;
  process may be stuck`, or the same step repeating: tell the user what `status` shows and
  offer `cancel <jobId>`. Cancel without asking only when the user already said to.

## How long a job may run

A background job that is still running after 3 hours is stopped and recorded as failed. That
hard cap is a backstop, not a progress check: a dead job is reaped sooner, but one that is
alive and going nowhere runs until the cap, which is why the loop above checks in. A job that
needs longer, or a session that wants a tighter cap, sets `CODEX_JOB_TIMEOUT_MS` (milliseconds)
in the environment the companion is launched from.

## Telling a finished job

A job is finished when its `Status` (`--json`: `job.status`) leaves `queued` or `running`.
`Phase` is a progress label, not an end state: never decide completion from it.
`wait`'s exit code already says all of this, so prefer it to parsing `status` output.

## Output

Do not pipe companion output into `head` or `tail`. Redirect it to a file and read the file.
