import { supabase } from "@/integrations/supabase/client";
import { createForumMediaSignedUrl } from "@/lib/forumMedia";
import type { ForumOutboxItem } from "@/lib/forumOutbox";
import { forumPostContent, normalizeForumPoll } from "@/lib/forumSend";

export const publishForumOutboxItem = async (item: ForumOutboxItem) => {
  const poll = normalizeForumPoll(item);
  let imagePath = item.imagePath || null;
  let imageUrl = item.imageUrl || null;
  let filePath: string | null = null;
  let fileUrl: string | null = null;

  if (item.image) {
    const { convertToWebP } = await import("@/lib/imageUtils");
    const source = new File([item.image.blob], item.image.name, {
      type: item.image.type, lastModified: item.image.lastModified || Date.now(),
    });
    const optimized = await convertToWebP(source, 0.75, 1600);
    imagePath = `${item.userId}/${item.id}.webp`;
    const { error } = await supabase.storage.from("post-images").upload(imagePath, optimized, {
      contentType: "image/webp", cacheControl: "31536000", upsert: true,
    });
    if (error) throw error;
    imageUrl = await createForumMediaSignedUrl("post-images", imagePath);
  }
  if (item.file) {
    const safeName = item.file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    filePath = `${item.userId}/${item.id}-${safeName}`;
    const { error } = await supabase.storage.from("forum-files").upload(filePath, item.file.blob, {
      contentType: item.file.type || "application/octet-stream", cacheControl: "31536000", upsert: true,
    });
    if (error) throw error;
    fileUrl = await createForumMediaSignedUrl("forum-files", filePath);
  }

  const { data: post, error } = await (supabase as any).rpc("create_forum_post", {
    p_id: item.id,
    p_scope_type: item.scopeType,
    p_scope_key: item.scopeKey,
    p_content: forumPostContent(item),
    p_is_anonymous: item.isAnonymous,
    p_reply_to_id: item.replyToId,
    p_image_path: imagePath,
    p_file_path: filePath,
    p_file_name: item.file?.name || null,
    p_file_size: item.file?.blob.size || null,
    p_file_type: item.file?.type || null,
    p_voice_path: item.voicePath || null,
    p_voice_duration: item.voiceDuration || null,
  });
  if (error || !post) throw error || new Error("Message could not be persisted");

  if (poll.question) {
    const { error: pollError } = await supabase.from("polls").upsert({
      post_id: post.id, question: poll.question, options: poll.options,
    }, { onConflict: "post_id" });
    if (pollError) throw pollError;
  }
  return {
    ...post, image_url: imageUrl, file_url: fileUrl,
    voice_url: item.voiceUrl, replyCount: 0, reactions: {}, myReactions: [],
  };
};
