export type BlogVisibilityRecord = {
  published?: unknown;
  status?: unknown;
  scheduled_at?: unknown;
};

/** Scheduled articles become readable when due, without a browser-side job. */
export const isBlogLive = (blog: BlogVisibilityRecord, now = Date.now()): boolean => {
  if (blog.published !== true) return false;
  const status = typeof blog.status === "string" ? blog.status : "published";
  if (status === "draft" || (status !== "published" && status !== "scheduled")) return false;
  if (blog.scheduled_at == null || blog.scheduled_at === "") return status === "published";
  const scheduledAt = new Date(String(blog.scheduled_at)).getTime();
  return Number.isFinite(scheduledAt) && scheduledAt <= now;
};
