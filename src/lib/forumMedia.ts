import { supabase } from "@/integrations/supabase/client";

const MEDIA_FIELDS = [
  ["post-images", "image_path", "image_url"],
  ["forum-files", "file_path", "file_url"],
  ["voice-notes", "voice_path", "voice_url"],
] as const;

export const hydrateForumMediaUrls = async <T extends Record<string, any>>(posts: T[]): Promise<T[]> => {
  if (!posts.length) return posts;
  const resolved = new Map<string, string>();
  await Promise.all(MEDIA_FIELDS.map(async ([bucket, pathField]) => {
    const paths = [...new Set(posts.map((post) => post[pathField]).filter(Boolean))] as string[];
    if (!paths.length) return;
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, 3600);
    if (error) throw error;
    data?.forEach((entry, index) => {
      if (entry.signedUrl) resolved.set(`${bucket}:${paths[index]}`, entry.signedUrl);
    });
  }));
  return posts.map((post) => {
    const next: Record<string, any> = { ...post };
    MEDIA_FIELDS.forEach(([bucket, pathField, urlField]) => {
      const path = post[pathField];
      if (path) next[urlField] = resolved.get(`${bucket}:${path}`) || null;
    });
    return next as T;
  });
};

export const createForumMediaSignedUrl = async (bucket: string, path: string) => {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
};
