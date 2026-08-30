import { supabase } from "@/integrations/supabase/client";

const MEDIA_FIELDS = [
  ["post-images", "image_path", "image_url"],
  ["forum-files", "file_path", "file_url"],
  ["voice-notes", "voice_path", "voice_url"],
] as const;

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

export const hydrateForumMediaUrls = async <T extends Record<string, any>>(posts: T[]): Promise<T[]> => {
  if (!posts.length) return posts;
  const resolved = new Map<string, string>();
  await Promise.all(MEDIA_FIELDS.map(async ([bucket, pathField]) => {
    const paths = [...new Set(posts.map((post) => post[pathField]).filter(Boolean))] as string[];
    if (!paths.length) return;
    const now = Date.now();
    const missing = paths.filter((path) => {
      const cached = signedUrlCache.get(`${bucket}:${path}`);
      if (cached && cached.expiresAt > now) { resolved.set(`${bucket}:${path}`, cached.url); return false; }
      return true;
    });
    if (missing.length) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrls(missing, 3600);
      if (error) throw error;
      data?.forEach((entry, index) => {
        if (!entry.signedUrl) return;
        const key = `${bucket}:${missing[index]}`;
        signedUrlCache.set(key, { url: entry.signedUrl, expiresAt: now + 50 * 60_000 });
        resolved.set(key, entry.signedUrl);
      });
    }
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
  const key = `${bucket}:${path}`;
  const cached = signedUrlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) throw error;
  signedUrlCache.set(key, { url: data.signedUrl, expiresAt: Date.now() + 50 * 60_000 });
  return data.signedUrl;
};
