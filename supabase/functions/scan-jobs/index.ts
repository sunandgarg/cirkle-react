import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  JOB_EXPERIENCE_BUCKETS,
  TRUSTED_JOB_DOMAINS,
  companyFromJobUrl,
  hostnameMatchesAnyDomain,
  normalizeExperienceBucket,
  useSmallDashes,
} from "../_shared/discoveryCatalog.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Provider = "openai" | "anthropic" | "gemini" | "custom";
type PublishMode = "draft" | "published";

type ExtractedJob = {
  title: string;
  company: string | null;
  location: string | null;
  description: string | null;
  job_type: string | null;
  experience_level: string | null;
  category: string | null;
  salary_text: string | null;
  skills: string[] | null;
  apply_url: string | null;
  posted_at: string | null;
  expires_at: string | null;
  source_url: string | null;
};

type ScanConfig = {
  actorId: string;
  provider: Provider;
  model: string;
  company: string;
  sourceUrls: string[];
  instructions: string;
  publishMode: PublishMode;
  sourceId: string | null;
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
  if (url.protocol !== "https:") throw new Error("Only HTTPS career and application URLs are allowed.");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" || hostname.endsWith(".local") || hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" ||
    hostname.startsWith("[fc") || hostname.startsWith("[fd") || hostname.startsWith("[fe8") ||
    hostname.startsWith("[fe9") || hostname.startsWith("[fea") || hostname.startsWith("[feb") ||
    /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || /^169\.254\./.test(hostname)
  ) throw new Error("Private network sources are not allowed.");
  return url;
};

const canonicalUrl = (raw: string) => {
  const url = assertPublicHttpsUrl(raw);
  url.hash = "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source"]
    .forEach((key) => url.searchParams.delete(key));
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
};

const isPrivateAddress = (address: string) => {
  const value = address.toLowerCase();
  return value === "0.0.0.0" || value === "127.0.0.1" || value === "::1" ||
    /^10\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value) || value.startsWith("fc") ||
    value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") ||
    value.startsWith("fea") || value.startsWith("feb");
};

const assertPublicDns = async (url: URL) => {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(":")) {
    if (isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Private network sources are not allowed.");
    return;
  }
  const records = await Promise.allSettled([
    Deno.resolveDns(url.hostname, "A"),
    Deno.resolveDns(url.hostname, "AAAA"),
  ]);
  const addresses = records.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!addresses.length) throw new Error(`${url.hostname} could not be resolved.`);
  if (addresses.some(isPrivateAddress)) throw new Error("Private network sources are not allowed.");
};

const safeCanonicalUrl = (raw: string | null | undefined, fallback: string) => {
  if (!raw) return fallback;
  try { return canonicalUrl(raw); } catch { return fallback; }
};

const fetchSource = async (rawUrl: string) => {
  let url = assertPublicHttpsUrl(rawUrl);
  await assertPublicDns(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response | null = null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "CirkleJobScanner/1.0 (+https://cirkle.pages.dev)",
          Accept: "text/html,text/plain,application/json",
        },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error(`${url.hostname} redirected too many times`);
      url = assertPublicHttpsUrl(new URL(location, url).toString());
      await assertPublicDns(url);
    }
    if (!response?.ok) throw new Error(`${url.hostname} returned ${response?.status || "no response"}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
      throw new Error(`${url.hostname} is not a supported text source`);
    }
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 750_000) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = 750_000 - total;
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
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ");
    return `SOURCE: ${url.toString()}\n${text.slice(0, 140_000)}`;
  } finally {
    clearTimeout(timer);
  }
};

const jobSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    jobs: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" }, company: { type: ["string", "null"] },
          location: { type: ["string", "null"] }, description: { type: ["string", "null"] },
          job_type: { type: ["string", "null"] }, experience_level: { type: ["string", "null"] },
          category: { type: ["string", "null"] }, salary_text: { type: ["string", "null"] },
          skills: { type: ["array", "null"], items: { type: "string" } },
          apply_url: { type: ["string", "null"] }, posted_at: { type: ["string", "null"] },
          expires_at: { type: ["string", "null"] }, source_url: { type: ["string", "null"] },
        },
        required: ["title", "company", "location", "description", "job_type", "experience_level", "category", "salary_text", "skills", "apply_url", "posted_at", "expires_at", "source_url"],
      },
    },
  },
  required: ["jobs"],
};

const parseJsonText = (text: string): ExtractedJob[] => {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(cleaned);
  return Array.isArray(parsed) ? parsed : parsed.jobs;
};

const callProvider = async (provider: Provider, model: string, prompt: string, allowedDomains?: readonly string[]): Promise<ExtractedJob[]> => {
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
        ...(allowedDomains?.length ? {
          tools: [{ type: "web_search", filters: { allowed_domains: allowedDomains } }],
          include: ["web_search_call.action.sources"],
        } : {}),
        text: { format: { type: "json_schema", name: "job_scan", strict: true, schema: jobSchema } },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `OpenAI returned ${response.status}`);
    const text = payload.output?.flatMap((item: any) => item.content || []).find((item: any) => item.type === "output_text")?.text;
    if (!text) throw new Error("OpenAI returned no job data.");
    return parseJsonText(text);
  }

  if (provider === "anthropic") {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) throw new Error("ANTHROPIC_API_KEY is not configured in Supabase secrets.");
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: "user", content: prompt }] }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `Anthropic returned ${response.status}`);
    const text = payload.content?.find((item: any) => item.type === "text")?.text;
    if (!text) throw new Error("Anthropic returned no job data.");
    return parseJsonText(text);
  }

  if (provider === "gemini") {
    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) throw new Error("GEMINI_API_KEY is not configured in Supabase secrets.");
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: jobSchema },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `Gemini returned ${response.status}`);
    const text = payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("");
    if (!text) throw new Error("Gemini returned no job data.");
    return parseJsonText(text);
  }

  const key = Deno.env.get("CUSTOM_AI_API_KEY");
  const baseUrl = Deno.env.get("CUSTOM_AI_BASE_URL")?.replace(/\/+$/, "");
  if (!key || !baseUrl) throw new Error("CUSTOM_AI_API_KEY and CUSTOM_AI_BASE_URL must be configured in Supabase secrets.");
  const customApiUrl = assertPublicHttpsUrl(baseUrl);
  await assertPublicDns(customApiUrl);
  response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Custom provider returned ${response.status}`);
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error("Custom provider returned no job data.");
  return parseJsonText(text);
};

const sha256 = async (value: string) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const normalizedJobType = (value: string | null) => {
  const text = (value || "").toLowerCase();
  if (text.includes("intern")) return "Internship";
  if (text.includes("part")) return "Part-time";
  if (text.includes("contract")) return "Contract";
  return "Full-time";
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
  let sourceId: string | null = null;
  try {
    const body = await request.json();
    if (body.action === "status") {
      const configuredProviders = [
        Deno.env.get("GEMINI_API_KEY") ? "gemini" : null,
        Deno.env.get("OPENAI_API_KEY") ? "openai" : null,
        Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic" : null,
        Deno.env.get("CUSTOM_AI_API_KEY") && Deno.env.get("CUSTOM_AI_BASE_URL") ? "custom" : null,
      ].filter(Boolean);
      return json({
        configured_providers: configuredProviders,
        openai_web_discovery: configuredProviders.includes("openai"),
        experience_buckets: JOB_EXPERIENCE_BUCKETS,
      });
    }
    const isDiscovery = body.action === "discover";
    const discoveryBucket = isDiscovery && typeof body.experience_bucket === "string"
      ? body.experience_bucket.trim()
      : "";
    if (isDiscovery && !JOB_EXPERIENCE_BUCKETS.includes(discoveryBucket as typeof JOB_EXPERIENCE_BUCKETS[number])) {
      throw new Error("Choose a supported experience bucket for trusted job discovery.");
    }
    sourceId = typeof body.source_id === "string" ? body.source_id : null;
    let savedSource: any = null;
    if (sourceId) {
      const { data, error } = await adminClient.from("job_scan_sources").select("*").eq("id", sourceId).single();
      if (error) throw error;
      savedSource = data;
    }
    const provider = (isDiscovery ? "openai" : savedSource?.provider || body.provider) as Provider;
    if (!["openai", "anthropic", "gemini", "custom"].includes(provider)) throw new Error("Choose OpenAI, Anthropic, Gemini, or Custom compatible API.");
    const model = String(isDiscovery ? (body.model || "gpt-5.4-mini") : savedSource?.model || body.model || "").trim().slice(0, 120);
    if (!model) throw new Error("A model name is required.");
    const company = String(savedSource?.company || body.company || "").trim().slice(0, 180);
    const sourceUrls = isDiscovery
      ? TRUSTED_JOB_DOMAINS.map((domain) => `https://${domain}`)
      : savedSource ? [savedSource.source_url] : normalizeList(body.source_urls, 5);
    if (!sourceUrls.length) throw new Error("Add at least one HTTPS career source URL.");
    sourceUrls.forEach(assertPublicHttpsUrl);
    const instructions = String(savedSource?.instructions || body.instructions || "").trim().slice(0, 2500);
    const publishMode: PublishMode = (savedSource?.auto_publish || body.publish_mode === "published") ? "published" : "draft";
    const config: ScanConfig = { actorId, provider, model, company, sourceUrls, instructions, publishMode, sourceId };

    const { data: run, error: runError } = await adminClient.from("job_scan_runs").insert({
      requested_by: config.actorId, provider, model, company: company || null, source_urls: sourceUrls,
      instructions: instructions || null, publish_mode: publishMode,
    }).select("id").single();
    if (runError) throw runError;
    scanRunId = run.id;

    const settledSources = isDiscovery ? [] : await Promise.allSettled(sourceUrls.map(fetchSource));
    const sourceText = isDiscovery
      ? "Use web search across the configured trusted career and ATS domains."
      : settledSources
        .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
        .map((result) => result.value).filter(Boolean).join("\n\n");
    if (!sourceText) throw new Error("None of the supplied career sources could be read. Use a public careers page or ATS JSON feed.");

    const prompt = `You extract real, currently open jobs from supplied company career-page text. Today is ${new Date().toISOString()}.
Return only JSON shaped as {"jobs":[{"title":"...","company":null,"location":null,"description":null,"job_type":null,"experience_level":null,"category":null,"salary_text":null,"skills":null,"apply_url":null,"posted_at":null,"expires_at":null,"source_url":null}]}.
Rules: include only explicit job vacancies supported by the sources; exclude events, blogs, talent-network signup pages and closed jobs; every result must have a direct HTTPS application or job-detail URL; never invent titles, companies, locations, dates, salary, skills or URLs; use null when absent; deduplicate; maximum ${isDiscovery ? 6 : 100} jobs. Normalize experience_level to exactly one of ${JOB_EXPERIENCE_BUCKETS.join(", ")}. ${isDiscovery ? `Find up to six current ${discoveryBucket} roles, and only return roles whose official requirements support that bucket. Search only these domains: ${TRUSTED_JOB_DOMAINS.join(", ")}.` : ""} ${company ? `The expected company is ${company}.` : ""} ${instructions ? `Admin instructions: ${instructions}` : ""}

${sourceText}`;
    const extracted = await callProvider(provider, model, prompt, isDiscovery ? TRUSTED_JOB_DOMAINS : undefined);
    const valid = (Array.isArray(extracted) ? extracted : []).filter((job) => {
      if (!job || typeof job.title !== "string" || !job.title.trim() || typeof job.apply_url !== "string") return false;
      try {
        assertPublicHttpsUrl(job.apply_url);
        return !isDiscovery || hostnameMatchesAnyDomain(job.apply_url, TRUSTED_JOB_DOMAINS);
      } catch { return false; }
    }).slice(0, 100);

    let imported = 0;
    let skipped = extracted.length - valid.length;
    for (const job of valid) {
      const applyUrl = canonicalUrl(job.apply_url!);
      const fingerprint = await sha256(applyUrl);
      const { data: existing } = await adminClient.from("jobs").select("id").eq("source_fingerprint", fingerprint).maybeSingle();
      if (existing) { skipped += 1; continue; }
      const parsedPostedAt = job.posted_at && Number.isFinite(Date.parse(job.posted_at)) ? new Date(job.posted_at) : new Date();
      const postedAt = (parsedPostedAt && parsedPostedAt <= new Date()) ? parsedPostedAt.toISOString() : new Date().toISOString();
      const expiresAt = job.expires_at && Number.isFinite(Date.parse(job.expires_at)) ? new Date(job.expires_at).toISOString() : null;
      if (expiresAt && new Date(expiresAt) <= new Date()) { skipped += 1; continue; }
      const candidateSourceUrl = safeCanonicalUrl(job.source_url, applyUrl);
      const sourceUrl = isDiscovery && !hostnameMatchesAnyDomain(candidateSourceUrl, TRUSTED_JOB_DOMAINS)
        ? applyUrl
        : candidateSourceUrl;
      const { error } = await adminClient.from("jobs").insert({
        title: useSmallDashes(job.title.trim()).slice(0, 180), company: useSmallDashes(job.company?.trim() || company || companyFromJobUrl(applyUrl)).slice(0, 180),
        location: job.location ? useSmallDashes(job.location.trim()).slice(0, 240) : "Not specified",
        description: job.description ? useSmallDashes(job.description.trim()).slice(0, 8000) : null,
        job_type: normalizedJobType(job.job_type), experience_level: normalizeExperienceBucket(job.job_type?.toLowerCase().includes("intern") ? "Internship" : job.experience_level),
        category: job.category ? useSmallDashes(job.category.trim()).slice(0, 100) : null, salary_text: job.salary_text ? useSmallDashes(job.salary_text.trim()).slice(0, 180) : null,
        skills: normalizeList(job.skills, 30), easy_apply: false, apply_url: applyUrl,
        source_url: sourceUrl, source_fingerprint: fingerprint, source_type: "scan", scan_run_id: scanRunId,
        status: publishMode, published_at: publishMode === "published" ? new Date().toISOString() : null,
        expires_at: expiresAt, created_at: postedAt, updated_at: new Date().toISOString(),
        created_by: actorId, community_id: "default",
      });
      if (error) skipped += 1; else imported += 1;
    }

    await adminClient.from("job_scan_runs").update({
      status: "completed", discovered_count: extracted.length, imported_count: imported,
      skipped_count: skipped, completed_at: new Date().toISOString(),
    }).eq("id", scanRunId);
    if (sourceId) await adminClient.from("job_scan_sources").update({
      last_scanned_at: new Date().toISOString(), last_scan_status: "completed", last_error: null, updated_at: new Date().toISOString(),
    }).eq("id", sourceId);
    return json({ scan_run_id: scanRunId, discovered: extracted.length, imported, skipped, publish_mode: publishMode, experience_bucket: discoveryBucket || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Job scan failed.";
    if (scanRunId) await adminClient.from("job_scan_runs").update({ status: "failed", error_message: message.slice(0, 1000), completed_at: new Date().toISOString() }).eq("id", scanRunId);
    if (sourceId) await adminClient.from("job_scan_sources").update({ last_scanned_at: new Date().toISOString(), last_scan_status: "failed", last_error: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", sourceId);
    return json({ error: message }, 400);
  }
});
