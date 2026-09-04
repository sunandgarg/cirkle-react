import { createHash } from "node:crypto";

export interface ForumAppSyncChannels {
  message_channel: string;
}

const APP_SYNC_CHANNEL = /^\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?)(?:\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?)){0,4}$/;
const CANONICAL_RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isCanonicalRealtimeRecordId = (value: string): boolean => CANONICAL_RECORD_ID.test(value);

const safeSegment = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length >= 1 && normalized.length <= 50) return normalized;
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
};

const scopeDigest = (scopeType: string, scopeKey: string): string => createHash("sha256")
  .update(scopeType.toUpperCase())
  .update("\0")
  .update(scopeKey)
  .digest("hex")
  .slice(0, 32);

export function forumAppSyncChannels(scopeType: string, scopeKey: string): ForumAppSyncChannels {
  const type = safeSegment(scopeType);
  const scope = scopeDigest(scopeType, scopeKey);
  return {
    message_channel: `/forum/${type}/${scope}`,
  };
}

export const chatAppSyncChannels = (roomId: string) => ({
  message_channel: `/chat/${safeSegment(roomId)}`,
});

export const threadAppSyncChannel = (postId: string): string => isCanonicalRealtimeRecordId(postId)
  ? `/thread/${postId}`
  : `/thread/legacy-${createHash("sha256").update(postId).digest("hex").slice(0, 32)}`;
export const inboxAppSyncChannel = (userId: string): string => `/inbox/${safeSegment(userId)}`;

export const isValidAppSyncChannel = (channel: string): boolean => APP_SYNC_CHANNEL.test(channel);
