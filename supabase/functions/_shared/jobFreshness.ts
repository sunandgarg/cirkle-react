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

const GENERIC_JOB_PATHS = new Set([
  "career", "careers", "job", "jobs", "openings", "opportunities", "search", "vacancies",
]);

export const isLikelyJobDetailUrl = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const idParameters = ["gh_jid", "jobid", "job_id", "requisitionid", "requisition_id", "rid"];
    if (idParameters.some((parameter) => url.searchParams.get(parameter)?.trim())) return true;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
    if (segments.length < 2) return false;
    return !GENERIC_JOB_PATHS.has(segments.at(-1) || "");
  } catch {
    return false;
  }
};
