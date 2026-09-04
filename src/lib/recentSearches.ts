const RECENT_SEARCH_PREFIX = "cirkle:recent-searches:v2:";
const LEGACY_RECENT_SEARCH_KEY = "recent_searches";
const MAX_RECENT_SEARCHES = 10;

const storageKey = (viewerId: string) => `${RECENT_SEARCH_PREFIX}${viewerId}`;

export const purgeLegacyRecentSearches = (): void => {
  try { localStorage.removeItem(LEGACY_RECENT_SEARCH_KEY); } catch {}
};

export const readRecentSearches = (viewerId?: string | null): string[] => {
  if (!viewerId) return [];
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(viewerId)) || "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, MAX_RECENT_SEARCHES)
      : [];
  } catch {
    return [];
  }
};

export const saveRecentSearch = (viewerId: string | null | undefined, value: string): string[] => {
  const term = value.trim();
  if (!viewerId || !term) return readRecentSearches(viewerId);
  const updated = [term, ...readRecentSearches(viewerId).filter((item) => item !== term)].slice(0, MAX_RECENT_SEARCHES);
  try { localStorage.setItem(storageKey(viewerId), JSON.stringify(updated)); } catch {}
  return updated;
};
