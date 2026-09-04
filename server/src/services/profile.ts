import { ApiError } from "../lib/errors.js";

type Row = Record<string, unknown>;

export function normalizeDateOfBirth(value: unknown): Date | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, "invalid_date_of_birth", "Date of birth must use YYYY-MM-DD format");
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ApiError(400, "invalid_date_of_birth", "Date of birth is not a valid calendar date");
  }
  const today = new Date();
  const todayValue = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  if (value > todayValue) throw new ApiError(400, "invalid_date_of_birth", "Date of birth cannot be in the future");
  return date;
}

export function dateOnly(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

export function serializeProfile<T extends Row | null>(profile: T): T {
  if (!profile) return profile;
  return { ...profile, date_of_birth: dateOnly(profile.date_of_birth) } as T;
}

export function normalizeHttpUrl(value: unknown, label = "URL"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new ApiError(400, "invalid_external_url", `${label} must be a valid http(s) URL`);
  }
  try {
    const url = new URL(value.trim());
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || !url.hostname) throw new Error("unsafe URL");
    return url.toString();
  } catch {
    throw new ApiError(400, "invalid_external_url", `${label} must be a valid http(s) URL`);
  }
}

export function normalizeSocialLinks(value: unknown): Row {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_social_links", "Social links must be an object");
  const entries = Object.entries(value as Row);
  if (entries.length > 20) throw new ApiError(400, "invalid_social_links", "Too many social links were supplied");
  const normalized: Row = {};
  for (const [key, link] of entries) {
    const standardKey = /^[a-z][a-z0-9_-]{0,39}$/i.test(key);
    const customLabel = key.startsWith("custom:") ? key.slice("custom:".length) : "";
    const customKey = customLabel.length >= 1 && customLabel.length <= 40 && !customLabel.includes(":")
      && [...customLabel].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 32 && codePoint !== 127;
      });
    if (!standardKey && !customKey) throw new ApiError(400, "invalid_social_links", "A social-link name is invalid");
    if (link == null || link === "") { normalized[key] = null; continue; }
    normalized[key] = normalizeHttpUrl(link, `${key} link`);
  }
  return normalized;
}
