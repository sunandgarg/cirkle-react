export function requestPathForLog(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || !rawUrl) return "/";
  const query = rawUrl.indexOf("?");
  const fragment = rawUrl.indexOf("#");
  const end = [query, fragment].filter((index) => index >= 0).reduce((lowest, index) => Math.min(lowest, index), rawUrl.length);
  const path = rawUrl.slice(0, end);
  return path.startsWith("/") ? path : "/";
}

export function responseForLog(response: unknown): { statusCode: number | null } {
  const candidate = response && typeof response === "object"
    ? (response as { statusCode?: unknown }).statusCode
    : null;
  return { statusCode: Number.isInteger(candidate) ? Number(candidate) : null };
}
