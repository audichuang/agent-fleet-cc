# Following a background job

1. Launch with `--background --json`. The payload's `jobId` is the handle.
2. Run `wait <jobId> --timeout-ms 100000`. Keep the timeout under the Bash call's own
   (2 minutes by default); `wait` alone waits 4 minutes. To be told when the job ends instead
   of looping, run the same `wait` as a background Bash command; its exit is the notification.
3. Read `wait`'s exit code:

   | Exit | Meaning |
   | --- | --- |
   | `0` | completed |
   | `1` | failed |
   | `2` | cancelled |
   | `10` | still running: the wait timed out, the job did not fail. Run `wait` again. |

4. After `0`, `result <jobId>` prints the answer to relay.

## Telling a finished job

A job is finished when its `Status` (`--json`: `job.status`) leaves `queued` or `running`.
`Phase` is a progress label, not an end state: never decide completion from it.
`wait`'s exit code already says all of this, so prefer it to parsing `status` output.

## Output

Do not pipe companion output into `head` or `tail`. Redirect it to a file and read the file.
