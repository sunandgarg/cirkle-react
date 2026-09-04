import { describe, expect, it } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import {
  JOB_EXPERIENCE_BUCKETS,
  JOB_FRESHNESS_WINDOW_MS,
  buildSuppliedSourceDocument,
  buildOpenAiRequest,
  extractOpenAiGrounding,
  groundExplicitJobCandidate,
  isExplicitEventCandidateGrounded,
  isGroundedProviderUrl,
  isLikelyJobDetailUrl,
  modelSupportsOpenAiWebSearch,
  normalizeExperienceBucket,
  parseFreshJobPublishedAt,
  scanWithAi,
} from "../src/services/ai.js";
import type { RequestContext } from "../src/types.js";

describe("AI scanner job policy", () => {
  it("rejects scanner status and scan actions for non-admin members", async () => {
    const member: RequestContext = {
      auth: { id: "member", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: true },
    };
    await expect(scanWithAi("jobs", { action: "status" }, member)).rejects.toMatchObject({ code: "admin_required" });
  });

  it("keeps the exact seven experience buckets and normalizes only supported evidence", () => {
    expect(JOB_EXPERIENCE_BUCKETS).toEqual([
      "Internship", "0-1 years", "1-2 years", "2-3 years", "3-5 years", "5-7 years", "7+ years",
    ]);
    expect(normalizeExperienceBucket("summer intern")).toBe("Internship");
    expect(normalizeExperienceBucket("0 to 1 year")).toBe("0-1 years");
    expect(normalizeExperienceBucket("1-2 years")).toBe("1-2 years");
    expect(normalizeExperienceBucket("3 - 5 years")).toBe("3-5 years");
    expect(normalizeExperienceBucket("5–7 yrs")).toBe("5-7 years");
    expect(normalizeExperienceBucket("8 years")).toBe("7+ years");
    expect(normalizeExperienceBucket("0+ years")).toBe("0-1 years");
    expect(normalizeExperienceBucket("1+ year")).toBe("1-2 years");
    expect(normalizeExperienceBucket("2 plus years")).toBe("2-3 years");
    expect(normalizeExperienceBucket("3+ years")).toBe("3-5 years");
    expect(normalizeExperienceBucket("4+ years")).toBe("3-5 years");
    expect(normalizeExperienceBucket("4 years or more")).toBe("3-5 years");
    expect(normalizeExperienceBucket("5+ years")).toBe("5-7 years");
    expect(normalizeExperienceBucket("6 or more years")).toBe("5-7 years");
    expect(normalizeExperienceBucket("7+ years")).toBe("7+ years");
    expect(normalizeExperienceBucket("entry level")).toBeNull();
  });

  it("requires an explicit source publication time within 24 hours with bounded future skew", () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    const boundary = new Date(now - JOB_FRESHNESS_WINDOW_MS).toISOString();
    expect(parseFreshJobPublishedAt(boundary, now)).toBe(boundary);
    expect(parseFreshJobPublishedAt("2026-09-04T12:05:00.000Z", now)).toBe("2026-09-04T12:05:00.000Z");
    expect(parseFreshJobPublishedAt("2026-09-03T11:59:59.999Z", now)).toBeNull();
    expect(parseFreshJobPublishedAt("2026-09-04T12:05:00.001Z", now)).toBeNull();
    expect(parseFreshJobPublishedAt(undefined, now)).toBeNull();
    expect(parseFreshJobPublishedAt("today", now)).toBeNull();
  });

  it("rejects generic careers pages as job application details", () => {
    expect(isLikelyJobDetailUrl("https://example.com/careers")).toBe(false);
    expect(isLikelyJobDetailUrl("https://example.com/jobs")).toBe(false);
    expect(isLikelyJobDetailUrl("https://example.com/jobs/REQ-123/software-engineer")).toBe(true);
    expect(isLikelyJobDetailUrl("https://boards.example.com/company?gh_jid=12345")).toBe(true);
  });
});

describe("explicit source document grounding", () => {
  const document = buildSuppliedSourceDocument(`
    <html>
      <head><meta content="Cirkle Labs"></head>
      <body>
        <script>window.tracker = "https://careers.example.com/jobs/injected";</script>
        <h1>Platform Engineer</h1>
        <p>Cirkle Labs</p><p>Bengaluru</p><p>Build secure APIs.</p>
        <p>Full-time</p><p>Engineering</p><p>3+ years</p><p>₹20 LPA</p><p>TypeScript</p>
        <time datetime="2026-09-04T10:00:00Z">4 September 2026, 10:00 UTC</time>
        <a href="/jobs/role-123">Apply</a>
      </body>
    </html>
  `, "https://careers.example.com/jobs");

  const groundedJob = {
    title: "Platform Engineer",
    company: "Cirkle Labs",
    location: "Bengaluru",
    description: "Build secure APIs.",
    job_type: "Full-time",
    category: "Engineering",
    experience: "3+ years",
    experience_level: "3-5 years",
    salary_text: "₹20 LPA",
    skills: ["TypeScript"],
    apply_url: "https://careers.example.com/jobs/role-123",
    source_url: "https://careers.example.com/jobs/role-123",
    source_document_url: "https://careers.example.com/jobs",
    source_record_text: "Platform Engineer Cirkle Labs Bengaluru Build secure APIs. Full-time Engineering 3+ years ₹20 LPA TypeScript 2026-09-04T10:00:00Z",
    published_at: "2026-09-04T10:00:00.000Z",
    published_at_text: "2026-09-04T10:00:00Z",
    expires_at: null,
    expires_at_text: null,
  };

  it("accepts only URLs and core job facts proven by the fetched document", () => {
    expect(document.referenceUrls).toContain("https://careers.example.com/jobs/role-123");
    expect(document.referenceUrls).not.toContain("https://careers.example.com/jobs/injected");
    expect(groundExplicitJobCandidate(groundedJob, [document])).toBe("3-5 years");
    expect(groundExplicitJobCandidate({ ...groundedJob, title: "Invented Distinguished Engineer" }, [document])).toBeNull();
    expect(groundExplicitJobCandidate({ ...groundedJob, apply_url: "https://careers.example.com/jobs/invented" }, [document])).toBeNull();
    expect(groundExplicitJobCandidate({ ...groundedJob, published_at: "2026-09-04T11:00:00.000Z" }, [document])).toBeNull();
  });

  it("rejects event facts or links absent from the fetched document", () => {
    const eventDocument = buildSuppliedSourceDocument(`
      <h1>Founders Day Lecture</h1><p>Main Auditorium</p><p>IIT Example</p>
      <p>A public lecture.</p><time datetime="2026-10-01T09:30:00Z">1 October 2026, 09:30 UTC</time>
      <a href="/events/founders-day">Details</a><a href="/events/founders-day/register">Register</a>
    `, "https://www.iit.example/events");
    const event = {
      title: "Founders Day Lecture",
      description: "A public lecture.",
      location: "Main Auditorium",
      start_time: "2026-10-01T09:30:00.000Z",
      end_time: null,
      organizer: "IIT Example",
      registration_url: "https://www.iit.example/events/founders-day/register",
      source_url: "https://www.iit.example/events/founders-day",
      source_document_url: "https://www.iit.example/events",
      source_record_text: "Founders Day Lecture Main Auditorium IIT Example A public lecture. 2026-10-01T09:30:00Z",
      start_time_text: "2026-10-01T09:30:00Z",
      end_time_text: null,
    };
    expect(isExplicitEventCandidateGrounded(event, [eventDocument])).toBe(true);
    expect(isExplicitEventCandidateGrounded({ ...event, organizer: "Invented Organizer" }, [eventDocument])).toBe(false);
    expect(isExplicitEventCandidateGrounded({ ...event, registration_url: "https://tickets.example.net/invented" }, [eventDocument])).toBe(false);
  });
});

describe("OpenAI Responses grounded web discovery", () => {
  it("enables only reviewed web-search-capable model aliases", () => {
    expect(modelSupportsOpenAiWebSearch("gpt-5.4-mini")).toBe(true);
    expect(modelSupportsOpenAiWebSearch("gpt-5.4-mini-2026-03-17")).toBe(true);
    expect(modelSupportsOpenAiWebSearch("GPT-5.4-MINI")).toBe(false);
    expect(modelSupportsOpenAiWebSearch("gpt-5.4")).toBe(false);
    expect(modelSupportsOpenAiWebSearch("gpt-5-mini")).toBe(false);
    expect(modelSupportsOpenAiWebSearch("custom-model")).toBe(false);
  });

  it("forces hosted web search and requests provider source metadata for discovery", () => {
    const request = buildOpenAiRequest(
      "gpt-5.4-mini",
      "Find recent roles",
      "jobs",
      ["Amazon.jobs", "amazon.jobs", "jobs.lever.co"],
    );
    expect(request.store).toBe(false);
    expect(request.tool_choice).toBe("required");
    expect(request.include).toEqual(["web_search_call.action.sources"]);
    expect(request.tools).toEqual([{
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
      filters: { allowed_domains: ["amazon.jobs", "jobs.lever.co"] },
    }]);
    expect(request.text?.format.type).toBe("json_schema");
  });

  it("does not attach a web-search tool to explicit URL extraction", () => {
    const request = buildOpenAiRequest("gpt-5.4-mini", "Use this document", "events");
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.include).toBeUndefined();
  });

  it("accepts only exact cited provider sources on the allowed domain", () => {
    const text = "{\"jobs\":[]}";
    const response = {
      output: [
        {
          id: "search_1",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            queries: ["recent jobs"],
            sources: [
              { type: "url", url: "https://amazon.jobs/en/jobs/123/engineer?utm_source=chatgpt.com" },
              { type: "url", url: "https://jobs.lever.co/acme/abc" },
            ],
          },
        },
        {
          id: "message_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{
            type: "output_text",
            text,
            annotations: [{
              type: "url_citation",
              start_index: 0,
              end_index: text.length,
              title: "Amazon job",
              url: "https://amazon.jobs/en/jobs/123/engineer",
            }],
          }],
        },
      ],
    } as unknown as Pick<Response, "output">;

    const grounding = extractOpenAiGrounding(response);
    expect(grounding.searched).toBe(true);
    expect(grounding.sourceUrls).toContain("https://amazon.jobs/en/jobs/123/engineer");
    expect(grounding.citationUrls).toEqual(["https://amazon.jobs/en/jobs/123/engineer"]);
    expect(isGroundedProviderUrl("https://amazon.jobs/en/jobs/123/engineer?utm_campaign=x", grounding, ["amazon.jobs"], true)).toBe(true);
    expect(isGroundedProviderUrl("https://jobs.lever.co/acme/abc", grounding, ["jobs.lever.co"], true)).toBe(false);
    expect(isGroundedProviderUrl("https://jobs.lever.co/acme/abc", grounding, ["jobs.lever.co"], false)).toBe(true);
    expect(isGroundedProviderUrl("https://evil.example/jobs/123", grounding, ["amazon.jobs"], false)).toBe(false);
  });

  it("drops malformed URL citation annotations", () => {
    const response = {
      output: [{
        id: "message_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: "{}",
          annotations: [{
            type: "url_citation",
            start_index: 0,
            end_index: 99,
            title: "bad span",
            url: "https://amazon.jobs/en/jobs/123/engineer",
          }],
        }],
      }],
    } as unknown as Pick<Response, "output">;
    expect(extractOpenAiGrounding(response)).toEqual({ searched: false, sourceUrls: [], citationUrls: [] });
  });
});
