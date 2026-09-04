export type ForumScopeIdentity = {
  type: string;
  key: string;
};

export type ForumRealtimeEvent = {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new?: Record<string, any>;
  old?: Record<string, any>;
};

/**
 * Normalizes Supabase Broadcast Changes envelopes across Realtime versions.
 * Current servers expose rows as payload.record / payload.old_record while
 * older deployments and Postgres Changes use new / old.
 */
export const getForumBroadcastRow = (
  message: Record<string, any> | undefined,
  version: "new" | "old",
): Record<string, any> | undefined => {
  if (!message) return undefined;
  const payload = message.payload ?? message;
  const nested = payload.payload ?? payload;
  if (version === "old") {
    return payload.old_record ?? nested.old_record ?? message.old ?? payload.old ?? nested.old;
  }
  return payload.record ?? nested.record ?? message.new ?? payload.new ?? nested.new;
};

const compareMessages = (left: Record<string, any>, right: Record<string, any>) => {
  const byTime = new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
  if (byTime !== 0) return byTime;
  return String(left.id || "").localeCompare(String(right.id || ""));
};

const insertInOrder = <T extends Record<string, any>>(posts: T[], row: T): T[] => {
  let low = 0;
  let high = posts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareMessages(posts[middle], row) <= 0) low = middle + 1;
    else high = middle;
  }
  return [...posts.slice(0, low), row, ...posts.slice(low)];
};

/**
 * Applies one room-scoped realtime event without a network refetch.
 * The operation is idempotent, maintains deterministic order, and keeps a
 * bounded cache so bursty rooms cannot grow browser memory without limit.
 */
export const applyForumRealtimeEvent = <T extends Record<string, any>>(
  currentPosts: T[],
  event: ForumRealtimeEvent,
  scope: ForumScopeIdentity,
  maxMessages = 50,
): T[] => {
  if (event.eventType === "DELETE") {
    const id = event.old?.id;
    return id ? currentPosts.filter((post) => post.id !== id) : currentPosts;
  }

  const row = event.new as T | undefined;
  if (!row?.id) return currentPosts;
  const belongsToRoom = row.scope_type === scope.type && row.scope_key === scope.key && !row.reply_to_id && !row.deleted_at;
  const existingIndex = currentPosts.findIndex((post) => post.id === row.id);

  if (event.eventType === "UPDATE") {
    if (existingIndex < 0) return currentPosts;
    if (!belongsToRoom) return currentPosts.filter((post) => post.id !== row.id);
    const next = currentPosts.slice();
    next[existingIndex] = { ...next[existingIndex], ...row };
    return next.sort(compareMessages).slice(-maxMessages);
  }

  if (!belongsToRoom || existingIndex >= 0) return currentPosts;
  const last = currentPosts[currentPosts.length - 1];
  if (!last || compareMessages(last, row) <= 0) {
    return [...currentPosts.slice(-(maxMessages - 1)), row];
  }
  return insertInOrder(currentPosts, row).slice(-maxMessages);
};

/**
 * Applies a burst as one cache transaction and one sort. This prevents a hot
 * room from causing one React render and one browser-cache write per message.
 */
export const applyForumRealtimeBatch = <T extends Record<string, any>>(
  currentPosts: T[],
  events: ForumRealtimeEvent[],
  scope: ForumScopeIdentity,
  maxMessages = 1_200,
): T[] => {
  if (events.length === 0) return currentPosts;
  const postsById = new Map(currentPosts.map((post) => [post.id, post]));

  for (const event of events) {
    if (event.eventType === "DELETE") {
      if (event.old?.id) postsById.delete(event.old.id);
      continue;
    }

    const row = event.new as T | undefined;
    if (!row?.id) continue;
    // The room timeline contains root messages only. Thread replies have their
    // own subscription/cache and must never leak above the parent message.
    const belongsToRoom = row.scope_type === scope.type && row.scope_key === scope.key && !row.reply_to_id && !row.deleted_at;
    if (!belongsToRoom) {
      if (event.eventType === "UPDATE") postsById.delete(row.id);
      continue;
    }

    const existing = postsById.get(row.id);
    if (event.eventType === "UPDATE" && !existing) continue;
    postsById.set(row.id, existing ? { ...existing, ...row } : row);
  }

  return [...postsById.values()].sort(compareMessages).slice(-maxMessages);
};
