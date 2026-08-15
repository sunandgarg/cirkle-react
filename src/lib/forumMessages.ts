export type ForumPostLike = Record<string, unknown> & {
  id: string;
  created_at?: string | null;
};

/**
 * Keeps a server-acknowledged message visible without waiting for another
 * network read. Duplicate realtime acknowledgements merge into the same row.
 */
export const acknowledgeForumPost = <T extends ForumPostLike>(
  currentPosts: T[],
  acknowledgedPost: T,
  maxMessages = 50,
): T[] => {
  const existingIndex = currentPosts.findIndex((post) => post.id === acknowledgedPost.id);
  const next = existingIndex >= 0
    ? currentPosts.map((post, index) => index === existingIndex ? { ...post, ...acknowledgedPost } : post)
    : [...currentPosts, acknowledgedPost];

  return next
    .sort((left, right) => {
      const byTime = new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
      return byTime || String(left.id).localeCompare(String(right.id));
    })
    .slice(-maxMessages);
};
