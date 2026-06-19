import { TERMINAL_STATUSES } from "./state.mjs";

export const POLL_MS = 1000;

// Re-export the canonical set from state.mjs so wait.mjs/logs.mjs keep importing
// it from here while there remains exactly one TERMINAL_STATUSES in the plugin.
export { TERMINAL_STATUSES };

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse --timeout-ms flag value.
 * @param {string|undefined} value CLI string value or undefined
 * @param {number} defaultMs default timeout in ms
 * @returns {number} resolved timeout in ms
 * @throws {Error} if value is present but invalid
 */
export function parseTimeoutMs(value, defaultMs) {
  if (value === undefined) return defaultMs;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--timeout-ms must be a non-negative number of milliseconds");
  }
  return parsed;
}

/**
 * Poll buildSingleJobSnapshot until the job reaches a terminal status or the
 * deadline elapses.
 *
 * @param {string} cwd
 * @param {string} jobId
 * @param {number} timeoutMs
 * @param {{ buildSingleJobSnapshot?: Function }} [deps] injectable for tests
 * @returns {Promise<{ snapshot: object, timedOut: boolean }>}
 */
export async function waitForTerminal(cwd, jobId, timeoutMs, deps = {}) {
  const buildSnapshot =
    deps.buildSingleJobSnapshot ?? (await import("./job-control.mjs")).buildSingleJobSnapshot;
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  while (true) {
    snapshot = buildSnapshot(cwd, jobId);
    if (TERMINAL_STATUSES.has(snapshot.job?.status)) return { snapshot, timedOut: false };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { snapshot, timedOut: true };
    await sleep(Math.min(POLL_MS, remainingMs));
  }
}
