import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

type MediaCandidate = { url: string; width?: number | string; height?: number | string; path: string };

const isKlipyMediaUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "klipy.com" ||
      url.hostname.endsWith(".klipy.com") ||
      url.hostname === "klipy.co" ||
      url.hostname.endsWith(".klipy.co")
    );
  } catch {
    return false;
  }
};

const collectMedia = (node: unknown, path = "", depth = 0): MediaCandidate[] => {
  if (!node || typeof node !== "object" || depth > 5) return [];
  if (Array.isArray(node)) return node.flatMap((value, index) => collectMedia(value, `${path}.${index}`, depth + 1));
  const record = node as Record<string, unknown>;
  const own = isKlipyMediaUrl(record.url)
    ? [{ url: record.url, width: record.width as number | string | undefined, height: record.height as number | string | undefined, path }]
    : [];
  return own.concat(Object.entries(record).flatMap(([key, value]) => collectMedia(value, `${path}.${key}`, depth + 1)));
};

const mediaScore = (candidate: MediaCandidate, preview: boolean) => {
  const path = candidate.path.toLowerCase();
  const extension = (() => { try { return new URL(candidate.url).pathname.toLowerCase(); } catch { return ""; } })();
  let score = extension.endsWith(".gif") ? 50 : extension.endsWith(".webp") ? 35 : 10;
  if (preview) {
    if (/preview|sm|small|thumbnail/.test(path)) score += 30;
    if (/hd|original|large/.test(path)) score -= 10;
  } else {
    if (/hd|original|large/.test(path)) score += 30;
    if (/preview|sm|small|thumbnail/.test(path)) score -= 10;
  }
  return score;
};

const normalizeItem = (item: unknown) => {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (record.type === "ad") return null;
  const candidates = collectMedia(record.file || record.files || record.media || record);
  if (!candidates.length) return null;
  const full = [...candidates].sort((a, b) => mediaScore(b, false) - mediaScore(a, false))[0];
  const preview = [...candidates].sort((a, b) => mediaScore(b, true) - mediaScore(a, true))[0] || full;
  const slug = typeof record.slug === "string" ? record.slug : String(record.id || "");
  if (!slug) return null;
  return {
    id: String(record.id || slug),
    slug,
    title: typeof record.title === "string" ? record.title : "KLIPY GIF",
    url: full.url,
    preview: preview.url,
    width: Number(full.width) || 320,
    height: Number(full.height) || 240,
  };
};

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);
  const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  const appKey = Deno.env.get("KLIPY_API_KEY");
  if (!appKey) return json({ error: "KLIPY_API_KEY is not configured" }, 503);

  try {
    const body = await request.json().catch(() => ({}));
    const type = body.type === "stickers" ? "stickers" : "gifs";
    const action = body.action === "share" ? "share" : "search";

    if (action === "share") {
      const slug = typeof body.slug === "string" ? body.slug.trim().slice(0, 160) : "";
      if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) return json({ error: "Invalid KLIPY item" }, 400);
      const shareResponse = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(appKey)}/${type}/share/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: user.id }),
        signal: AbortSignal.timeout(8_000),
      });
      return json({ success: shareResponse.ok }, shareResponse.ok ? 200 : 502);
    }

    const query = typeof body.q === "string" ? body.q.trim().slice(0, 80) : "";
    const limit = Math.max(8, Math.min(30, Number(body.limit) || 20));
    const offset = Math.max(0, Math.min(5_000, Number(body.offset) || 0));
    const page = Math.floor(offset / limit) + 1;
    const endpoint = query ? "search" : "trending";
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(limit),
      customer_id: user.id,
      locale: "in",
      content_filter: "high",
    });
    if (query) params.set("q", query);

    const response = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(appKey)}/${type}/${endpoint}?${params}`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error("KLIPY API request failed", response.status, (await response.text()).slice(0, 300));
      return json({ error: "GIF search is temporarily unavailable" }, 502);
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.data?.data)
      ? payload.data.data
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    const results = items.map(normalizeItem).filter(Boolean).slice(0, limit);
    return json({ results });
  } catch (error) {
    console.error("KLIPY search failed", error instanceof Error ? error.message : error);
    return json({ error: "GIF search is temporarily unavailable" }, 502);
  }
});
