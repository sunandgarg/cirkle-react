export type ForumProfile = {
  user_id?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  slug?: string | null;
  [key: string]: unknown;
};

type ForumPostIdentity = {
  author_id?: string | null;
  is_anonymous?: boolean;
  profile?: ForumProfile | null;
};

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/**
 * Forum history can be painted from a local cache before the profile query
 * completes. Prefer the embedded API profile, but fill any missing identity
 * fields from the room's independently authorized profile map.
 */
export const resolveForumPostProfile = (
  post: ForumPostIdentity | null | undefined,
  profileMap: ReadonlyMap<string, ForumProfile>,
): ForumProfile | null => {
  if (!post || post.is_anonymous || !post.author_id) return null;
  const embedded = post.profile && typeof post.profile === "object" ? post.profile : null;
  const fallback = profileMap.get(post.author_id) ?? null;
  if (!embedded) return fallback;
  if (!fallback) return embedded;
  return {
    ...fallback,
    ...embedded,
    user_id: nonEmpty(embedded.user_id) ?? nonEmpty(fallback.user_id) ?? post.author_id,
    name: nonEmpty(embedded.name) ?? nonEmpty(fallback.name),
    avatar_url: nonEmpty(embedded.avatar_url) ?? nonEmpty(fallback.avatar_url),
    slug: nonEmpty(embedded.slug) ?? nonEmpty(fallback.slug),
  };
};

export const forumPostProfileSignature = (
  post: ForumPostIdentity | null | undefined,
  profileMap: ReadonlyMap<string, ForumProfile>,
): string => {
  const profile = resolveForumPostProfile(post, profileMap);
  return profile
    ? [profile.user_id, profile.name, profile.avatar_url, profile.slug].map((value) => String(value ?? "")).join("\u0000")
    : "";
};
