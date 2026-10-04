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

## Being told when it ends

One `wait` ends at its own timeout, so a single background `wait` is not a completion
notification: a job that outlives it leaves no one waiting. To be told instead of polling, run
the loop below as one background Bash command. It ends only on a terminal exit code and prints
that code; read it, then follow step 3. The last `wait` report is in
`${TMPDIR:-/tmp}/codex-wait.out`.

```bash
while :; do node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait <jobId> --timeout-ms 100000 > "${TMPDIR:-/tmp}/codex-wait.out"; code=$?; [ "$code" -ne 10 ] && break; done; echo "wait exit: $code"
```

## Telling a finished job

A job is finished when its `Status` (`--json`: `job.status`) leaves `queued` or `running`.
`Phase` is a progress label, not an end state: never decide completion from it.
`wait`'s exit code already says all of this, so prefer it to parsing `status` output.

## Output

Do not pipe companion output into `head` or `tail`. Redirect it to a file and read the file.
