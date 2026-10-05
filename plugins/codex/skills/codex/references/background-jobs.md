# Following a background job

Launch with `--background --json`; the payload's `jobId` is the handle. Then run this loop as
**one background Bash command** (a single `wait` ends at its own timeout and leaves nobody
waiting). It returns on a terminal exit code, or after 30 minutes with the job still running,
and prints the last code. The last `wait` report is in `${TMPDIR:-/tmp}/codex-wait.out`.

```bash
start=$SECONDS; while :; do code=0; node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait <jobId> --timeout-ms 100000 > "${TMPDIR:-/tmp}/codex-wait.out" || code=$?; [ "$code" -ne 10 ] && break; [ $((SECONDS - start)) -ge 1800 ] && break; done; echo "wait exit: $code"
```

| Exit | Meaning |
| --- | --- |
| `0` | completed: `result <jobId>` prints the answer to relay |
| `1` | failed (including the time cap below) |
| `2` | cancelled |
| `10` | still running: the wait timed out, the job did not fail |

A one-off foreground `wait <jobId> --timeout-ms 100000` returns the same codes; keep the
timeout under the Bash call's own (2 minutes by default). Bare `wait` waits 4 minutes.

## At `wait exit: 10` (30-minute check-in)

Run `status <jobId>` and compare it with the previous check-in (at the first one, judge by
`Last activity` alone).

- `Progress` moved, or `Last activity` is recent: it is working. Rerun the loop; a one-line
  progress note to the user is enough.
- No new `Progress`, `Last activity` marked `no log output; process may be stuck`, or the same
  step repeating: tell the user what `status` shows and offer `cancel <jobId>`, and rerun the
  loop while they decide. Never cancel unless the user says to.

## Time cap

A job still running after 3 hours is stopped and recorded as failed. Only a dead job is reaped
sooner, so a stuck-but-alive one runs to the cap; that is why you check in. To allow longer (or
a tighter cap), set `CODEX_JOB_TIMEOUT_MS` (milliseconds) in the environment you launch the job
from.

## Rules

- Finished means `Status` (`--json`: `job.status`) is no longer `queued` or `running`. `Phase`
  is a progress label: never decide completion from it. Prefer `wait`'s exit code.
- Do not pipe companion output into `head` or `tail`; redirect it to a file and read the file.
