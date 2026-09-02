import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";
import {
  IIT_EVENT_SOURCES,
  getIitEventSource,
  hostnameMatchesDomain,
  useSmallDashes,
} from "../_shared/discoveryCatalog.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Provider = "openai" | "anthropic" | "gemini";
type Audience = {
  mode: "everyone" | "targeted";
  iits: string[];
  courses: string[];
  specialisations: string[];
};

type ExtractedEvent = {
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  location: string | null;
  organizer: string | null;
  registration_url: string | null;
  source_url: string | null;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const normalizeList = (value: unknown, max = 50) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, max)
  : [];

const assertPublicHttpsUrl = (raw: string) => {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Only HTTPS event sources are allowed.");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" || hostname.endsWith(".local") || hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" ||
    hostname.startsWith("[fc") || hostname.startsWith("[fd") || hostname.startsWith("[fe8") || hostname.startsWith("[fe9") || hostname.startsWith("[fea") || hostname.startsWith("[feb") ||
    /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^169\.254\./.test(hostname)
  ) throw new Error("Private network sources are not allowed.");
  return url;
};

const fetchSource = async (rawUrl: string) => {
  let url = assertPublicHttpsUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "CirkleEventScanner/1.0 (+https://cirkle.pages.dev)" },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error(`${url.hostname} redirected too many times`);
      url = assertPublicHttpsUrl(new URL(location, url).toString());
    }
    if (!response) throw new Error("The source returned no response.");
    if (!response.ok) throw new Error(`${url.hostname} returned ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
      throw new Error(`${url.hostname} is not a supported text source`);
    }
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 600_000) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = 600_000 - total;
        chunks.push(value.slice(0, remaining));
        total += Math.min(value.length, remaining);
      }
    }
    await reader.cancel().catch(() => undefined);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    const raw = new TextDecoder().decode(combined);
    const text = contentType.includes("application/json") ? raw : raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ");
    return `SOURCE: ${url.toString()}\n${text.slice(0, 120_000)}`;
  } finally {
    clearTimeout(timer);
  }
};

const eventSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    events: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          description: { type: ["string", "null"] },
          start_time: { type: "string" },
          end_time: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          organizer: { type: ["string", "null"] },
          registration_url: { type: ["string", "null"] },
          source_url: { type: ["string", "null"] },
        },
        required: ["title", "description", "start_time", "end_time", "location", "organizer", "registration_url", "source_url"],
      },
    },
  },
  required: ["events"],
};

const parseJsonText = (text: string) => {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned);
  return Array.isArray(parsed) ? parsed : parsed.events;
};

const callProvider = async (provider: Provider, model: string, prompt: string, allowedDomain?: string): Promise<ExtractedEvent[]> => {
  let response: Response;
  if (provider === "openai") {
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("OPENAI_API_KEY is not configured in Supabase secrets.");
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: prompt,
        ...(allowedDomain ? {
          tools: [{ type: "web_search", filters: { allowed_domains: [allowedDomain] } }],
          include: ["web_search_call.action.sources"],
        } : {}),
        text: { format: { type: "json_schema", name: "event_scan", strict: true, schema: eventSchema } },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `OpenAI returned ${response.status}`);
    const text = payload.output?.flatMap((item: any) => item.content || []).find((item: any) => item.type === "output_text")?.text;
    if (!text) throw new Error("OpenAI returned no event data.");
    return parseJsonText(text);
  }

  if (provider === "anthropic") {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) throw new Error("ANTHROPIC_API_KEY is not configured in Supabase secrets.");
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 6000, messages: [{ role: "user", content: prompt }] }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `Anthropic returned ${response.status}`);
    const text = payload.content?.find((item: any) => item.type === "text")?.text;
    if (!text) throw new Error("Anthropic returned no event data.");
    return parseJsonText(text);
  }

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY is not configured in Supabase secrets.");
  response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: eventSchema },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini returned ${response.status}`);
  const text = payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("");
  if (!text) throw new Error("Gemini returned no event data.");
  return parseJsonText(text);
};

const sha256 = async (value: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Supabase function environment is incomplete." }, 500);

  const authorization = request.headers.get("Authorization") || "";
  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  let actorId: string | null = null;
  const isServiceCall = authorization === `Bearer ${serviceKey}` || request.headers.get("apikey") === serviceKey;
  if (isServiceCall) {
    const { data: role } = await adminClient.from("user_roles").select("user_id").eq("role", "admin").limit(1).maybeSingle();
    actorId = role?.user_id || null;
  } else {
    const { data: { user }, error: userError } = await authClient.auth.getUser();
    if (userError || !user) return json({ error: "Authentication required." }, 401);
    const { data: role } = await adminClient.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!role) return json({ error: "Admin access required." }, 403);
    actorId = user.id;
  }
  if (!actorId) return json({ error: "No administrator is configured for automated scans." }, 403);

  let scanRunId: string | null = null;
  try {
    const body = await request.json();
    if (body.action === "status") {
      const configuredProviders = [
        Deno.env.get("GEMINI_API_KEY") ? "gemini" : null,
        Deno.env.get("OPENAI_API_KEY") ? "openai" : null,
        Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic" : null,
      ].filter(Boolean);
      return json({
        configured_providers: configuredProviders,
        openai_web_discovery: configuredProviders.includes("openai"),
        institute_sources: IIT_EVENT_SOURCES,
      });
    }
    const isDiscovery = body.action === "discover";
    const provider = (isDiscovery ? "openai" : body.provider) as Provider;
    if (!["openai", "anthropic", "gemini"].includes(provider)) throw new Error("Choose OpenAI, Anthropic, or Gemini.");
    const requestedModel = typeof body.model === "string" ? body.model.trim().slice(0, 100) : "";
    const model = requestedModel || (isDiscovery ? "gpt-5.4-mini" : "");
    if (!model) throw new Error("A model name is required.");
    const requestedIit = typeof body.source_iit === "string" ? body.source_iit.trim().slice(0, 120) : "";
    const discoverySource = isDiscovery ? getIitEventSource(requestedIit) : null;
    if (isDiscovery && !discoverySource) throw new Error("Choose one supported IIT for official-source discovery.");
    const sourceUrls = isDiscovery ? [`https://${discoverySource!.domain}`] : normalizeList(body.source_urls, 10);
    if (!sourceUrls.length) throw new Error("Add at least one HTTPS event source URL.");
    sourceUrls.forEach(assertPublicHttpsUrl);
    const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2000) : "";
    const sourceIit = requestedIit;
    const publishMode = body.publish_mode === "published" ? "published" : "draft";
    const rawAudience = (body.audience || {}) as Partial<Audience>;
    const audience: Audience = {
      mode: rawAudience.mode === "targeted" ? "targeted" : "everyone",
      iits: normalizeList(rawAudience.iits),
      courses: normalizeList(rawAudience.courses),
      specialisations: normalizeList(rawAudience.specialisations),
    };
    if (audience.mode === "targeted" && !audience.iits.length && !audience.courses.length && !audience.specialisations.length) {
      throw new Error("Choose at least one audience target.");
    }

    const { data: run, error: runError } = await adminClient.from("event_scan_runs").insert({
      requested_by: actorId, provider, model, source_urls: sourceUrls, instructions: instructions || null,
      source_iit: sourceIit || null,
      audience_mode: audience.mode, target_iits: audience.iits, target_courses: audience.courses,
      target_specialisations: audience.specialisations,
    }).select("id").single();
    if (runError) throw runError;
    scanRunId = run.id;

    const settledSources = isDiscovery ? [] : await Promise.allSettled(sourceUrls.map(fetchSource));
    const sourceText = isDiscovery
      ? `Use web search only on the official ${discoverySource!.domain} domain.`
      : settledSources
        .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
        .map((result) => result.value).filter(Boolean).join("\n\n");
    if (!sourceText) throw new Error("None of the supplied event sources could be read.");

    const prompt = `You are Cirkle's careful IIT event editor. Extract real, meaningful upcoming events from supplied source text. Today is ${new Date().toISOString()}.
Return only JSON matching this shape: {"events":[{"title":"...","description":null,"start_time":"ISO-8601 with timezone","end_time":null,"location":null,"organizer":null,"registration_url":null,"source_url":"https://..."}]}.
Prioritize significant campus experiences: institute fests, distinguished or chief-guest visits, public talks, conferences, competitions, research showcases, convocations, cultural or sports festivals, entrepreneurship programs, and substantial alumni events.
Rules: include only events explicitly supported by the sources; exclude routine class notices, past events, news without a future event, jobs, admissions deadlines, tenders, routine academic notices, and undated announcements; never invent dates, URLs, venues, or organizers; every event must include a real source_url; use null when optional data is absent; make descriptions concise and factual; deduplicate; maximum ${isDiscovery ? 8 : 40} events. ${isDiscovery ? `Search only ${discoverySource!.domain}. Return at most eight of the most important events whose date and significance are confirmed on that official domain. Prefer institute-wide events, major conferences, distinguished speakers, flagship fests, convocations, and high-value opportunities over narrow routine workshops.` : ""} ${sourceIit ? `These sources belong to ${sourceIit}.` : "These sources may cover multiple IITs."} ${instructions ? `Admin instructions: ${instructions}` : ""}

${sourceText}`;
    const extracted = await callProvider(provider, model, prompt, discoverySource?.domain);
    const valid = (Array.isArray(extracted) ? extracted : []).filter((event) => {
      if (!event || typeof event.title !== "string" || typeof event.start_time !== "string") return false;
      const time = Date.parse(event.start_time);
      const sourceIsTrusted = typeof event.source_url === "string" && (!discoverySource || hostnameMatchesDomain(event.source_url, discoverySource.domain));
      return Number.isFinite(time) && time >= Date.now() - 86_400_000 && sourceIsTrusted;
    }).slice(0, isDiscovery ? 8 : 40);

    let imported = 0;
    let skipped = extracted.length - valid.length;
    for (const event of valid) {
      const fingerprint = await sha256(`${event.title.trim().toLowerCase()}|${new Date(event.start_time).toISOString()}|${event.source_url || ""}`);
      const { data: existing } = await adminClient.from("events").select("id").eq("source_fingerprint", fingerprint).maybeSingle();
      if (existing) { skipped += 1; continue; }
      const { error } = await adminClient.from("events").insert({
        title: useSmallDashes(event.title.trim()).slice(0, 180),
        description: event.description ? useSmallDashes(event.description.trim()).slice(0, 4000) : null,
        start_time: new Date(event.start_time).toISOString(),
        end_time: event.end_time && Number.isFinite(Date.parse(event.end_time)) ? new Date(event.end_time).toISOString() : null,
        location: event.location ? useSmallDashes(event.location.trim()).slice(0, 300) : null,
        organizer: event.organizer ? useSmallDashes(event.organizer.trim()).slice(0, 180) : null,
        registration_url: event.registration_url?.startsWith("https://") ? event.registration_url : null,
        source_url: event.source_url?.startsWith("https://") ? event.source_url : sourceUrls[0],
        source_fingerprint: fingerprint,
        source_iit: sourceIit || null,
        source_type: "scan",
        scan_run_id: scanRunId,
        status: publishMode,
        published_at: publishMode === "published" ? new Date().toISOString() : null,
        audience_mode: audience.mode,
        target_iits: audience.iits,
        target_courses: audience.courses,
        target_specialisations: audience.specialisations,
        created_by: actorId,
        community_id: "default",
      });
      if (error) skipped += 1; else imported += 1;
    }

    await adminClient.from("event_scan_runs").update({
      status: "completed", discovered_count: extracted.length, imported_count: imported,
      skipped_count: skipped, completed_at: new Date().toISOString(),
    }).eq("id", scanRunId);
    return json({ scan_run_id: scanRunId, discovered: extracted.length, imported, skipped, publish_mode: publishMode, source_iit: sourceIit || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Event scan failed.";
    if (scanRunId) await adminClient.from("event_scan_runs").update({ status: "failed", error_message: message.slice(0, 1000), completed_at: new Date().toISOString() }).eq("id", scanRunId);
    return json({ error: message }, 400);
  }
});
