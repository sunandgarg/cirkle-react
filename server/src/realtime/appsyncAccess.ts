import { prisma } from "../lib/prisma.js";
import { allowedForumScopes, canUseForumScope } from "../security/forumScope.js";
import type { AuthUser } from "../types.js";
import {
  chatAppSyncChannels,
  forumAppSyncChannels,
  inboxAppSyncChannel,
  isCanonicalRealtimeRecordId,
  isValidAppSyncChannel,
  threadAppSyncChannel,
} from "./appsyncChannels.js";

const roomFromChannel = (channel: string): string | undefined => {
  const parts = channel.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "chat") return undefined;
  return parts[1];
};

const ADMIN_FORUM_CHANNEL = /^\/forum\/[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?\/[a-f0-9]{32}$/;

async function isRoomMember(userId: string, roomId: string): Promise<boolean> {
  return Boolean(await prisma.legacyRecord.findFirst({
    where: {
      table_name: "chat_members",
      owner_id: userId,
      data: { path: "$.room_id", equals: roomId },
    },
    select: { id: true },
  }));
}

async function canUseForumChannel(auth: AuthUser, channel: string): Promise<boolean> {
  // Forum channel scope keys are deliberately one-way digests, so they cannot
  // be reconstructed from an AppSync subscription request. Platform
  // administrators are allowed to moderate every real forum scope; accepting
  // only the exact channel shape preserves that privilege without opening
  // other namespaces or wildcard subscriptions.
  if (auth.role === "admin" || auth.role === "owner") return ADMIN_FORUM_CHANNEL.test(channel);
  const scopes = await allowedForumScopes(auth.id, auth.is_verified, auth.role);
  return scopes.some((scope) => Object.values(forumAppSyncChannels(scope.scope_type, scope.scope_key)).includes(channel));
}

async function canUseThreadChannel(auth: AuthUser, channel: string): Promise<boolean> {
  const postId = channel.split("/").filter(Boolean)[1];
  if (!postId || !isCanonicalRealtimeRecordId(postId) || threadAppSyncChannel(postId) !== channel) return false;
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deleted_at || post.is_deleted_for_everyone) return false;
  return post.author_id === auth.id
    || canUseForumScope(auth.id, auth.is_verified, auth.role, post.scope_type, post.scope_key);
}

export async function canSubscribeAppSyncChannel(auth: AuthUser, channel: string): Promise<boolean> {
  if (!isValidAppSyncChannel(channel)) return false;
  if (auth.role !== "admin" && auth.role !== "owner") {
    const profile = await prisma.profile.findUnique({ where: { user_id: auth.id }, select: { is_verified: true } });
    if (!profile?.is_verified) return false;
  }
  if (channel === inboxAppSyncChannel(auth.id)) return true;
  if (channel.startsWith("/forum/")) {
    return canUseForumChannel(auth, channel);
  }
  if (channel.startsWith("/thread/")) return canUseThreadChannel(auth, channel);
  const roomId = roomFromChannel(channel);
  return roomId ? isRoomMember(auth.id, roomId) : false;
}
