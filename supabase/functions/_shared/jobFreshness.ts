export const JOB_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const JOB_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const parseFreshJobPostedAt = (
  value: unknown,
  nowMs = Date.now(),
): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) return null;
  if (parsedMs > nowMs + JOB_FUTURE_CLOCK_SKEW_MS) return null;
  if (parsedMs < nowMs - JOB_FRESHNESS_WINDOW_MS) return null;
  return new Date(parsedMs).toISOString();
};
