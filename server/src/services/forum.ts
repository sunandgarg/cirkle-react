import type { Post, Profile, Reaction } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { RequestContext } from "../types.js";
import { contentTombstone, privateMediaObjectKeys } from "../security/tombstone.js";
import { opaqueHandlesForObjectKeys } from "./storage.js";

type Row = Record<string, unknown>;

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  return value;
}

export interface ForumPostParts {
  profile?: Pick<Profile, "user_id" | "name" | "avatar_url" | "slug"> | null;
  poll?: Row | null;
  replyCount?: number;
  reactions?: Record<string, number>;
  myReactions?: string[];
  viewerHasPinned?: boolean;
  mediaHandles?: Map<string, string>;
}

const anonymousMediaFields = [
  ["post-images", "image_path", "image_url"],
  ["post-images", "media_path", "media_url"],
  ["forum-files", "file_path", "file_url"],
  ["voice-notes", "voice_path", "voice_url"],
] as const;

const trustedAnonymousRemoteMedia = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "klipy.com" || host.endsWith(".klipy.com") || host === "klipy.co" || host.endsWith(".klipy.co"))
      ? url.toString() : null;
  } catch { return null; }
};

export function redactAnonymousPostForViewer(
  row: Row,
  viewerId: string,
  viewerRole: string,
  handles: Map<string, string> = new Map(),
): Row {
  if (row.is_anonymous !== true || row.author_id === viewerId || viewerRole === "admin" || viewerRole === "owner") return { ...row };
  const safe: Row = {
    ...row,
    author_id: null,
    deleted_by_user_id: null,
    client_id: null,
    viewer_is_author: false,
    profile: null,
    media_metadata: null,
  };
  for (const [bucket, pathField, urlField] of anonymousMediaFields) {
    const rawPath = typeof row[pathField] === "string" ? row[pathField] as string : "";
    const handle = rawPath ? handles.get(`${bucket}/${rawPath}`) ?? null : null;
    safe[pathField] = handle;
    if (pathField === "media_path" && !rawPath) safe[urlField] = trustedAnonymousRemoteMedia(row[urlField]);
    else safe[urlField] = null;
  }
  if (safe.file_path) safe.file_name = "Attachment";
  else safe.file_name = null;
  return safe;
}

export async function forumPostMediaHandles(posts: Array<Pick<Post, "image_path" | "media_path" | "file_path" | "voice_path">>): Promise<Map<string, string>> {
  return opaqueHandlesForObjectKeys(posts.flatMap((post) => privateMediaObjectKeys(post as unknown as Row, "post")));
}

export function buildForumPostDto(post: Post, viewerId: string, viewerRole: string, parts: ForumPostParts = {}): Row {
  const viewerIsAuthor = post.author_id === viewerId;
  const canSeeAnonymousAuthor = viewerIsAuthor || viewerRole === "admin" || viewerRole === "owner";
  const safePost = contentTombstone(jsonSafe(post) as Row);
  const poll = parts.poll ? { ...parts.poll } : null;
  if (poll) delete poll.created_by;
  return redactAnonymousPostForViewer({
    ...safePost,
    author_id: post.is_anonymous && !canSeeAnonymousAuthor ? null : post.author_id,
    viewer_is_author: viewerIsAuthor,
    viewer_has_pinned: parts.viewerHasPinned ?? false,
    profile: post.is_anonymous ? null : jsonSafe(parts.profile ?? null),
    poll: safePost.is_deleted_for_everyone === true ? null : jsonSafe(poll),
    replyCount: parts.replyCount ?? 0,
    reactions: safePost.is_deleted_for_everyone === true ? {} : parts.reactions ?? {},
    myReactions: safePost.is_deleted_for_everyone === true ? [] : parts.myReactions ?? [],
  }, viewerId, viewerRole, parts.mediaHandles);
}

export async function hiddenForumPostIds(userId: string): Promise<string[]> {
  const records = await prisma.legacyRecord.findMany({ where: { table_name: "forum_deleted_for_user", owner_id: userId }, take: 5000 });
  return records.flatMap((record) => {
    const id = (record.data as Row).post_id;
    return typeof id === "string" ? [id] : [];
  });
}

export async function enrichForumPosts(posts: Post[], ctx: RequestContext): Promise<Row[]> {
  if (!posts.length) return [];
  const ids = posts.map((post) => post.id);
  const authorIds = posts.flatMap((post) => !post.is_anonymous && post.author_id ? [post.author_id] : []);
  const [profiles, reactions, replies, legacy, hiddenIds, mediaHandles] = await Promise.all([
    prisma.profile.findMany({ where: { user_id: { in: authorIds } }, select: { user_id: true, name: true, avatar_url: true, slug: true } }),
    prisma.reaction.findMany({ where: { entity_id: { in: ids }, entity_type: "forum_msg" } }),
    prisma.post.findMany({ where: { reply_to_id: { in: ids }, deleted_at: null }, select: { reply_to_id: true } }),
    prisma.legacyRecord.findMany({ where: { table_name: { in: ["polls", "user_pinned_messages"] } }, take: 5000 }),
    hiddenForumPostIds(ctx.auth.id),
    forumPostMediaHandles(posts),
  ]);
  const hidden = new Set(hiddenIds);
  const profileByUser = new Map(profiles.map((profile) => [profile.user_id, profile]));
  const polls = new Map<string, Row>();
  const pinned = new Set<string>();
  for (const record of legacy) {
    const row = record.data as Row;
    if (record.table_name === "polls" && typeof row.post_id === "string") polls.set(row.post_id, row);
    if (record.table_name === "user_pinned_messages" && row.user_id === ctx.auth.id && typeof row.message_id === "string") pinned.add(row.message_id);
  }
  const replyCounts = new Map<string, number>();
  for (const reply of replies) if (reply.reply_to_id) replyCounts.set(reply.reply_to_id, (replyCounts.get(reply.reply_to_id) ?? 0) + 1);
  const grouped = new Map<string, { totals: Record<string, number>; mine: string[] }>();
  for (const reaction of reactions as Reaction[]) {
    const entry = grouped.get(reaction.entity_id) ?? { totals: {}, mine: [] };
    entry.totals[reaction.emoji] = (entry.totals[reaction.emoji] ?? 0) + 1;
    if (reaction.user_id === ctx.auth.id && !entry.mine.includes(reaction.emoji)) entry.mine.push(reaction.emoji);
    grouped.set(reaction.entity_id, entry);
  }
  return posts.filter((post) => !hidden.has(post.id)).map((post) => {
    const reaction = grouped.get(post.id);
    return buildForumPostDto(post, ctx.auth.id, ctx.auth.role, {
      profile: post.author_id ? profileByUser.get(post.author_id) ?? null : null,
      poll: polls.get(post.id) ?? null,
      replyCount: replyCounts.get(post.id) ?? 0,
      reactions: reaction?.totals ?? {},
      myReactions: reaction?.mine ?? [],
      viewerHasPinned: pinned.has(post.id),
      mediaHandles,
    });
  });
}
