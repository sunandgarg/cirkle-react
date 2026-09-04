export const safeHttpUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
};
