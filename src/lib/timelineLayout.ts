type TimelineRecord = Record<string, any>;

/**
 * Shared contract for message timelines. The virtualizer—not the browser or
 * an after-render scrollTop write—owns anchor preservation and row movement.
 */
export const TIMELINE_VIRTUALIZER_OPTIONS = {
  anchorTo: "end",
  followOnAppend: true,
  directDomUpdates: true,
  directDomUpdatesMode: "transform",
  useScrollendEvent: true,
  useAnimationFrameWithResizeObserver: true,
} as const;

const estimatedTextLines = (content: unknown, charactersPerLine: number, maximum: number) => {
  const text = String(content || "");
  return Math.min(
    maximum,
    Math.max(1, text.split("\n").length, Math.ceil(text.length / charactersPerLine)),
  );
};

/** Gives unmeasured Forum rows a realistic size, avoiding large corrections as media enters view. */
export const estimateForumPostRowHeight = (post: TimelineRecord): number => {
  let size = 46 + estimatedTextLines(post.content, 46, 8) * 22;
  if (post.reply_to_id) size += 25;
  if (post.pinned_at) size += 20;
  if (post.image_url || post.image_path) size += 286;
  if (post.file_url || post.file_path) size += 76;
  if (post.voice_url || post.voice_path) size += 62;
  if (post.poll) size += 54 + Math.min(6, post.poll.options?.length || 0) * 38;
  if (Object.keys(post.reactions || {}).length) size += 34;
  if ((post.replyCount || 0) > 0) size += 27;
  return Math.min(560, Math.max(68, size));
};

/** Gives unmeasured direct-message rows stable estimates during fast flicks. */
export const estimateDirectMessageRowHeight = (message: TimelineRecord): number => {
  if (message.message_type === "image") return 276;
  if (message.message_type === "voice") return 84;
  return 45
    + estimatedTextLines(message.content, 42, 7) * 21
    + (message.reply_to_message_id ? 32 : 0);
};
