const CACHE_PREFIX = "forum_cache_";
const CACHE_TS_PREFIX = "forum_cache_ts_";
const MAX_CACHE_AGE_MS = 5 * 60 * 1000; // 5 minutes stale threshold
const MAX_TOTAL_SIZE = 1024 * 1024; // keep localStorage lean; IndexedDB owns deep history
const LOCAL_SNAPSHOT_MESSAGES = 100;

// ─── Layer 1: In-memory singleton cache ───
class MessageCacheStore {
  private cache = new Map<string, any[]>();
  private timestamps = new Map<string, number>();

  getKey(scopeType: string, scopeKey: string, viewerId = "anonymous") {
    return `${viewerId}_${scopeType}_${scopeKey}`;
  }

  get(scopeType: string, scopeKey: string, viewerId = "anonymous"): any[] | null {
    const key = this.getKey(scopeType, scopeKey, viewerId);
    return this.cache.get(key) ?? null;
  }

  set(scopeType: string, scopeKey: string, posts: any[], viewerId = "anonymous") {
    const key = this.getKey(scopeType, scopeKey, viewerId);
    this.cache.set(key, posts);
    this.timestamps.set(key, Date.now());
  }

  isStale(scopeType: string, scopeKey: string, viewerId = "anonymous"): boolean {
    const key = this.getKey(scopeType, scopeKey, viewerId);
    const ts = this.timestamps.get(key);
    if (!ts) return true;
    return Date.now() - ts > MAX_CACHE_AGE_MS;
  }

  getAllKeys(): string[] {
    return Array.from(this.cache.keys());
  }
}

export const messageCache = new MessageCacheStore();

// ─── Layer 2: localStorage cache ───
export const getCachedPosts = (scopeType: string, scopeKey: string, viewerId = "anonymous"): any[] | null => {
  // Try memory first
  const memCached = messageCache.get(scopeType, scopeKey, viewerId);
  if (memCached) return memCached;

  // Fall back to localStorage
  try {
    const key = `${CACHE_PREFIX}${viewerId}_${scopeType}_${scopeKey}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Populate memory cache too
    messageCache.set(scopeType, scopeKey, parsed, viewerId);
    return parsed;
  } catch {
    return null;
  }
};

export const isCacheStale = (scopeType: string, scopeKey: string, viewerId = "anonymous"): boolean => {
  // Check memory first
  if (!messageCache.isStale(scopeType, scopeKey, viewerId)) return false;

  try {
    const tsKey = `${CACHE_TS_PREFIX}${viewerId}_${scopeType}_${scopeKey}`;
    const ts = localStorage.getItem(tsKey);
    if (!ts) return true;
    return Date.now() - parseInt(ts, 10) > MAX_CACHE_AGE_MS;
  } catch {
    return true;
  }
};

export const setCachedPosts = (scopeType: string, scopeKey: string, posts: any[], viewerId = "anonymous") => {
  // Always set in memory
  messageCache.set(scopeType, scopeKey, posts, viewerId);

  try {
    const key = `${CACHE_PREFIX}${viewerId}_${scopeType}_${scopeKey}`;
    const tsKey = `${CACHE_TS_PREFIX}${viewerId}_${scopeType}_${scopeKey}`;
    const serialized = JSON.stringify(posts.slice(-LOCAL_SNAPSHOT_MESSAGES));
    
    if (serialized.length > MAX_TOTAL_SIZE) return;
    
    try {
      localStorage.setItem(key, serialized);
      localStorage.setItem(tsKey, Date.now().toString());
    } catch {
      evictOldCaches();
      try {
        localStorage.setItem(key, serialized);
        localStorage.setItem(tsKey, Date.now().toString());
      } catch {}
    }
  } catch {}
};

// ─── Unread dots persistence ───
const UNREAD_PREFIX = "forum_v2_unread_dots_";
const DRAFT_PREFIX = "forum_v2_draft_";
const SCROLL_PREFIX = "forum_v2_scroll_";
const LEGACY_UNREAD_KEY = "forum_unread_dots";
const LEGACY_DRAFT_PREFIX = "forum_draft_";
const LEGACY_SCROLL_PREFIX = "forum_scroll_";
const TEST_POSTS_PREFIX = "forum_test_posts_";
const LAST_ROOM_PREFIX = "forum_last_room_";

export type LastForumRoom = { type: string; key: string };

export const getLastForumRoom = (viewerId?: string | null): LastForumRoom | null => {
  if (!viewerId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(`${LAST_ROOM_PREFIX}${viewerId}`) || "null");
    return value?.type && value?.key ? value : null;
  } catch { return null; }
};

export const setLastForumRoom = (viewerId: string, room: LastForumRoom) => {
  try { localStorage.setItem(`${LAST_ROOM_PREFIX}${viewerId}`, JSON.stringify(room)); } catch {}
};

const viewerKey = (viewerId?: string | null) => viewerId?.trim() || null;

const roomStateKey = (prefix: string, viewerId: string, scopeType: string, scopeKey: string) =>
  `${prefix}${viewerId}_${scopeType}_${scopeKey}`;

/**
 * Pre-user-scoping forum state cannot be attributed safely to an account on a
 * shared browser. Delete it instead of guessing an owner or leaking a draft.
 */
export const purgeLegacyForumLocalState = () => {
  try {
    localStorage.removeItem(LEGACY_UNREAD_KEY);
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_DRAFT_PREFIX) || key?.startsWith(LEGACY_SCROLL_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {}
};

export const getForumDraft = (scopeType: string, scopeKey: string, viewerId?: string | null) => {
  const owner = viewerKey(viewerId);
  if (!owner) return "";
  try { return localStorage.getItem(roomStateKey(DRAFT_PREFIX, owner, scopeType, scopeKey)) || ""; }
  catch { return ""; }
};

export const setForumDraft = (scopeType: string, scopeKey: string, draft: string, viewerId?: string | null) => {
  const owner = viewerKey(viewerId);
  if (!owner) return;
  try {
    const key = roomStateKey(DRAFT_PREFIX, owner, scopeType, scopeKey);
    if (draft) localStorage.setItem(key, draft.slice(0, 4000));
    else localStorage.removeItem(key);
  } catch {}
};

export const getForumScroll = (scopeType: string, scopeKey: string, viewerId?: string | null) => {
  const owner = viewerKey(viewerId);
  if (!owner) return 0;
  try { return Math.max(0, Number(localStorage.getItem(roomStateKey(SCROLL_PREFIX, owner, scopeType, scopeKey))) || 0); }
  catch { return 0; }
};

export const setForumScroll = (scopeType: string, scopeKey: string, offset: number, viewerId?: string | null) => {
  const owner = viewerKey(viewerId);
  if (!owner) return;
  try { localStorage.setItem(roomStateKey(SCROLL_PREFIX, owner, scopeType, scopeKey), String(Math.max(0, Math.round(offset)))); }
  catch {}
};

const testPostsKey = (scopeType: string, scopeKey: string) =>
  `${TEST_POSTS_PREFIX}${scopeType}_${scopeKey}`;

export const getForumTestPosts = (scopeType: string, scopeKey: string): any[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(testPostsKey(scopeType, scopeKey)) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-100) : [];
  } catch { return []; }
};

export const appendForumTestPost = (scopeType: string, scopeKey: string, post: any) => {
  try {
    const posts = [...getForumTestPosts(scopeType, scopeKey), post].slice(-100);
    localStorage.setItem(testPostsKey(scopeType, scopeKey), JSON.stringify(posts));
    return posts;
  } catch {
    return [post];
  }
};

export const getUnreadChannels = (viewerId?: string | null): Record<string, boolean> => {
  const owner = viewerKey(viewerId);
  if (!owner) return {};
  const key = `${UNREAD_PREFIX}${owner}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      // First load defaults
      const defaults: Record<string, boolean> = {
        "GLOBAL_IIT_ALL_tech": true,
        "GLOBAL_IIT_ALL_jobs": true,
      };
      localStorage.setItem(key, JSON.stringify(defaults));
      return defaults;
    }
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

export const setChannelRead = (scopeType: string, scopeKey: string, viewerId?: string | null) => {
  const owner = viewerKey(viewerId);
  if (!owner) return;
  try {
    const current = getUnreadChannels(owner);
    const key = `${scopeType}_${scopeKey}`;
    delete current[key];
    localStorage.setItem(`${UNREAD_PREFIX}${owner}`, JSON.stringify(current));
  } catch {}
};

export const setChannelUnread = (scopeType: string, scopeKey: string, viewerId?: string | null) => {
  const owner = viewerKey(viewerId);
  if (!owner) return;
  try {
    const current = getUnreadChannels(owner);
    const key = `${scopeType}_${scopeKey}`;
    current[key] = true;
    localStorage.setItem(`${UNREAD_PREFIX}${owner}`, JSON.stringify(current));
  } catch {}
};

const evictOldCaches = () => {
  try {
    const entries: { key: string; ts: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CACHE_TS_PREFIX)) {
        const ts = parseInt(localStorage.getItem(k) || "0", 10);
        entries.push({ key: k.replace(CACHE_TS_PREFIX, ""), ts });
      }
    }
    entries.sort((a, b) => a.ts - b.ts);
    const toRemove = entries.slice(0, Math.ceil(entries.length / 2));
    toRemove.forEach(({ key }) => {
      localStorage.removeItem(`${CACHE_PREFIX}${key}`);
      localStorage.removeItem(`${CACHE_TS_PREFIX}${key}`);
    });
  } catch {}
};
