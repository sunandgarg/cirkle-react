import { prisma } from "../lib/prisma.js";
import type { DbChangeEvent } from "./events.js";

interface ForumReactionSource {
  post: { findUnique(args: unknown): Promise<{
    id: string;
    scope_type: string;
    scope_key: string;
    reply_to_id: string | null;
    deleted_at: Date | null;
    is_deleted_for_everyone: boolean;
  } | null> };
  reaction: { findMany(args: unknown): Promise<Array<{ emoji: string }>> };
}

const reactionMaterializationTails = new Map<string, Promise<void>>();

/**
 * Reaction rows do not contain their forum scope. Convert them into a small,
 * server-authoritative Post UPDATE so both AppSync and Socket.IO can route the
 * aggregate to the correct room without exposing the reacting member.
 */
export async function materializeForumReactionChange(
  change: DbChangeEvent,
  source: ForumReactionSource = prisma as unknown as ForumReactionSource,
): Promise<DbChangeEvent> {
  if (change.table !== "reactions" || change.row.entity_type !== "forum_msg" || typeof change.row.entity_id !== "string") return change;
  const entityId = change.row.entity_id;
  const previous = reactionMaterializationTails.get(entityId) ?? Promise.resolve();
  const result = previous.then(async (): Promise<DbChangeEvent> => {
    const post = await source.post.findUnique({
      where: { id: entityId },
      select: { id: true, scope_type: true, scope_key: true, reply_to_id: true, deleted_at: true, is_deleted_for_everyone: true },
    });
    if (!post || post.deleted_at || post.is_deleted_for_everyone) return change;
    const rows = await source.reaction.findMany({
      where: { entity_id: post.id, entity_type: "forum_msg" },
      select: { emoji: true },
    });
    const reactions: Record<string, number> = {};
    for (const row of rows) reactions[row.emoji] = (reactions[row.emoji] ?? 0) + 1;
    return {
      ...change,
      table: "posts",
      event: "UPDATE",
      row: {
        id: post.id,
        scope_type: post.scope_type,
        scope_key: post.scope_key,
        reply_to_id: post.reply_to_id,
        reactions,
      },
    };
  });
  const tail = result.then(() => undefined, () => undefined);
  reactionMaterializationTails.set(entityId, tail);
  try {
    return await result;
  } finally {
    if (reactionMaterializationTails.get(entityId) === tail) reactionMaterializationTails.delete(entityId);
  }
}
