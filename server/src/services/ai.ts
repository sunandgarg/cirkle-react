import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
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

export const JOB_EXPERIENCE_BUCKETS = [
  "Internship",
  "0-1 years",
  "1-2 years",
  "2-3 years",
  "3-5 years",
  "5-7 years",
  "7+ years",
] as const;

export const JOB_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const JOB_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const OPENAI_WEB_SEARCH_MODELS = new Set([
  "gpt-5.4-mini",
  "gpt-5.4-mini-2026-03-17",
]);

const TRUSTED_JOB_DOMAINS = [
  "amazon.jobs",
  "jobs.apple.com",
  "careers.google.com",
  "jobs.careers.microsoft.com",
  "careers.adobe.com",
  "careers.atlassian.com",
  "careers.ibm.com",
  "careers.oracle.com",
  "careers.salesforce.com",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
] as const;

const IIT_EVENT_SOURCES = [
  { name: "IIT Bombay", domain: "iitb.ac.in" },
  { name: "IIT Delhi", domain: "iitd.ac.in" },
  { name: "IIT Madras", domain: "iitm.ac.in" },
  { name: "IIT Kanpur", domain: "iitk.ac.in" },
  { name: "IIT Kharagpur", domain: "iitkgp.ac.in" },
  { name: "IIT Roorkee", domain: "iitr.ac.in" },
  { name: "IIT Guwahati", domain: "iitg.ac.in" },
  { name: "IIT Hyderabad", domain: "iith.ac.in" },
  { name: "IIT BHU", domain: "iitbhu.ac.in" },
  { name: "IIT Indore", domain: "iiti.ac.in" },
  { name: "IIT Ropar", domain: "iitrpr.ac.in" },
  { name: "IIT Patna", domain: "iitp.ac.in" },
  { name: "IIT Bhubaneswar", domain: "iitbbs.ac.in" },
  { name: "IIT Gandhinagar", domain: "iitgn.ac.in" },
  { name: "IIT Jodhpur", domain: "iitj.ac.in" },
  { name: "IIT Mandi", domain: "iitmandi.ac.in" },
  { name: "IIT Tirupati", domain: "iittp.ac.in" },
  { name: "IIT Palakkad", domain: "iitpkd.ac.in" },
  { name: "IIT Dharwad", domain: "iitdh.ac.in" },
  { name: "IIT Bhilai", domain: "iitbhilai.ac.in" },
  { name: "IIT Goa", domain: "iitgoa.ac.in" },
  { name: "IIT Jammu", domain: "iitjammu.ac.in" },
  { name: "IIT Dhanbad (ISM)", domain: "iitism.ac.in" },
] as const;

const nullableText = (max: number) => z.string().max(max).nullable().optional();
const requiredNullableText = (max: number) => z.string().max(max).nullable();
const jobSchema = z.object({
  title: z.string().min(2).max(255),
  company: z.string().min(2).max(255),
  location: nullableText(255),
  description: nullableText(30_000),
  job_type: nullableText(80),
  category: nullableText(120),
  experience: nullableText(255),
  experience_level: nullableText(80),
  salary_text: nullableText(255),
  skills: z.array(z.string().max(100)).max(50).nullable().optional(),
  apply_url: z.string().url(),
  source_url: z.string().url(),
  source_document_url: z.string().url().nullable(),
  source_record_text: requiredNullableText(4_000),
  published_at: z.string().datetime(),
  published_at_text: requiredNullableText(500),
  expires_at: z.string().datetime().nullable().optional(),
  expires_at_text: requiredNullableText(500),
});
const eventSchema = z.object({
  title: z.string().min(2).max(255),
  description: nullableText(30_000),
  location: nullableText(255),
  start_time: z.string().datetime(),
  end_time: z.string().datetime().nullable().optional(),
  organizer: nullableText(255),
  registration_url: z.string().url().nullable().optional(),
  source_url: z.string().url(),
  source_document_url: z.string().url().nullable(),
  source_record_text: requiredNullableText(4_000),
  start_time_text: requiredNullableText(500),
  end_time_text: requiredNullableText(500),
});
const jobScanSchema = z.object({ jobs: z.array(jobSchema).max(100) });
const eventScanSchema = z.object({ events: z.array(eventSchema).max(100) });

export type JobCandidate = z.infer<typeof jobSchema>;
export type EventCandidate = z.infer<typeof eventSchema>;
type JobBucket = (typeof JOB_EXPERIENCE_BUCKETS)[number];

const jobJsonSchema = {
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
          title: { type: "string" },
          company: { type: "string" },
          location: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          job_type: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          experience: { type: ["string", "null"] },
          experience_level: { type: ["string", "null"] },
          salary_text: { type: ["string", "null"] },
          skills: { type: ["array", "null"], items: { type: "string" } },
          apply_url: { type: "string" },
          source_url: { type: "string" },
          source_document_url: { type: ["string", "null"] },
          source_record_text: { type: ["string", "null"] },
          published_at: { type: "string" },
          published_at_text: { type: ["string", "null"] },
          expires_at: { type: ["string", "null"] },
          expires_at_text: { type: ["string", "null"] },
        },
        required: [
          "title", "company", "location", "description", "job_type", "category", "experience",
          "experience_level", "salary_text", "skills", "apply_url", "source_url", "source_document_url", "source_record_text",
          "published_at", "published_at_text", "expires_at", "expires_at_text",
        ],
      },
    },
  },
  required: ["jobs"],
} as const;

const eventJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    events: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          description: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          start_time: { type: "string" },
          end_time: { type: ["string", "null"] },
          organizer: { type: ["string", "null"] },
          registration_url: { type: ["string", "null"] },
          source_url: { type: "string" },
          source_document_url: { type: ["string", "null"] },
          source_record_text: { type: ["string", "null"] },
          start_time_text: { type: ["string", "null"] },
          end_time_text: { type: ["string", "null"] },
        },
        required: [
          "title", "description", "location", "start_time", "end_time", "organizer", "registration_url",
          "source_url", "source_document_url", "source_record_text", "start_time_text", "end_time_text",
        ],
      },
    },
  },
  required: ["events"],
} as const;

const replaceLongDashes = (value: string): string => value.replace(/[–—]/g, "-");

export function modelSupportsOpenAiWebSearch(model: string): boolean {
  return OPENAI_WEB_SEARCH_MODELS.has(model.trim());
}

export function parseFreshJobPublishedAt(value: unknown, nowMs = Date.now()): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) return null;
  if (parsedMs > nowMs + JOB_FUTURE_CLOCK_SKEW_MS) return null;
  if (parsedMs < nowMs - JOB_FRESHNESS_WINDOW_MS) return null;
  return new Date(parsedMs).toISOString();
}

export function normalizeExperienceBucket(value: string | null | undefined, jobType?: string | null): JobBucket | null {
  const text = `${jobType ?? ""} ${value ?? ""}`.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (/\b(?:intern|internship|trainee)\b/.test(text)) return "Internship";
  const range = text.match(/\b(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*(?:years?|yrs?)?\b/);
  const single = text.match(/\b(\d{1,2})\s*(?:(\+|plus|or more)\s*)?(?:years?|yrs?)(?:\s*(or more))?\b/);
  const lower = range ? Number(range[1]) : single ? Number(single[1]) : Number.NaN;
  const upper = range ? Number(range[2]) : single ? Number(single[1]) : Number.NaN;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower) return null;
  if (lower >= 7 || upper > 7) return "7+ years";
  if (single?.[2] || single?.[3]) {
    if (lower <= 0) return "0-1 years";
    if (lower <= 1) return "1-2 years";
    if (lower <= 2) return "2-3 years";
    if (lower <= 4) return "3-5 years";
    if (lower <= 6) return "5-7 years";
    return "7+ years";
  }
  if (lower <= 0 && upper <= 1) return "0-1 years";
  if (lower <= 1 && upper <= 2) return "1-2 years";
  if (lower <= 2 && upper <= 3) return "2-3 years";
  if (lower <= 3 && upper <= 5) return "3-5 years";
  if (lower <= 5 && upper <= 7) return "5-7 years";
  return null;
}

const GENERIC_JOB_PATHS = new Set(["career", "careers", "job", "jobs", "openings", "opportunities", "search", "vacancies"]);

export function isLikelyJobDetailUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const idParameters = ["gh_jid", "jobid", "job_id", "requisitionid", "requisition_id", "rid"];
    if (idParameters.some((parameter) => url.searchParams.get(parameter)?.trim())) return true;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => segment.toLowerCase());
    return segments.length >= 2 && !GENERIC_JOB_PATHS.has(segments.at(-1) ?? "");
  } catch {
    return false;
  }
}

function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

export type SuppliedSourceDocument = {
  requestedUrl: string;
  resolvedUrl: string;
  content: string;
  referenceUrls: string[];
};

const SOURCE_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
};

function decodeSourceEntities(value: string): string {
  return value
    .replace(/&(?:amp|apos|gt|lt|nbsp|quot);/gi, (entity) => SOURCE_ENTITY_MAP[entity.slice(1, -1).toLowerCase()] ?? entity)
    .replace(/&#(\d+);/g, (entity, digits: string) => {
      const point = Number(digits);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&#x([\da-f]+);/gi, (entity, digits: string) => {
      const point = Number.parseInt(digits, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    });
}

function normalizedSourceText(value: string): string {
  return decodeSourceEntities(value)
    .normalize("NFKC")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSuppliedSourceDocument(raw: string, requestedUrl: string, resolvedUrl = requestedUrl): SuppliedSourceDocument {
  const requested = canonicalUrl(requestedUrl);
  const resolved = canonicalUrl(resolvedUrl);
  if (!requested || !resolved) throw new ApiError(400, "invalid_source_url", "Supplied document URLs must be credential-free HTTPS URLs");

  const referenceUrls = new Set<string>([requested, resolved]);
  const decodedRaw = decodeSourceEntities(raw.replace(/\\\//g, "/"));
  const sourceMarkup = decodedRaw
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attributesText: string, body: string) =>
      /\btype\s*=\s*["']application\/ld\+json["']/i.test(attributesText) ? ` ${body} ` : " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const addReference = (candidate: string) => {
    if (referenceUrls.size >= 100 || candidate.length > 1_000) return;
    try {
      const normalized = canonicalUrl(new URL(candidate.trim(), resolved).toString());
      if (normalized) referenceUrls.add(normalized);
    } catch {
      // Invalid links remain inert source text and can never ground a returned URL.
    }
  };
  for (const match of sourceMarkup.matchAll(/\b(?:href|src|action)\s*=\s*(["'])(.*?)\1/gi)) addReference(match[2] ?? "");
  for (const match of sourceMarkup.matchAll(/https:\/\/[^\s"'<>\\]+/gi)) addReference((match[0] ?? "").replace(/[),.;]+$/, ""));

  const attributes = [...sourceMarkup.matchAll(/\b(?:aria-label|alt|content|data-date|data-time|datetime|title)\s*=\s*(["'])(.*?)\1/gi)]
    .map((match) => match[2] ?? "")
    .filter(Boolean)
    .slice(0, 500);
  const visibleText = sourceMarkup.replace(/<[^>]+>/g, (tag) => {
    const inlineAttributes = [...tag.matchAll(/\b(?:aria-label|alt|content|data-date|data-time|datetime|href|title)\s*=\s*(["'])(.*?)\1/gi)]
      .map((match) => match[2] ?? "")
      .filter(Boolean);
    return ` ${inlineAttributes.join(" ")} `;
  });
  const content = normalizedSourceText([
    ...attributes,
    ...referenceUrls,
    visibleText,
  ].join(" ")).slice(0, 120_000);
  return { requestedUrl: requested, resolvedUrl: resolved, content, referenceUrls: [...referenceUrls] };
}

function sourceDocumentFor(rawUrl: string | null, documents: readonly SuppliedSourceDocument[]): SuppliedSourceDocument | null {
  if (!rawUrl) return null;
  const normalized = canonicalUrl(rawUrl);
  if (!normalized) return null;
  return documents.find((document) => document.requestedUrl === normalized || document.resolvedUrl === normalized) ?? null;
}

function documentContainsFact(document: SuppliedSourceDocument, value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const fact = normalizedSourceText(value).toLowerCase();
  return fact.length >= 2 && document.content.toLowerCase().includes(fact);
}

function documentReferencesUrl(document: SuppliedSourceDocument, rawUrl: string): boolean {
  const normalized = canonicalUrl(rawUrl);
  return Boolean(normalized && document.referenceUrls.includes(normalized));
}

function parsedEvidenceTimestamp(value: string): number | null {
  const normalized = normalizedSourceText(value);
  const iso = normalized.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})/i)?.[0];
  const candidates = [
    iso,
    normalized.replace(/\bIST\b/gi, "GMT+0530"),
    normalized.replace(/^[^:\d]{2,40}:\s*/, "").replace(/\bIST\b/gi, "GMT+0530"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function documentTimestampMatches(
  document: SuppliedSourceDocument,
  evidenceText: string | null | undefined,
  normalizedTimestamp: string | null | undefined,
): boolean {
  if (!evidenceText || !normalizedTimestamp || !documentContainsFact(document, evidenceText)) return false;
  if (!/(?:T|\b)\d{1,2}:\d{2}/i.test(evidenceText)) return false;
  const evidenceTime = parsedEvidenceTimestamp(evidenceText);
  const normalizedTime = Date.parse(normalizedTimestamp);
  return evidenceTime !== null && Number.isFinite(normalizedTime) && Math.abs(evidenceTime - normalizedTime) < 60_000;
}

function hostnameMatchesDomain(rawUrl: string, allowedDomain: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    const domain = allowedDomain.toLowerCase().replace(/^www\./, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export type OpenAiGrounding = {
  searched: boolean;
  sourceUrls: string[];
  citationUrls: string[];
};

export function extractOpenAiGrounding(response: Pick<Response, "output">): OpenAiGrounding {
  const sourceUrls = new Set<string>();
  const citationUrls = new Set<string>();
  let searched = false;
  for (const item of response.output) {
    if (item.type === "web_search_call") {
      if (item.status === "completed") searched = true;
      if (item.action.type === "search") {
        for (const source of item.action.sources ?? []) {
          const normalized = canonicalUrl(source.url);
          if (normalized) sourceUrls.add(normalized);
        }
      } else if (item.action.type === "open_page" && item.action.url) {
        const normalized = canonicalUrl(item.action.url);
        if (normalized) sourceUrls.add(normalized);
      } else if (item.action.type === "find_in_page") {
        const normalized = canonicalUrl(item.action.url);
        if (normalized) sourceUrls.add(normalized);
      }
      continue;
    }
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations) {
        if (annotation.type !== "url_citation") continue;
        if (annotation.start_index < 0 || annotation.end_index < annotation.start_index || annotation.end_index > content.text.length) continue;
        const normalized = canonicalUrl(annotation.url);
        if (normalized) citationUrls.add(normalized);
      }
    }
  }
  return { searched, sourceUrls: [...sourceUrls], citationUrls: [...citationUrls] };
}

export function isGroundedProviderUrl(rawUrl: string, grounding: OpenAiGrounding, allowedDomains: readonly string[], requireCitation: boolean): boolean {
  const normalized = canonicalUrl(rawUrl);
  if (!normalized || !allowedDomains.some((domain) => hostnameMatchesDomain(normalized, domain))) return false;
  const providerSources = new Set(grounding.sourceUrls);
  if (!providerSources.has(normalized)) return false;
  return !requireCitation || new Set(grounding.citationUrls).has(normalized);
}

export function buildOpenAiRequest(
  model: string,
  prompt: string,
  kind: "jobs" | "events",
  webSearchDomains?: readonly string[],
): ResponseCreateParamsNonStreaming {
  return {
    model,
    input: prompt,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: kind === "jobs" ? "cirkle_job_scan" : "cirkle_event_scan",
        strict: true,
        schema: kind === "jobs" ? jobJsonSchema : eventJsonSchema,
      },
    },
    ...(webSearchDomains?.length ? {
      tools: [{
        type: "web_search" as const,
        external_web_access: true,
        search_context_size: "medium" as const,
        filters: { allowed_domains: [...new Set(webSearchDomains.map((domain) => domain.toLowerCase()))] },
      }],
      tool_choice: "required" as const,
      include: ["web_search_call.action.sources" as const],
    } : {}),
  };
}

const privateV4 = (address: string): boolean => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0, c = 0] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
};

const privateV6 = (address: string): boolean => {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedV4 = normalized.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedV4) return privateV4(mappedV4);
  return normalized === "::1" || normalized === "::"
    || normalized.startsWith("::ffff:") || normalized.startsWith("ff")
    || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb")
    || normalized.startsWith("2001:db8:");
};

export async function assertPublicUrl(raw: string, signal?: AbortSignal): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "invalid_source_url", "Source URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new ApiError(400, "unsafe_source_url", "Source URLs must be credential-free HTTPS URLs on the default port");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new ApiError(400, "unsafe_source_url", "Private source hosts are not allowed");
  }
  const lookupOperation = isIP(hostname) ? Promise.resolve([{ address: hostname }]) : lookup(hostname, { all: true, verbatim: true });
  const addresses = signal ? await raceWithSignal(lookupOperation, signal) : await lookupOperation;
  if (!addresses.length || addresses.some(({ address }) => isIP(address) === 4 ? privateV4(address) : privateV6(address))) {
    throw new ApiError(400, "unsafe_source_url", "Source host resolves to a non-public address");
  }
  return url;
}

async function sourceText(raw: string, parentSignal: AbortSignal): Promise<SuppliedSourceDocument> {
  const phase = createPhaseSignal(parentSignal, AI_SCAN_SOURCE_TIMEOUT_MS);
  try {
    let url = await assertPublicUrl(raw, phase.signal);
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": "CirkleScanner/1.0", Accept: "text/html,text/plain,application/json" },
        signal: phase.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === 3) throw new ApiError(502, "source_redirect_failed", "Source redirected too many times");
        url = await assertPublicUrl(new URL(location, url).toString(), phase.signal);
        continue;
      }
      if (!response.ok) throw new ApiError(502, "source_fetch_failed", `Source returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/json")) {
        throw new ApiError(415, "unsupported_source_type", "Source must be HTML, plain text, or JSON");
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > 750_000) throw new ApiError(413, "source_too_large", "Source response is too large");
      const text = await raceWithSignal(response.text(), phase.signal);
      if (Buffer.byteLength(text) > 750_000) throw new ApiError(413, "source_too_large", "Source response is too large");
      return buildSuppliedSourceDocument(text, raw, url.toString());
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
  try {
    return JSON.parse(fenced ?? text);
  } catch {
    throw new ApiError(502, "invalid_ai_response", "The AI provider returned invalid JSON");
  }
}

type ProviderResult = {
  data: unknown;
  grounding?: OpenAiGrounding;
};

async function runProvider(
  provider: string,
  model: string,
  prompt: string,
  kind: "jobs" | "events",
  parentSignal: AbortSignal,
  webSearchDomains?: readonly string[],
): Promise<ProviderResult> {
  const phase = createPhaseSignal(parentSignal, AI_SCAN_PROVIDER_TIMEOUT_MS);
  try {
    if (provider === "openai") {
      if (!config.OPENAI_API_KEY) throw new ApiError(503, "openai_not_configured", "OpenAI is not configured");
      if (webSearchDomains?.length && !modelSupportsOpenAiWebSearch(model)) {
        throw new ApiError(503, "openai_web_search_model_unsupported", `The configured OpenAI model (${model}) is not approved for grounded web discovery`);
      }
      const response = await raceWithSignal(new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        timeout: AI_SCAN_PROVIDER_TIMEOUT_MS,
        maxRetries: 0,
      }).responses.create(
        buildOpenAiRequest(model, prompt, kind, webSearchDomains),
        { signal: phase.signal, timeout: AI_SCAN_PROVIDER_TIMEOUT_MS, maxRetries: 0 },
      ), phase.signal);
      if (response.status !== "completed" || !response.output_text.trim()) {
        throw new ApiError(502, "incomplete_ai_response", "OpenAI did not return a complete scan result");
      }
      if (!webSearchDomains?.length) return { data: jsonFromModel(response.output_text) };
      const grounding = extractOpenAiGrounding(response);
      const providerSources = new Set(grounding.sourceUrls);
      const citedProviderSources = grounding.citationUrls.filter((url) => providerSources.has(url));
      if (!grounding.searched || !providerSources.size || !citedProviderSources.length) {
        throw new ApiError(502, "ungrounded_ai_response", "OpenAI discovery returned no verifiable cited web sources; no listings were imported");
      }
      return { data: jsonFromModel(response.output_text), grounding: { ...grounding, citationUrls: citedProviderSources } };
    }
    if (provider === "gemini") {
      if (webSearchDomains?.length) {
        throw new ApiError(501, "gemini_web_discovery_not_enabled", "Gemini remains available for explicit source URLs; grounded Gemini web discovery is not enabled");
      }
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
      return { data: jsonFromModel(String(response.text ?? "")) };
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
  const providers = [config.OPENAI_API_KEY ? "openai" : null, config.GEMINI_API_KEY ? "gemini" : null].filter((provider): provider is "openai" | "gemini" => Boolean(provider));
  const openAiWebDiscovery = Boolean(config.OPENAI_API_KEY && modelSupportsOpenAiWebSearch(config.OPENAI_MODEL));
  return {
    ready: providers.length > 0,
    configured_providers: providers,
    providers,
    openai: Boolean(config.OPENAI_API_KEY),
    gemini: Boolean(config.GEMINI_API_KEY),
    openai_web_discovery: openAiWebDiscovery,
    openai_web_discovery_reason: openAiWebDiscovery
      ? null
      : !config.OPENAI_API_KEY
        ? "OPENAI_API_KEY is not configured"
        : `OPENAI_MODEL (${config.OPENAI_MODEL}) is not approved for grounded web search`,
    default_models: { openai: config.OPENAI_MODEL, gemini: config.GEMINI_MODEL },
    experience_buckets: JOB_EXPERIENCE_BUCKETS,
    institute_sources: IIT_EVENT_SOURCES,
  };
}

function requestedJobBucket(value: unknown): JobBucket {
  if (typeof value !== "string" || !JOB_EXPERIENCE_BUCKETS.includes(value as JobBucket)) {
    throw new ApiError(400, "invalid_experience_bucket", "Choose one of the seven supported experience buckets");
  }
  return value as JobBucket;
}

function normalizeJobType(value: string | null | undefined, bucket: JobBucket): string {
  if (bucket === "Internship") return "Internship";
  const text = value?.toLowerCase() ?? "";
  if (text.includes("part")) return "Part-time";
  if (text.includes("contract")) return "Contract";
  return "Full-time";
}

type ValidJob = JobCandidate & {
  apply_url: string;
  source_url: string;
  sourcePublishedAt: string;
  experienceBucket: JobBucket;
};

type ValidEvent = EventCandidate & {
  source_url: string;
  registration_url?: string | null;
};

export function groundExplicitJobCandidate(
  item: JobCandidate,
  documents: readonly SuppliedSourceDocument[],
): JobBucket | null {
  const document = sourceDocumentFor(item.source_document_url, documents);
  if (!document || !documentReferencesUrl(document, item.source_url) || !documentReferencesUrl(document, item.apply_url)) return null;
  if (!item.source_record_text || !documentContainsFact(document, item.source_record_text)) return null;
  const recordDocument = { ...document, content: normalizedSourceText(item.source_record_text) };
  if (!documentContainsFact(recordDocument, item.title) || !documentContainsFact(document, item.company)) return null;
  if (!documentTimestampMatches(recordDocument, item.published_at_text, item.published_at)) return null;

  const experienceEvidence = item.experience
    ?? (/\b(?:intern|internship|trainee)\b/i.test(item.job_type ?? "") ? item.job_type : null)
    ?? (/\b(?:intern|internship|trainee)\b/i.test(item.title) ? item.title : null);
  if (!experienceEvidence || !documentContainsFact(recordDocument, experienceEvidence)) return null;
  const experienceBucket = normalizeExperienceBucket(experienceEvidence, item.job_type);
  if (!experienceBucket || item.experience_level !== experienceBucket) return null;

  const factualText = [item.location, item.description, item.job_type, item.category, item.salary_text];
  if (factualText.some((value) => value && !documentContainsFact(recordDocument, value))) return null;
  if (item.skills?.some((skill) => !documentContainsFact(recordDocument, skill))) return null;
  if (Boolean(item.expires_at) !== Boolean(item.expires_at_text)) return null;
  if (item.expires_at && !documentTimestampMatches(document, item.expires_at_text, item.expires_at)) return null;
  return experienceBucket;
}

export function isExplicitEventCandidateGrounded(
  item: EventCandidate,
  documents: readonly SuppliedSourceDocument[],
): boolean {
  const document = sourceDocumentFor(item.source_document_url, documents);
  if (!document || !documentReferencesUrl(document, item.source_url)) return false;
  if (item.registration_url && !documentReferencesUrl(document, item.registration_url)) return false;
  if (!item.source_record_text || !documentContainsFact(document, item.source_record_text)) return false;
  const recordDocument = { ...document, content: normalizedSourceText(item.source_record_text) };
  if (!documentContainsFact(recordDocument, item.title) || !documentTimestampMatches(recordDocument, item.start_time_text, item.start_time)) return false;
  if (Boolean(item.end_time) !== Boolean(item.end_time_text)) return false;
  if (item.end_time && !documentTimestampMatches(recordDocument, item.end_time_text, item.end_time)) return false;
  return ![item.description, item.location, item.organizer]
    .some((value) => value && !documentContainsFact(recordDocument, value));
}

async function validateJobs(
  items: JobCandidate[],
  scannedAt: Date,
  deadline: ScanDeadline,
  grounding: OpenAiGrounding | undefined,
  webSearchDomains: readonly string[] | undefined,
  discoveryBucket: JobBucket | undefined,
  documents: readonly SuppliedSourceDocument[],
): Promise<ValidJob[]> {
  const checked = await Promise.all(items.map(async (item): Promise<ValidJob | null> => {
    const sourcePublishedAt = parseFreshJobPublishedAt(item.published_at, scannedAt.getTime());
    const declaredBucket = typeof item.experience_level === "string"
      && JOB_EXPERIENCE_BUCKETS.includes(item.experience_level as JobBucket)
      ? item.experience_level as JobBucket
      : null;
    const sourceRequirementBucket = normalizeExperienceBucket(item.experience, item.job_type);
    const groundedDiscoveryBucket = declaredBucket && sourceRequirementBucket === declaredBucket
      ? declaredBucket
      : null;
    const experienceBucket = grounding
      ? groundedDiscoveryBucket
      : groundExplicitJobCandidate(item, documents);
    if (!sourcePublishedAt || !experienceBucket || (discoveryBucket && experienceBucket !== discoveryBucket)) return null;
    if (!isLikelyJobDetailUrl(item.apply_url)) return null;
    const applyUrl = canonicalUrl(item.apply_url);
    const sourceUrl = canonicalUrl(item.source_url);
    if (!applyUrl || !sourceUrl) return null;
    if (grounding && webSearchDomains) {
      if (!isGroundedProviderUrl(sourceUrl, grounding, webSearchDomains, true)) return null;
      if (!isGroundedProviderUrl(applyUrl, grounding, webSearchDomains, false)) return null;
    }
    try {
      await Promise.all([
        assertPublicUrl(applyUrl, deadline.networkSignal),
        assertPublicUrl(sourceUrl, deadline.networkSignal),
      ]);
    } catch {
      return null;
    }
    if (item.expires_at && new Date(item.expires_at) <= scannedAt) return null;
    return { ...item, apply_url: applyUrl, source_url: sourceUrl, sourcePublishedAt, experienceBucket };
  }));
  return checked.filter((item): item is ValidJob => item !== null);
}

async function validateEvents(
  items: EventCandidate[],
  scannedAt: Date,
  deadline: ScanDeadline,
  grounding: OpenAiGrounding | undefined,
  webSearchDomains: readonly string[] | undefined,
  documents: readonly SuppliedSourceDocument[],
): Promise<ValidEvent[]> {
  const checked = await Promise.all(items.map(async (item): Promise<ValidEvent | null> => {
    const startsAt = new Date(item.start_time);
    if (!Number.isFinite(startsAt.getTime()) || startsAt <= scannedAt) return null;
    if (item.end_time) {
      const endsAt = new Date(item.end_time);
      if (!Number.isFinite(endsAt.getTime()) || endsAt < startsAt) return null;
    }
    const sourceUrl = canonicalUrl(item.source_url);
    if (!sourceUrl) return null;
    if (!grounding && !isExplicitEventCandidateGrounded(item, documents)) return null;
    if (grounding && webSearchDomains && !isGroundedProviderUrl(sourceUrl, grounding, webSearchDomains, true)) return null;
    let registrationUrl = item.registration_url ? canonicalUrl(item.registration_url) : null;
    if (item.registration_url && !registrationUrl) return null;
    if (registrationUrl && grounding && webSearchDomains && !isGroundedProviderUrl(registrationUrl, grounding, webSearchDomains, false)) {
      registrationUrl = null;
    }
    try {
      await Promise.all([
        assertPublicUrl(sourceUrl, deadline.networkSignal),
        ...(registrationUrl ? [assertPublicUrl(registrationUrl, deadline.networkSignal)] : []),
      ]);
    } catch {
      return null;
    }
    return { ...item, source_url: sourceUrl, registration_url: registrationUrl };
  }));
  return checked.filter((item): item is ValidEvent => item !== null);
}

export async function scanWithAi(kind: "jobs" | "events", body: Record<string, unknown>, ctx: RequestContext): Promise<Record<string, unknown>> {
  if (ctx.auth.role !== "admin" && ctx.auth.role !== "owner") {
    throw new ApiError(403, "admin_required", "Administrator access is required");
  }
  if (body.action === "status") return scannerStatus();

  const deadline = new ScanDeadline();
  try {
    const isDiscovery = body.action === "discover";
    let effective = { ...body };
    let savedSourceRecordId: string | undefined;
    if (kind === "jobs" && typeof body.source_id === "string") {
      const sources = await deadline.network(prisma.legacyRecord.findMany({ where: { table_name: "job_scan_sources" }, take: 2000 }));
      const sourceRecord = sources.find((record) => (record.data as Record<string, unknown>).id === body.source_id);
      const source = sourceRecord?.data as Record<string, unknown> | undefined;
      if (!sourceRecord || !source || typeof source.source_url !== "string") {
        throw new ApiError(404, "scan_source_not_found", "Saved scan source not found");
      }
      savedSourceRecordId = sourceRecord.id;
      effective = { ...source, ...body, source_urls: [source.source_url], publish_mode: source.auto_publish === true ? "published" : "draft" };
    }
    if (kind === "jobs" && body.action === "recruiter_batch") {
      const sources = Array.isArray(body.sources) ? body.sources : [];
      const sourceUrls = sources.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).source_url === "string"
        ? [(item as Record<string, unknown>).source_url as string]
        : []).slice(0, 10);
      effective = { ...body, source_urls: sourceUrls, publish_mode: "draft" };
    }

    const provider = isDiscovery ? "openai" : typeof effective.provider === "string" ? effective.provider : "openai";
    const model = isDiscovery
      ? config.OPENAI_MODEL
      : typeof effective.model === "string" && effective.model.trim()
        ? effective.model.trim().slice(0, 120)
        : provider === "gemini" ? config.GEMINI_MODEL : config.OPENAI_MODEL;
    if (isDiscovery && (!config.OPENAI_API_KEY || !modelSupportsOpenAiWebSearch(model))) {
      throw new ApiError(503, "web_discovery_not_configured", scannerStatus().openai_web_discovery_reason as string);
    }

    let discoveryBucket: JobBucket | undefined;
    let webSearchDomains: readonly string[] | undefined;
    let urls: string[];
    if (isDiscovery && kind === "jobs") {
      discoveryBucket = requestedJobBucket(body.experience_bucket);
      webSearchDomains = TRUSTED_JOB_DOMAINS;
      urls = TRUSTED_JOB_DOMAINS.map((domain) => `https://${domain}`);
    } else if (isDiscovery) {
      const sourceIit = typeof body.source_iit === "string" ? body.source_iit.trim() : "";
      const officialSource = IIT_EVENT_SOURCES.find((source) => source.name === sourceIit);
      if (!officialSource) throw new ApiError(400, "unsupported_iit_source", "Choose one of the 23 supported IITs for official-source discovery");
      webSearchDomains = [officialSource.domain];
      urls = [`https://${officialSource.domain}`];
    } else {
      urls = Array.isArray(effective.source_urls)
        ? [...new Set(effective.source_urls.filter((item): item is string => typeof item === "string"))].slice(0, 10)
        : [];
      if (!urls.length) throw new ApiError(400, "sources_required", "At least one source URL is required");
    }

    const documents = isDiscovery
      ? []
      : await deadline.network(Promise.all(urls.map((url) => sourceText(url, deadline.networkSignal))));
    const scannedAt = new Date();
    const target = kind === "jobs" ? "active job listings" : "future events";
    const instructions = typeof effective.instructions === "string" ? effective.instructions.slice(0, 4000) : "";
    const prompt = [
      `Extract ${target}. The authoritative current timestamp is ${scannedAt.toISOString()}. Return only the requested JSON schema.`,
      kind === "jobs"
        ? "Return an object shaped as {\"jobs\":[{\"title\":\"...\",\"company\":\"...\",\"location\":null,\"description\":null,\"job_type\":null,\"category\":null,\"experience\":null,\"experience_level\":null,\"salary_text\":null,\"skills\":null,\"apply_url\":\"https://...\",\"source_url\":\"https://...\",\"source_document_url\":null,\"source_record_text\":null,\"published_at\":\"ISO-8601 with timezone\",\"published_at_text\":null,\"expires_at\":null,\"expires_at_text\":null}]}."
        : "Return an object shaped as {\"events\":[{\"title\":\"...\",\"description\":null,\"location\":null,\"start_time\":\"ISO-8601 with timezone\",\"end_time\":null,\"organizer\":null,\"registration_url\":null,\"source_url\":\"https://...\",\"source_document_url\":null,\"source_record_text\":null,\"start_time_text\":null,\"end_time_text\":null}]}. Use null only for optional fields.",
      "Never invent titles, dates, URLs, companies, locations, requirements, venues, or organizers. Omit any record whose required evidence is absent or ambiguous.",
      kind === "jobs"
        ? `Every job must contain: a direct HTTPS job-detail/apply_url; the official source_url that explicitly displays the role; an explicit source published_at timestamp within the preceding 24 hours; the source's requirement text in experience; and experience_level normalized from that text to exactly one of ${JOB_EXPERIENCE_BUCKETS.join(", ")}. Omit undated, stale, future-dated, closed, generic careers-page, or ambiguous roles.`
        : "Every event must have a confirmed future start_time and an official HTTPS source_url. Exclude past events, routine notices, admissions deadlines, tenders, jobs, and undated announcements.",
      isDiscovery
        ? `You must use web search. Search only ${webSearchDomains!.join(", ")}. Each source_url must exactly match a web result you cite, and every other returned URL must exactly match a page consulted by the web-search tool. Set source_document_url, source_record_text, and all *_text evidence fields to null.${kind === "jobs" ? ` Return at most six ${discoveryBucket} listings and only when the official requirements support that bucket.` : " Return at most eight of the most important institute-wide events."}`
        : "Use only the supplied source documents and do not use general model knowledge. For every item, source_document_url must equal its SOURCE DOCUMENT_URL. Every returned URL must occur in that document. Copy a single contiguous source_record_text excerpt that ties the record's title, timestamp, experience or organizer, and other facts together. Copy every factual text field verbatim from that excerpt (company may come from the same document header). Copy each source timestamp verbatim into its corresponding *_text field and normalize that same instant into the ISO-8601 field. Omit an item when any evidence is absent or ambiguous. Do not imply that a live web search occurred.",
      instructions ? `Operator instructions: ${instructions}` : "",
      ...documents.map((document, index) => "SOURCE " + (index + 1) + " DOCUMENT_URL=" + document.requestedUrl
        + (document.resolvedUrl !== document.requestedUrl ? " RESOLVED_URL=" + document.resolvedUrl : "")
        + "\n" + document.content),
    ].filter(Boolean).join("\n\n");

    const providerResult = await runProvider(provider, model, prompt, kind, deadline.networkSignal, webSearchDomains);
    const parsedJobs = kind === "jobs" ? jobScanSchema.parse(providerResult.data).jobs : [];
    const parsedEvents = kind === "events" ? eventScanSchema.parse(providerResult.data).events : [];
    const validJobs = kind === "jobs"
      ? await deadline.network(validateJobs(parsedJobs, scannedAt, deadline, providerResult.grounding, webSearchDomains, discoveryBucket, documents))
      : [];
    const validEvents = kind === "events"
      ? (await deadline.network(validateEvents(parsedEvents, scannedAt, deadline, providerResult.grounding, webSearchDomains, documents))).slice(0, isDiscovery ? 8 : 100)
      : [];
    const groundedSourceUrls = [...new Set(kind === "jobs"
      ? validJobs.flatMap((item) => [item.source_url, item.apply_url])
      : validEvents.flatMap((item) => [item.source_url, ...(item.registration_url ? [item.registration_url] : [])]))];

    const runId = newId();
    const discovered = kind === "jobs" ? parsedJobs.length : parsedEvents.length;
    const rejectedBeforeCommit = discovered - (kind === "jobs" ? validJobs.length : validEvents.length);
    const publish = effective.publish_mode === "published" && !isDiscovery ? "published" : "draft";
    const audience = effective.audience && typeof effective.audience === "object" ? effective.audience as Record<string, unknown> : {};
    const counts = await commitWithinScanDeadline(deadline, ({ timeout, maxWait, assertActive }) => prisma.$transaction(async (tx) => {
      let imported = 0;
      let skipped = rejectedBeforeCommit;
      assertActive();
      if (kind === "jobs") {
        for (const item of validJobs) {
          assertActive();
          const fingerprint = sha256(item.apply_url);
          const existing = await tx.job.findFirst({ where: { OR: [{ source_fingerprint: fingerprint }, { apply_url: item.apply_url }] } });
          assertActive();
          if (existing) {
            skipped += 1;
            await tx.job.update({ where: { id: existing.id }, data: { last_seen_at: scannedAt } });
          } else {
            await tx.job.create({ data: {
              created_by: ctx.auth.id,
              community_id: ctx.auth.community_id,
              title: replaceLongDashes(item.title),
              company: replaceLongDashes(item.company),
              location: item.location ? replaceLongDashes(item.location) : "Not specified",
              description: item.description ? replaceLongDashes(item.description) : undefined,
              job_type: normalizeJobType(item.job_type, item.experienceBucket),
              category: item.category ? replaceLongDashes(item.category) : undefined,
              experience: item.experience ?? undefined,
              experience_level: item.experienceBucket,
              salary_text: item.salary_text ? replaceLongDashes(item.salary_text) : undefined,
              skills: item.skills ?? undefined,
              apply_url: item.apply_url,
              application_url: item.apply_url,
              source_url: item.source_url,
              source_type: "ai_scan",
              status: publish,
              source_fingerprint: fingerprint,
              scan_run_id: runId,
              discovered_at: scannedAt,
              last_seen_at: scannedAt,
              published_at: publish === "published" ? scannedAt : undefined,
              expires_at: item.expires_at ? new Date(item.expires_at) : undefined,
              created_at: new Date(item.sourcePublishedAt),
            } });
            imported += 1;
          }
          assertActive();
        }
      } else {
        for (const item of validEvents) {
          assertActive();
          const fingerprint = sha256(`${item.title.toLowerCase()}|${item.start_time}|${item.source_url}`);
          const existing = await tx.event.findUnique({ where: { source_fingerprint: fingerprint } });
          assertActive();
          if (existing) {
            skipped += 1;
            continue;
          }
          await tx.event.create({ data: {
            title: replaceLongDashes(item.title),
            description: item.description ? replaceLongDashes(item.description) : undefined,
            location: item.location ? replaceLongDashes(item.location) : undefined,
            start_time: new Date(item.start_time),
            end_time: item.end_time ? new Date(item.end_time) : undefined,
            organizer: item.organizer ? replaceLongDashes(item.organizer) : undefined,
            organizer_name: item.organizer ? replaceLongDashes(item.organizer) : undefined,
            registration_url: item.registration_url ?? undefined,
            source_url: item.source_url,
            source_iit: typeof effective.source_iit === "string" ? effective.source_iit : undefined,
            source_type: "ai_scan",
            status: publish,
            community_id: ctx.auth.community_id,
            created_by: ctx.auth.id,
            audience_mode: typeof audience.mode === "string" ? audience.mode : "everyone",
            target_iits: Array.isArray(audience.iits) ? audience.iits as Prisma.InputJsonValue : undefined,
            target_courses: Array.isArray(audience.courses) ? audience.courses as Prisma.InputJsonValue : undefined,
            target_specialisations: Array.isArray(audience.specialisations) ? audience.specialisations as Prisma.InputJsonValue : undefined,
            source_fingerprint: fingerprint,
            scan_run_id: runId,
            published_at: publish === "published" ? scannedAt : undefined,
          } });
          imported += 1;
          assertActive();
        }
      }
      await tx.legacyRecord.create({ data: {
        table_name: kind === "jobs" ? "job_scan_runs" : "event_scan_runs",
        record_id: runId,
        owner_id: ctx.auth.id,
        community_id: ctx.auth.community_id,
        data: {
          id: runId,
          provider,
          model,
          status: "completed",
          action: isDiscovery ? "discover" : typeof body.action === "string" ? body.action : "extract",
          discovered_count: discovered,
          imported_count: imported,
          skipped_count: skipped,
          company: typeof effective.company === "string" ? effective.company : null,
          source_urls: urls,
          grounded_source_urls: groundedSourceUrls,
          experience_bucket: discoveryBucket ?? null,
          created_at: scannedAt.toISOString(),
          completed_at: new Date().toISOString(),
        },
      } });
      assertActive();
      if (savedSourceRecordId) {
        const sourceRecord = await tx.legacyRecord.findUnique({ where: { id: savedSourceRecordId } });
        if (sourceRecord) {
          await tx.legacyRecord.update({ where: { id: savedSourceRecordId }, data: { data: {
            ...(sourceRecord.data as Record<string, unknown>),
            last_scanned_at: scannedAt.toISOString(),
            last_scan_status: "completed",
            last_error: null,
            updated_at: scannedAt.toISOString(),
          } as Prisma.InputJsonValue } });
        }
        assertActive();
      }
      await tx.auditLog.create({ data: {
        actor_id: ctx.auth.id,
        action: `ai.scan_${kind}`,
        resource_type: "scan_run",
        resource_id: runId,
        ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined,
        metadata: { provider, model, imported, skipped, discovery: isDiscovery, grounded_sources: groundedSourceUrls.length },
      } });
      assertActive();
      return { imported, skipped };
    }, { timeout, maxWait }));
    return {
      run_id: runId,
      scan_run_id: runId,
      discovered,
      ...counts,
      provider,
      model,
      publish_mode: publish,
      experience_bucket: discoveryBucket ?? null,
      grounded_source_count: groundedSourceUrls.length,
    };
  } catch (error) {
    if (deadline.networkSignal.aborted && !(error instanceof ApiError && ["scan_deadline_exceeded", "scan_commit_timeout"].includes(error.code))) {
      throw scanDeadlineError();
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}
