/**
 * Small shared text helpers used by the worker and job-helpers (deduped).
 */

/** First non-empty line of agy's output, truncated to 120 chars, or null. */
export function deriveSummary(stdout) {
  if (typeof stdout !== "string") return null;
  const firstLine = stdout.split("\n").map((s) => s.trim()).find(Boolean);
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

/** Trim a string; return null when it is missing or blank. */
export function trimToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
