import { Prisma, type Post } from "@prisma/client";
import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { canUseForumScope } from "../security/forumScope.js";
import type { AuthUser } from "../types.js";

type Row = Record<string, unknown>;

export function resolveForumSlowModeSeconds(settings: Row[], scopeType: string, scopeKey: string): number | null {
  const scopedKey = `slow_mode_${scopeType}_${scopeKey}`;
  const selected = settings.find((row) => row.key === scopedKey) ?? settings.find((row) => row.key === "slow_mode_global");
  if (!selected) return null;
  try {
    const value = typeof selected.value === "string" ? JSON.parse(selected.value) as Row : selected.value as Row;
    if (!value || value.enabled !== true) return null;
    const seconds = Number(value.seconds ?? 30);
    if (!Number.isFinite(seconds)) return 30;
    return Math.max(1, Math.min(3_600, Math.floor(seconds || 30)));
  } catch {
    return null;
  }
}

async function activeForumSlowModeSeconds(
  tx: Prisma.TransactionClient, scopeType: string, scopeKey: string,
): Promise<number | null> {
  const scopedKey = `slow_mode_${scopeType}_${scopeKey}`;
  const records = await tx.legacyRecord.findMany({ where: {
    table_name: "app_settings",
    OR: [
      { data: { path: "$.key", equals: scopedKey } },
      { data: { path: "$.key", equals: "slow_mode_global" } },
    ],
  }, take: 2 });
  return resolveForumSlowModeSeconds(records.map((record) => record.data as Row), scopeType, scopeKey);
}

/**
 * The sole server-side creation path for typed forum posts. Non-admin callers
 * are serialized on their user row, so parallel RPC and generic-data requests
 * cannot race the last-post check. Keeping arrays in one transaction also
 * preserves the generic data API's all-or-nothing batch behavior.
 */
export async function createForumPostsWithSlowMode(
  posts: Prisma.PostUncheckedCreateInput[], actor: AuthUser,
): Promise<Post[]> {
  if (!posts.length) return [];
  const normalizedPosts = posts.map((data) => {
    if (actor.role !== "admin" && actor.role !== "owner" && data.author_id !== actor.id) {
      throw new ApiError(403, "post_author_mismatch", "Forum posts can only be created for the authenticated member");
    }
    const scopeType = String(data.scope_type ?? "GLOBAL").toUpperCase();
    const scopeKey = String(data.scope_key ?? "IIT_ALL");
    if (!/^[A-Z_]{2,40}$/.test(scopeType) || !scopeKey || scopeKey.length > 255) {
      throw new ApiError(400, "invalid_forum_scope", "A valid forum scope is required");
    }
    return { ...data, scope_type: scopeType, scope_key: scopeKey };
  });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`);
    const [currentUser, currentProfile] = await Promise.all([
      tx.user.findUnique({ where: { id: actor.id }, select: { id: true, role: true, status: true } }),
      tx.profile.findUnique({ where: { user_id: actor.id }, select: { is_verified: true } }),
    ]);
    if (!currentUser || currentUser.status !== "active") {
      throw new ApiError(403, "account_unavailable", "The member account is not active");
    }
    const privileged = currentUser.role === "admin" || currentUser.role === "owner";
    if (!privileged && !currentProfile?.is_verified) {
      throw new ApiError(403, "verification_required", "Verified institute membership is required");
    }
    const created: Post[] = [];
    for (const data of normalizedPosts) {
      const scopeType = data.scope_type;
      const scopeKey = data.scope_key;
      if (!privileged && data.author_id !== actor.id) {
        throw new ApiError(403, "post_author_mismatch", "Forum posts can only be created for the authenticated member");
      }
      if (!(await canUseForumScope(actor.id, Boolean(currentProfile?.is_verified), currentUser.role, scopeType, scopeKey, tx))) {
        throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
      }
      const seconds = await activeForumSlowModeSeconds(tx, scopeType, scopeKey);
      if (seconds && !privileged) {
        const now = new Date();
        const previous = await tx.post.findFirst({
          where: { author_id: actor.id, scope_type: scopeType, scope_key: scopeKey },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          select: { created_at: true },
        });
        if (previous) {
          const retryAt = new Date(previous.created_at.getTime() + seconds * 1_000);
          if (retryAt > now) {
            const retryAfterSeconds = Math.ceil((retryAt.getTime() - now.getTime()) / 1_000);
            throw new ApiError(429, "forum_slow_mode", `Slow mode: wait ${retryAfterSeconds}s`, {
              retry_after_seconds: retryAfterSeconds,
              retry_after_at: retryAt.toISOString(),
            });
          }
        }
      }
      created.push(await tx.post.create({ data }));
    }
    return created;
  });
}
