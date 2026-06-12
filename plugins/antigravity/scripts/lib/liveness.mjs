/**
 * liveness — pure classification + escalate-not-kill gate for the background-job
 * watchdog (see scripts/commands/_watchdog.mjs).
 *
 * Design notes (ported from codex-plugin-cc, adapted for agy which has no
 * broker/ACP):
 *  - A DEAD worker (pid gone) or a job that blew past its own hard deadline is
 *    actionable. Mere silence is NOT fatal: agy `--print` can legitimately work
 *    for minutes without emitting, and the worker already carries its own hard
 *    timeout (resolveAgyTimeouts), so the watchdog only needs to catch the cases
 *    that the worker's in-process timer cannot — a crashed/SIGKILL'd worker, or
 *    a wedged worker whose own timer never fired.
 *  - Escalate-not-kill: a verdict must repeat for `confirmRounds` consecutive
 *    ticks before the watchdog terminates, and any HEALTHY tick resets the
 *    counter, so a transient probe glitch never false-kills a working job.
 */

export const LIVENESS_DEFAULTS = {
  intervalMs: 30000, // 30s between ticks
  confirmRounds: 2, // consecutive bad verdicts before terminate
  deadlineGraceMs: 60000, // slack past the job's own deadline before calling it hung
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * @param {{status: string, workerAlive: boolean, nowMs: number, deadlineMs: number|null}} obs
 * @returns {'DONE'|'DEAD'|'HUNG'|'HEALTHY'}
 */
export function classifyLiveness(obs, config = LIVENESS_DEFAULTS) {
  if (TERMINAL.has(obs.status)) return "DONE";
  if (obs.workerAlive === false) return "DEAD";
  if (
    Number.isFinite(obs.deadlineMs) &&
    Number.isFinite(obs.nowMs) &&
    obs.nowMs > obs.deadlineMs + config.deadlineGraceMs
  ) {
    return "HUNG";
  }
  return "HEALTHY";
}

/**
 * Stateful gate that requires `confirmRounds` consecutive non-healthy verdicts
 * before recommending termination.
 */
export function createLivenessGate(config = LIVENESS_DEFAULTS) {
  let consecutiveBad = 0;
  return {
    assess(obs) {
      const verdict = classifyLiveness(obs, config);
      if (verdict === "DONE") return { verdict, action: "stop" };
      if (verdict === "HEALTHY") {
        consecutiveBad = 0;
        return { verdict, action: "wait" };
      }
      consecutiveBad += 1;
      if (consecutiveBad >= config.confirmRounds) return { verdict, action: "terminate" };
      return { verdict, action: "wait" };
    },
  };
}

/** Resolve watchdog tunables from env (AGY_WATCHDOG_*). */
export function resolveLivenessConfig(env = process.env) {
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    intervalMs: num(env.AGY_WATCHDOG_INTERVAL_MS, LIVENESS_DEFAULTS.intervalMs),
    confirmRounds: num(env.AGY_WATCHDOG_CONFIRM_ROUNDS, LIVENESS_DEFAULTS.confirmRounds),
    deadlineGraceMs: num(env.AGY_WATCHDOG_DEADLINE_GRACE_MS, LIVENESS_DEFAULTS.deadlineGraceMs),
  };
}
