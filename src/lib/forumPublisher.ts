import { supabase } from "@/integrations/supabase/client";
import { createForumMediaSignedUrl } from "@/lib/forumMedia";
import type { ForumOutboxItem } from "@/lib/forumOutbox";

export const publishForumOutboxItem = async (item: ForumOutboxItem) => {
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

  const postData: any = {
    id: item.id, community_id: "default", scope_type: item.scopeType, scope_key: item.scopeKey,
    channel: item.scopeType.toLowerCase().replace(/_/g, "-"),
    content: item.content || (item.image ? "📷" : item.file ? `📎 ${item.file.name}` : item.voicePath ? "🎤 Voice message" : ""),
    is_anonymous: item.isAnonymous, author_id: item.userId, reply_to_id: item.replyToId,
    image_url: imagePath ? null : imageUrl, image_path: imagePath,
    file_url: null, file_path: filePath,
    file_name: item.file?.name || null, file_size: item.file?.blob.size || null, file_type: item.file?.type || null,
    voice_url: item.voicePath ? null : item.voiceUrl, voice_path: item.voicePath || null, voice_duration: item.voiceDuration || null,
  };
  let { data: post, error } = await supabase.from("posts").insert(postData).select("*").single();
  if (error?.code === "23505") {
    const existing = await supabase.from("posts").select("*").eq("id", item.id).single();
    post = existing.data;
    error = existing.error;
  }
  if (error || !post) throw error || new Error("Message could not be persisted");

  const validOptions = (item.pollOptions || []).map((option) => option.trim()).filter(Boolean);
  if (item.pollQuestion?.trim() && validOptions.length >= 2) {
    const { error: pollError } = await supabase.from("polls").upsert({
      post_id: post.id, question: item.pollQuestion.trim(), options: validOptions,
    }, { onConflict: "post_id" });
    if (pollError) throw pollError;
  }
  return {
    ...post, image_url: imageUrl, file_url: fileUrl,
    voice_url: item.voiceUrl, replyCount: 0, reactions: {}, myReactions: [],
  };
};
