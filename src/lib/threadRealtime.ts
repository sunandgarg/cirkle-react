export type ThreadRealtimeEventType = "INSERT" | "UPDATE" | "DELETE";

export interface ResolvedThreadRealtimeEvent {
  eventType: ThreadRealtimeEventType;
  row: Record<string, any>;
}

type ThreadReply = Record<string, any> & {
  id: string;
  created_at?: string;
  reply_to_id?: string | null;
};

type ThreadInvalidation = {
  table?: unknown;
  eventType?: unknown;
  new?: unknown;
  old?: unknown;
};

const identityFrom = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : "";
};

/**
 * Resolves a content-free AppSync thread invalidation into an authorized row.
 * INSERT/UPDATE events must be fetched through the normal API so current
 * verification, scope visibility, hidden-post state and media authorization
 * remain authoritative. DELETE carries only the identity needed to evict it.
 */
export async function resolveThreadAppSyncInvalidation(
  event: ThreadInvalidation,
  parentPostId: string,
  fetchReply: (replyId: string) => Promise<Record<string, any> | null>,
): Promise<ResolvedThreadRealtimeEvent | null> {
  if (event.table !== "posts") return null;
  const eventType = event.eventType;
  if (eventType !== "INSERT" && eventType !== "UPDATE" && eventType !== "DELETE") return null;
  const id = identityFrom(eventType === "DELETE" ? event.old : event.new);
  if (!id) return null;
  if (eventType === "DELETE") return { eventType, row: { id } };

  const row = await fetchReply(id);
  if (!row || row.id !== id || row.reply_to_id !== parentPostId || row.deleted_at) return null;
  return { eventType, row };
}

/**
 * Replaces the rendered thread window with an authorized database snapshot.
 * This intentionally treats omitted rows as absent so an UPDATE/DELETE missed
 * while the browser was hidden cannot survive foreground recovery.
 */
export function reconcileThreadSnapshot<T extends ThreadReply>(
  authoritative: T[],
  parentPostId: string,
  maxReplies = 1_200,
): T[] {
  return [...new Map(authoritative
    .filter((reply) => reply?.id && reply.reply_to_id === parentPostId && !reply.deleted_at)
    .map((reply) => [reply.id, reply])).values()]
    .sort((left, right) => {
      const byTime = String(right.created_at || "").localeCompare(String(left.created_at || ""));
      return byTime || right.id.localeCompare(left.id);
    })
    .slice(0, maxReplies);
}
