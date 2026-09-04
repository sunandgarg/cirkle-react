type Row = Record<string, unknown>;

const privateContentFields = [
  "body", "message", "caption", "tags", "campus_filter", "degree_filter", "branch_filter", "batch_filter", "cohort_filter", "student_status_filter",
  "image_url", "image_path", "media_url", "media_path", "media_bucket", "media_type", "media_metadata", "attachments", "link_preview",
  "file_url", "file_path", "file_name", "file_type", "file_size", "voice_url", "voice_path", "voice_duration", "poll",
] as const;

export function isDeletedForEveryone(row: Row): boolean {
  return row.is_deleted_for_everyone === true || row.deleted_for_everyone === true || row.deleted_at != null;
}

export function contentTombstone(row: Row, force = false): Row {
  if (!force && !isDeletedForEveryone(row)) return { ...row };
  const clean: Row = { ...row, content: "", is_deleted_for_everyone: true };
  for (const field of privateContentFields) clean[field] = null;
  return clean;
}

export function mediaReferencesRevoked(references: Row[]): boolean {
  return references.length > 0 && references.every(isDeletedForEveryone);
}

export function privateMediaObjectKeys(row: Row, kind: "post" | "message" | "story"): string[] {
  const messageMediaBucket = typeof row.media_bucket === "string" && ["post-images", "chat-media"].includes(row.media_bucket)
    ? row.media_bucket : "chat-media";
  const candidates: Array<[string, unknown]> = kind === "post"
    ? [["post-images", row.image_path], ["post-images", row.media_path], ["forum-files", row.file_path], ["voice-notes", row.voice_path]]
    : kind === "story" ? [["stories", row.image_path]]
      : [["chat-media", row.image_path], [messageMediaBucket, row.media_path], ["chat-media", row.file_path], ["voice-notes", row.voice_path]];
  return [...new Set(candidates.flatMap(([bucket, value]) => typeof value === "string" && value ? [`${bucket}/${value}`] : []))];
}

export const deletedContentFields = new Set<string>(["content", ...privateContentFields]);
