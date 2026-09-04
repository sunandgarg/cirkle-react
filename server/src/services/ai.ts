import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { keyedHash, newId, sha256 } from "../security/crypto.js";
import type { RequestContext } from "../types.js";
import {
  AI_SCAN_PROVIDER_TIMEOUT_MS,
  AI_SCAN_SOURCE_TIMEOUT_MS,
  commitWithinScanDeadline,
  createPhaseSignal,
  raceWithSignal,
  scanDeadlineError,
  ScanDeadline,
} from "./scanDeadline.js";

const jobSchema = z.object({
  title: z.string().min(2).max(255), company: z.string().min(2).max(255), location: z.string().max(255).optional(),
  description: z.string().max(30_000).optional(), job_type: z.string().max(80).optional(), category: z.string().max(120).optional(),
  experience: z.string().max(255).optional(), experience_level: z.string().max(80).optional(), salary_text: z.string().max(255).optional(),
  skills: z.array(z.string().max(100)).max(50).optional(), apply_url: z.string().url(), published_at: z.string().datetime().optional(), expires_at: z.string().datetime().optional(),
});
const eventSchema = z.object({
  title: z.string().min(2).max(255), description: z.string().max(30_000).optional(), location: z.string().max(255).optional(),
  start_time: z.string().datetime(), end_time: z.string().datetime().optional(), organizer: z.string().max(255).optional(),
  registration_url: z.string().url().optional(), source_url: z.string().url(),
});
const scanSchema = z.object({ jobs: z.array(jobSchema).max(100).optional(), events: z.array(eventSchema).max(100).optional() });

const privateV4 = (address: string): boolean => {
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] === 0;
};
const privateV6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
};

export async function assertPublicUrl(raw: string, signal?: AbortSignal): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError(400, "invalid_source_url", "Source URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new ApiError(400, "unsafe_source_url", "Source URLs must be credential-free HTTPS URLs on the default port");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new ApiError(400, "unsafe_source_url", "Private source hosts are not allowed");
  const lookupOperation = isIP(hostname) ? Promise.resolve([{ address: hostname }]) : lookup(hostname, { all: true, verbatim: true });
  const addresses = signal ? await raceWithSignal(lookupOperation, signal) : await lookupOperation;
  if (!addresses.length || addresses.some(({ address }) => isIP(address) === 4 ? privateV4(address) : privateV6(address))) throw new ApiError(400, "unsafe_source_url", "Source host resolves to a private address");
  return url;
}

async function sourceText(raw: string, parentSignal: AbortSignal): Promise<string> {
  const phase = createPhaseSignal(parentSignal, AI_SCAN_SOURCE_TIMEOUT_MS);
  try {
    let url = await assertPublicUrl(raw, phase.signal);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": "CirkleScanner/1.0", Accept: "text/html,text/plain,application/json" }, signal: phase.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === 3) throw new ApiError(502, "source_redirect_failed", "Source redirected too many times");
        url = await assertPublicUrl(new URL(location, url).toString(), phase.signal);
        continue;
      }
      if (!response.ok) throw new ApiError(502, "source_fetch_failed", `Source returned HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > 750_000) throw new ApiError(413, "source_too_large", "Source response is too large");
      const text = await raceWithSignal(response.text(), phase.signal);
      if (Buffer.byteLength(text) > 750_000) throw new ApiError(413, "source_too_large", "Source response is too large");
      return text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120_000);
    }
    throw new ApiError(502, "source_fetch_failed", "Could not fetch source");
  } catch (error) {
    if (parentSignal.aborted) throw scanDeadlineError();
    if (phase.timedOut()) throw new ApiError(504, "source_fetch_timeout", "A scan source did not respond within 12 seconds; no listings were imported");
    throw error;
  } finally {
    phase.dispose();
  }
}

function jsonFromModel(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  try { return JSON.parse(fenced ?? text); } catch { throw new ApiError(502, "invalid_ai_response", "The AI provider returned invalid JSON"); }
}

async function runProvider(provider: string, model: string, prompt: string, parentSignal: AbortSignal): Promise<unknown> {
  const phase = createPhaseSignal(parentSignal, AI_SCAN_PROVIDER_TIMEOUT_MS);
  try {
    if (provider === "openai") {
      if (!config.OPENAI_API_KEY) throw new ApiError(503, "openai_not_configured", "OpenAI is not configured");
      const response = await raceWithSignal(new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: AI_SCAN_PROVIDER_TIMEOUT_MS, maxRetries: 0 }).responses.create(
        { model, input: prompt },
        { signal: phase.signal, timeout: AI_SCAN_PROVIDER_TIMEOUT_MS, maxRetries: 0 },
      ), phase.signal);
      return jsonFromModel(response.output_text);
    }
    if (provider === "gemini") {
      if (!config.GEMINI_API_KEY) throw new ApiError(503, "gemini_not_configured", "Google Gemini is not configured");
      const response = await raceWithSignal(new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }).models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          abortSignal: phase.signal,
          httpOptions: { timeout: AI_SCAN_PROVIDER_TIMEOUT_MS, retryOptions: { attempts: 1 } },
        },
      }), phase.signal);
      return jsonFromModel(String(response.text ?? ""));
    }
    throw new ApiError(400, "unsupported_ai_provider", "Provider must be openai or gemini");
  } catch (error) {
    if (parentSignal.aborted) throw scanDeadlineError();
    const timeoutLike = error instanceof Error && /abort|tim(?:e|ed)[ -]?out/i.test(`${error.name} ${error.message}`);
    if (phase.timedOut() || timeoutLike) {
      throw new ApiError(504, "ai_provider_timeout", `${provider === "gemini" ? "Google Gemini" : "OpenAI"} did not respond within 30 seconds; no listings were imported`);
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "ai_provider_failed", "The AI provider could not complete the scan; no listings were imported");
  } finally {
    phase.dispose();
  }
}

function scannerStatus() {
  const providers = [config.OPENAI_API_KEY ? "openai" : null, config.GEMINI_API_KEY ? "gemini" : null].filter(Boolean);
  return {
    ready: providers.length > 0, configured_providers: providers, providers,
    openai: !!config.OPENAI_API_KEY, gemini: !!config.GEMINI_API_KEY, openai_web_discovery: false,
    default_models: { openai: config.OPENAI_MODEL, gemini: config.GEMINI_MODEL },
    experience_buckets: ["0-2 years", "2-5 years", "5-10 years", "10+ years"],
  };
}

export async function scanWithAi(kind: "jobs" | "events", body: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  if (ctx.auth.role !== "admin" && ctx.auth.role !== "owner") throw new ApiError(403, "admin_required", "Administrator access is required");
  if (body.action === "status") return scannerStatus();
  if (body.action === "discover") throw new ApiError(501, "web_discovery_not_enabled", "AI web discovery is disabled until a grounded search provider is configured; scan explicit trusted URLs instead");
  const deadline = new ScanDeadline();
  try {
    let effective = { ...body };
    let savedSourceRecordId: string | undefined;
    if (kind === "jobs" && typeof body.source_id === "string") {
      const sources = await deadline.network(prisma.legacyRecord.findMany({ where: { table_name: "job_scan_sources" }, take: 2000 }));
      const sourceRecord = sources.find((record) => (record.data as Record<string, unknown>).id === body.source_id);
      const source = sourceRecord?.data as Record<string, unknown> | undefined;
      if (!sourceRecord || !source || typeof source.source_url !== "string") throw new ApiError(404, "scan_source_not_found", "Saved scan source not found");
      savedSourceRecordId = sourceRecord.id;
      effective = { ...source, ...body, source_urls: [source.source_url], publish_mode: source.auto_publish === true ? "published" : "draft" };
    }
    if (kind === "jobs" && body.action === "recruiter_batch") {
      const sources = Array.isArray(body.sources) ? body.sources : [];
      const sourceUrls = sources.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).source_url === "string" ? [(item as Record<string, unknown>).source_url as string] : []).slice(0, 10);
      effective = { ...body, source_urls: sourceUrls, publish_mode: "published" };
    }
    const provider = typeof effective.provider === "string" ? effective.provider : "openai";
    const model = typeof effective.model === "string" && effective.model.trim() ? effective.model.trim() : provider === "gemini" ? config.GEMINI_MODEL : config.OPENAI_MODEL;
    const urls = Array.isArray(effective.source_urls) ? effective.source_urls.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
    if (!urls.length) throw new ApiError(400, "sources_required", "At least one source URL is required");
    const documents = await deadline.network(Promise.all(urls.map(async (url) => ({ url, content: await sourceText(url, deadline.networkSignal) }))));
    const target = kind === "jobs" ? "active job listings" : "future events";
    const instructions = typeof effective.instructions === "string" ? effective.instructions.slice(0, 4000) : "";
    const discovery = "Use only the supplied source documents.";
    const prompt = [
      `Extract ${target}. Return JSON only as {"${kind}": [...]}. Do not invent missing dates, URLs, companies, or organizers.`,
      "Every item must contain a direct HTTPS source/apply URL. Ignore stale, expired, undated, or ambiguous items.", discovery,
      instructions ? `Operator instructions: ${instructions}` : "",
      ...documents.map((document, index) => `SOURCE ${index + 1}: ${document.url}\n${document.content}`),
    ].filter(Boolean).join("\n\n");
    const parsed = scanSchema.parse(await runProvider(provider, model, prompt, deadline.networkSignal));
    if (kind === "jobs") {
      await deadline.network(Promise.all((parsed.jobs ?? []).map((item) => assertPublicUrl(item.apply_url, deadline.networkSignal))));
    } else {
      await deadline.network(Promise.all((parsed.events ?? []).flatMap((item) => [
        assertPublicUrl(item.source_url, deadline.networkSignal),
        ...(item.registration_url ? [assertPublicUrl(item.registration_url, deadline.networkSignal)] : []),
      ])));
    }

    const runId = newId();
    const discovered = kind === "jobs" ? (parsed.jobs ?? []).length : (parsed.events ?? []).length;
    const publish = effective.publish_mode === "published" ? "published" : "draft";
    const scannedAt = new Date();
    const audience = effective.audience && typeof effective.audience === "object" ? effective.audience as Record<string, unknown> : {};
    const counts = await commitWithinScanDeadline(deadline, ({ timeout, maxWait, assertActive }) => prisma.$transaction(async (tx) => {
      let imported = 0;
      let skipped = 0;
      assertActive();
      if (kind === "jobs") {
        for (const item of parsed.jobs ?? []) {
          assertActive();
          const fingerprint = sha256(`${item.company.toLowerCase()}|${item.title.toLowerCase()}|${item.apply_url}`);
          const existing = await tx.job.findUnique({ where: { source_fingerprint: fingerprint } });
          assertActive();
          if (existing) {
            skipped += 1;
            await tx.job.update({ where: { id: existing.id }, data: { last_seen_at: scannedAt } });
          } else {
            await tx.job.create({ data: {
              created_by: ctx.auth.id, community_id: ctx.auth.community_id, title: item.title, company: item.company, location: item.location, description: item.description,
              job_type: item.job_type, category: item.category, experience: item.experience, experience_level: item.experience_level,
              salary_text: item.salary_text, skills: item.skills, apply_url: item.apply_url, application_url: item.apply_url, source_url: item.apply_url,
              source_type: "ai_scan", status: publish, source_fingerprint: fingerprint, scan_run_id: runId, discovered_at: scannedAt, last_seen_at: scannedAt,
              published_at: publish === "published" ? scannedAt : undefined, expires_at: item.expires_at ? new Date(item.expires_at) : undefined,
            } });
            imported += 1;
          }
          assertActive();
        }
      } else {
        for (const item of parsed.events ?? []) {
          assertActive();
          if (new Date(item.start_time) <= scannedAt) { skipped += 1; continue; }
          const fingerprint = sha256(`${item.title.toLowerCase()}|${item.start_time}|${item.source_url}`);
          const existing = await tx.event.findUnique({ where: { source_fingerprint: fingerprint } });
          assertActive();
          if (existing) { skipped += 1; continue; }
          await tx.event.create({ data: {
            title: item.title, description: item.description, location: item.location, start_time: new Date(item.start_time), end_time: item.end_time ? new Date(item.end_time) : undefined,
            organizer: item.organizer, organizer_name: item.organizer, registration_url: item.registration_url, source_url: item.source_url,
            source_iit: typeof effective.source_iit === "string" ? effective.source_iit : undefined, source_type: "ai_scan", status: publish,
            community_id: ctx.auth.community_id, created_by: ctx.auth.id, audience_mode: typeof audience.mode === "string" ? audience.mode : "everyone",
            target_iits: Array.isArray(audience.iits) ? audience.iits as Prisma.InputJsonValue : undefined,
            target_courses: Array.isArray(audience.courses) ? audience.courses as Prisma.InputJsonValue : undefined,
            target_specialisations: Array.isArray(audience.specialisations) ? audience.specialisations as Prisma.InputJsonValue : undefined,
            source_fingerprint: fingerprint, scan_run_id: runId, published_at: publish === "published" ? scannedAt : undefined,
          } });
          imported += 1;
          assertActive();
        }
      }
      await tx.legacyRecord.create({ data: {
        table_name: kind === "jobs" ? "job_scan_runs" : "event_scan_runs", record_id: runId, owner_id: ctx.auth.id, community_id: ctx.auth.community_id,
        data: {
          id: runId, provider, model, status: "completed", discovered_count: discovered, imported_count: imported, skipped_count: skipped,
          company: typeof effective.company === "string" ? effective.company : null, source_urls: urls, created_at: scannedAt.toISOString(),
        },
      } });
      assertActive();
      if (savedSourceRecordId) {
        const sourceRecord = await tx.legacyRecord.findUnique({ where: { id: savedSourceRecordId } });
        if (sourceRecord) await tx.legacyRecord.update({ where: { id: savedSourceRecordId }, data: { data: {
          ...(sourceRecord.data as Record<string, unknown>), last_scanned_at: scannedAt.toISOString(), last_scan_status: "completed", last_error: null, updated_at: scannedAt.toISOString(),
        } as Prisma.InputJsonValue } });
        assertActive();
      }
      await tx.auditLog.create({ data: {
        actor_id: ctx.auth.id, action: `ai.scan_${kind}`, resource_type: "scan_run", resource_id: runId,
        ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined, metadata: { provider, model, imported, skipped },
      } });
      assertActive();
      return { imported, skipped };
    }, { timeout, maxWait }));
    return { run_id: runId, ...counts, provider, model };
  } catch (error) {
    if (deadline.networkSignal.aborted && !(error instanceof ApiError && ["scan_deadline_exceeded", "scan_commit_timeout"].includes(error.code))) throw scanDeadlineError();
    throw error;
  } finally {
    deadline.dispose();
  }
}
