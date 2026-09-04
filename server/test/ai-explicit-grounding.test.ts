import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../src/types.js";

const mocks = vi.hoisted(() => {
  const tx = {
    job: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "job-created" })),
      update: vi.fn(async () => ({})),
    },
    event: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "event-created" })),
    },
    legacyRecord: {
      create: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return {
    geminiGenerate: vi.fn(),
    openAiCreate: vi.fn(),
    transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    tx,
  };
});

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: mocks.openAiCreate };
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mocks.geminiGenerate };
  },
}));

vi.mock("../src/config.js", () => ({
  config: {
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_MODEL: "gpt-5.4-mini",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL: "gemini-2.5-flash",
    IP_HASH_SECRET: "test-ip-hash-secret",
    LOG_LEVEL: "silent",
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $transaction: mocks.transaction,
    legacyRecord: { findMany: vi.fn(async () => []) },
  },
}));

import { scanWithAi } from "../src/services/ai.js";

const admin: RequestContext = {
  auth: { id: "admin", email: "admin@example.com", role: "admin", community_id: "iit-community", is_verified: true },
};

const sourceUrl = "https://93.184.216.34/jobs";
const roleUrl = "https://93.184.216.34/jobs/role-123";
const sourceHtml = `
  <meta content="Cirkle Labs">
  <h1>Platform Engineer</h1>
  <p>Cirkle Labs</p><p>Bengaluru</p><p>Build secure APIs.</p>
  <p>Full-time</p><p>Engineering</p><p>3+ years</p><p>₹20 LPA</p><p>TypeScript</p>
  <time datetime="2026-09-04T10:00:00Z">4 September 2026, 10:00 UTC</time>
  <a href="/jobs/role-123">Apply</a>
`;

const candidate = (title: string) => ({
  jobs: [{
    title,
    company: "Cirkle Labs",
    location: "Bengaluru",
    description: "Build secure APIs.",
    job_type: "Full-time",
    category: "Engineering",
    experience: "3+ years",
    experience_level: "3-5 years",
    salary_text: "₹20 LPA",
    skills: ["TypeScript"],
    apply_url: roleUrl,
    source_url: roleUrl,
    source_document_url: sourceUrl,
    source_record_text: "Platform Engineer Cirkle Labs Bengaluru Build secure APIs. Full-time Engineering 3+ years ₹20 LPA TypeScript 2026-09-04T10:00:00Z",
    published_at: "2026-09-04T10:00:00.000Z",
    published_at_text: "2026-09-04T10:00:00Z",
    expires_at: null,
    expires_at_text: null,
  }],
});

describe("explicit-source scans before auto-publish", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sourceHtml, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("allows a fully document-grounded listing through the normal publish transaction", async () => {
    mocks.openAiCreate.mockResolvedValue({
      status: "completed",
      output_text: JSON.stringify(candidate("Platform Engineer")),
      output: [],
    });

    const result = await scanWithAi("jobs", {
      provider: "openai",
      source_urls: [sourceUrl],
      publish_mode: "published",
    }, admin);

    expect(result).toMatchObject({ imported: 1, skipped: 0, publish_mode: "published" });
    expect(mocks.tx.job.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ title: "Platform Engineer", status: "published", experience_level: "3-5 years" }),
    }));
  });

  it("rejects hallucinated document content before an auto-publish write", async () => {
    mocks.geminiGenerate.mockResolvedValue({
      text: JSON.stringify(candidate("Invented Distinguished Engineer")),
    });

    const result = await scanWithAi("jobs", {
      provider: "gemini",
      source_urls: [sourceUrl],
      publish_mode: "published",
    }, admin);

    expect(result).toMatchObject({ imported: 0, skipped: 1, publish_mode: "published" });
    expect(mocks.tx.job.create).not.toHaveBeenCalled();
  });
});
