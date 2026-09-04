import { describe, expect, it } from "vitest";
import { config, productionConfigIssues } from "../src/config.js";
import { requestPathForLog, responseForLog } from "../src/security/logging.js";

const production = {
  ...config,
  NODE_ENV: "production" as const,
  TRUST_PROXY_HOPS: 1,
  APP_BASE_URL: "https://api.cirkle.world",
  FRONTEND_URL: "https://cirkle.world",
  CORS_ORIGINS: "https://cirkle.world,https://www.cirkle.world",
  COOKIE_SECURE: true,
  JWT_ACCESS_SECRET: "a".repeat(40),
  JWT_REFRESH_SECRET: "b".repeat(40),
  STORAGE_SIGNING_SECRET: "c".repeat(40),
  IP_HASH_SECRET: "d".repeat(40),
  OTP_PEPPER: "e".repeat(40),
  ZEPTOMAIL_TOKEN: "zepto-key",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret-value",
  GOOGLE_REDIRECT_URI: "https://api.cirkle.world/api/auth/google/callback",
  OPENAI_API_KEY: "openai-key",
  GEMINI_API_KEY: "gemini-key",
  KLIPY_API_KEY: "klipy-key",
  DAILY_API_KEY: "daily-key",
  DAILY_DOMAIN: "cirkle.daily.co",
};

describe("production configuration", () => {
  it("accepts distinct secrets and complete visible providers", () => {
    expect(productionConfigIssues(production)).toEqual([]);
    expect(productionConfigIssues({ ...production, DAILY_DOMAIN: undefined })).toEqual([]);
  });

  it("rejects placeholders and absent visible providers", () => {
    const issues = productionConfigIssues({ ...production, JWT_ACCESS_SECRET: "replace-this-secret", OPENAI_API_KEY: undefined });
    expect(issues.some((issue) => issue.includes("JWT_ACCESS_SECRET"))).toBe(true);
    expect(issues).toContain("OPENAI_API_KEY is required in production");
  });

  it("rejects insecure public URLs and a mismatched OAuth callback", () => {
    const issues = productionConfigIssues({
      ...production,
      APP_BASE_URL: "http://localhost:3001",
      FRONTEND_URL: "http://localhost:8080",
      CORS_ORIGINS: "*,http://localhost:8080",
      GOOGLE_REDIRECT_URI: "https://attacker.invalid/api/auth/google/callback",
      ZEPTOMAIL_API_URL: "http://api.zeptomail.com/v1.1/email",
    });
    expect(issues.some((issue) => issue.includes("APP_BASE_URL"))).toBe(true);
    expect(issues.some((issue) => issue.includes("FRONTEND_URL"))).toBe(true);
    expect(issues.some((issue) => issue.includes("CORS_ORIGINS"))).toBe(true);
    expect(issues.some((issue) => issue.includes("GOOGLE_REDIRECT_URI"))).toBe(true);
    expect(issues.some((issue) => issue.includes("ZEPTOMAIL_API_URL"))).toBe(true);
    expect(productionConfigIssues({ ...production, ZEPTOMAIL_API_URL: "https://attacker.invalid/v1.1/email" })
      .some((issue) => issue.includes("ZEPTOMAIL_API_URL"))).toBe(true);
    expect(productionConfigIssues({ ...production, ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email" })).toEqual([]);
  });

  it("requires a loopback, one-hop, DNS-only API proxy model", () => {
    const issues = productionConfigIssues({ ...production, HOST: "0.0.0.0", TRUST_PROXY_HOPS: 2 });
    expect(issues.some((issue) => issue.includes("HOST"))).toBe(true);
    expect(issues.some((issue) => issue.includes("TRUST_PROXY_HOPS"))).toBe(true);
  });

  it("requires a host-only cookie and the Nginx-compatible upload limit", () => {
    expect(productionConfigIssues({ ...production, COOKIE_DOMAIN: "cirkle.world" }))
      .toContain("COOKIE_DOMAIN must be unset in production so the refresh cookie remains host-only");
    expect(config.MAX_UPLOAD_BYTES).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});

describe("request log redaction", () => {
  it("retains only the pathname for OAuth and signed-storage requests", () => {
    expect(requestPathForLog("/api/auth/google/callback?code=secret&state=secret-state")).toBe("/api/auth/google/callback");
    expect(requestPathForLog("/api/storage/private/stories/file.webp?expires=123&sig=secret")).toBe("/api/storage/private/stories/file.webp");
    expect(requestPathForLog(undefined)).toBe("/");
  });

  it("serializes responses without retaining raw request headers or cookies", () => {
    const response: any = {
      statusCode: 200,
      req: { rawHeaders: ["authorization", "Bearer secret"] },
      headers: { "set-cookie": "secret" },
    };
    response.self = response;
    expect(responseForLog(response)).toEqual({ statusCode: 200 });
  });
});
