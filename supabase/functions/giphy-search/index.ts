import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
  const authClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  const GIPHY_API_KEY = Deno.env.get('GIPHY_API_KEY');
  if (!GIPHY_API_KEY) {
    return new Response(JSON.stringify({ error: 'GIPHY_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { q, type = 'gifs', limit = 20, offset = 0 } = await req.json();
    const safeQuery = typeof q === 'string' ? q.trim().slice(0, 80) : '';
    const safeLimit = Math.max(1, Math.min(30, Number(limit) || 20));
    const safeOffset = Math.max(0, Math.min(5000, Number(offset) || 0));

    // Support both 'gifs' and 'stickers' types
    const apiType = type === 'stickers' ? 'stickers' : 'gifs';
    let url: string;
    if (safeQuery) {
      url = `https://api.giphy.com/v1/${apiType}/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(safeQuery)}&limit=${safeLimit}&offset=${safeOffset}&rating=pg-13&lang=en`;
    } else {
      url = `https://api.giphy.com/v1/${apiType}/trending?api_key=${GIPHY_API_KEY}&limit=${safeLimit}&offset=${safeOffset}&rating=pg-13`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Giphy API error [${response.status}]: ${await response.text()}`);
    }

    const data = await response.json();

    // Return minimal data to reduce payload
    const results = data.data.map((gif: any) => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.fixed_height.url,
      preview: gif.images.fixed_height_small.url || gif.images.preview_gif?.url || gif.images.fixed_height.url,
      width: parseInt(gif.images.fixed_height.width),
      height: parseInt(gif.images.fixed_height.height),
    }));

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('Giphy search error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
