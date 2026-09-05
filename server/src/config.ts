import "dotenv/config";
import { createPrivateKey } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

const booleanString = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const zeptoMailApiHosts = new Set([
  "api.zeptomail.com",
  "api.zeptomail.eu",
  "api.zeptomail.in",
  "api.zeptomail.com.au",
  "api.zeptomail.com.cn",
  "api.zeptomail.ca",
  "api.zeptomail.jp",
  "api.zeptomail.sa",
]);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
  APP_BASE_URL: z.string().url().default("http://localhost:3001"),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  DEFAULT_COMMUNITY_ID: z.string().min(1).max(80).default("iit-community"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default("cirkle-api"),
  JWT_AUDIENCE: z.string().default("cirkle-web"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(400).default(365),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanString,
  IP_HASH_SECRET: z.string().min(16).default("replace-this-ip-hash-secret"),
  OTP_PEPPER: z.string().min(16).default("replace-this-otp-pepper"),
  ZEPTOMAIL_TOKEN: z.string().optional(),
  ZEPTOMAIL_API_URL: z.string().url().default("https://api.zeptomail.in/v1.1/email"),
  ZEPTOMAIL_FROM_EMAIL: z.string().email().default("noreply@cirkle.world"),
  ZEPTOMAIL_FROM_NAME: z.string().default("Cirkle"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.4-mini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  KLIPY_API_KEY: z.string().optional(),
  DAILY_API_KEY: z.string().optional(),
  DAILY_DOMAIN: z.string().optional(),
  REQUIRE_PROVIDER_CONFIG: booleanString.default("true"),
  APPSYNC_ENABLED: booleanString,
  APPSYNC_HTTP_ENDPOINT: z.string().url().optional(),
  APPSYNC_PUBLISH_TOKEN: z.string().optional(),
  APPSYNC_AUTHORIZER_SECRET: z.string().optional(),
  APPSYNC_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(4_000),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_ROOT: z.string().default("./server/storage"),
  AWS_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).default("ap-south-1"),
  S3_BUCKET: z.string().min(3).max(63).optional(),
  S3_KEY_PREFIX: z.string().regex(/^[A-Za-z0-9!_.*'()/-]*$/).default(""),
  CLOUDFRONT_DOMAIN: z.string().regex(/^[a-z0-9.-]+$/i).optional(),
  CLOUDFRONT_KEY_PAIR_ID: z.string().min(8).max(128).optional(),
  CLOUDFRONT_PRIVATE_KEY_BASE64: z.string().min(100).optional(),
  STORAGE_SIGNING_SECRET: z.string().min(16),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(20 * 1024 * 1024).default(20 * 1024 * 1024),
  MOBILE_TEST_MODE: booleanString,
  MOBILE_TEST_PHONES: z.string().default(""),
  ENABLE_SEED_DATA: booleanString,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid server environment: ${details}`);
}

type ServerConfig = z.infer<typeof schema>;

export function productionConfigIssues(value: ServerConfig): string[] {
  if (value.NODE_ENV !== "production") return [];
  const issues: string[] = [];
  const secrets = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "STORAGE_SIGNING_SECRET", "IP_HASH_SECRET", "OTP_PEPPER"] as const;
  for (const key of secrets) {
    const secret = value[key];
    if (secret.length < 32) issues.push(`${key} must contain at least 32 characters in production`);
    if (/replace|change-before|local-only|placeholder|example|^test-/i.test(secret)) issues.push(`${key} still contains a placeholder value`);
  }
  if (new Set(secrets.map((key) => value[key])).size !== secrets.length) issues.push("Production security secrets must be distinct");
  try {
    const databaseUrl = new URL(value.DATABASE_URL);
    const sslCert = databaseUrl.searchParams.getAll("sslcert");
    const sslAccept = databaseUrl.searchParams.getAll("sslaccept");
    const sslCertPath = sslCert[0] ?? "";
    const sslAcceptMode = sslAccept[0] ?? "";
    let username = "";
    try { username = decodeURIComponent(databaseUrl.username); } catch { /* invalid below */ }
    if (databaseUrl.protocol !== "mysql:" || username !== "cirkle_app" || !databaseUrl.password
      || !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/i.test(databaseUrl.hostname)
      || (databaseUrl.port || "3306") !== "3306" || databaseUrl.pathname !== "/cirkle" || databaseUrl.hash
      || sslCert.length !== 1 || !isAbsolute(sslCertPath)
      || sslAccept.length !== 1 || sslAcceptMode.toLowerCase() !== "strict") throw new Error("invalid");
  } catch {
    issues.push("DATABASE_URL must use cirkle_app on the AWS managed cirkle database with an absolute sslcert and sslaccept=strict");
  }
  if (value.REQUIRE_PROVIDER_CONFIG) {
    const providers = [
      "ZEPTOMAIL_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
      "OPENAI_API_KEY", "GEMINI_API_KEY", "KLIPY_API_KEY", "DAILY_API_KEY",
    ] as const;
    for (const key of providers) if (!value[key]?.trim()) issues.push(`${key} is required in production`);
  }
  const productionUrl = (key: "APP_BASE_URL" | "FRONTEND_URL", raw: string): URL | null => {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid");
      return url;
    } catch {
      issues.push(`${key} must be an HTTPS URL without embedded credentials in production`);
      return null;
    }
  };
  const appUrl = productionUrl("APP_BASE_URL", value.APP_BASE_URL);
  const frontendUrl = productionUrl("FRONTEND_URL", value.FRONTEND_URL);
  const corsOrigins = value.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!corsOrigins.length || corsOrigins.includes("*")) issues.push("CORS_ORIGINS must explicitly list trusted HTTPS origins in production");
  for (const origin of corsOrigins) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin) throw new Error("invalid");
    } catch { issues.push(`CORS_ORIGINS contains an invalid production origin: ${origin}`); }
  }
  if (frontendUrl && !corsOrigins.includes(frontendUrl.origin)) issues.push("CORS_ORIGINS must include FRONTEND_URL's origin");
  if (value.GOOGLE_REDIRECT_URI) {
    try {
      const redirect = new URL(value.GOOGLE_REDIRECT_URI);
      if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.pathname !== "/api/auth/google/callback" || !appUrl || redirect.origin !== appUrl.origin) {
        throw new Error("invalid");
      }
    } catch { issues.push("GOOGLE_REDIRECT_URI must be the HTTPS APP_BASE_URL /api/auth/google/callback endpoint"); }
  }
  try {
    const zeptoMailUrl = new URL(value.ZEPTOMAIL_API_URL);
    if (zeptoMailUrl.protocol !== "https:" || zeptoMailUrl.username || zeptoMailUrl.password
      || zeptoMailUrl.pathname !== "/v1.1/email" || zeptoMailUrl.search || zeptoMailUrl.hash
      || !zeptoMailApiHosts.has(zeptoMailUrl.hostname.toLowerCase())) throw new Error("invalid");
    if (zeptoMailUrl.hostname.toLowerCase() !== "api.zeptomail.in") issues.push("ZEPTOMAIL_API_URL must use this account's India data-center endpoint");
  } catch { issues.push("ZEPTOMAIL_API_URL must be the HTTPS regional ZeptoMail /v1.1/email endpoint"); }
  if (value.ZEPTOMAIL_FROM_EMAIL.toLowerCase() !== "noreply@cirkle.world") {
    issues.push("ZEPTOMAIL_FROM_EMAIL must equal the verified noreply@cirkle.world sender");
  }
  if (value.APPSYNC_ENABLED) {
    if (!value.APPSYNC_HTTP_ENDPOINT) issues.push("APPSYNC_HTTP_ENDPOINT is required when AppSync is enabled");
    if (!value.APPSYNC_PUBLISH_TOKEN || value.APPSYNC_PUBLISH_TOKEN.length < 32) issues.push("APPSYNC_PUBLISH_TOKEN must contain at least 32 characters when AppSync is enabled");
    if (!value.APPSYNC_AUTHORIZER_SECRET || value.APPSYNC_AUTHORIZER_SECRET.length < 32) issues.push("APPSYNC_AUTHORIZER_SECRET must contain at least 32 characters when AppSync is enabled");
    if (value.APPSYNC_PUBLISH_TOKEN && value.APPSYNC_AUTHORIZER_SECRET && value.APPSYNC_PUBLISH_TOKEN === value.APPSYNC_AUTHORIZER_SECRET) {
      issues.push("APPSYNC_PUBLISH_TOKEN and APPSYNC_AUTHORIZER_SECRET must be distinct");
    }
    if (value.APPSYNC_HTTP_ENDPOINT) {
      try {
        const endpoint = new URL(value.APPSYNC_HTTP_ENDPOINT);
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/event"
          || endpoint.search || endpoint.hash || !/^[a-z0-9-]+\.appsync-api\.ap-south-1\.amazonaws\.com$/i.test(endpoint.hostname)) {
          throw new Error("invalid");
        }
      } catch { issues.push("APPSYNC_HTTP_ENDPOINT must be an AWS AppSync Events HTTPS /event endpoint"); }
    }
    const appSyncSecrets = [value.APPSYNC_PUBLISH_TOKEN, value.APPSYNC_AUTHORIZER_SECRET].filter((secret): secret is string => Boolean(secret));
    if (appSyncSecrets.some((secret) => secrets.some((key) => value[key] === secret))) {
      issues.push("AppSync credentials must be distinct from JWT, storage, hashing, and OTP secrets");
    }
  }
  if (value.STORAGE_DRIVER === "s3" && !value.S3_BUCKET) issues.push("S3_BUCKET is required when STORAGE_DRIVER=s3");
  const cloudFrontValues = [value.CLOUDFRONT_DOMAIN, value.CLOUDFRONT_KEY_PAIR_ID, value.CLOUDFRONT_PRIVATE_KEY_BASE64];
  if (cloudFrontValues.some(Boolean) && !cloudFrontValues.every(Boolean)) {
    issues.push("CLOUDFRONT_DOMAIN, CLOUDFRONT_KEY_PAIR_ID, and CLOUDFRONT_PRIVATE_KEY_BASE64 must be configured together");
  }
  if (value.CLOUDFRONT_DOMAIN && !/^[a-z0-9-]+\.cloudfront\.net$/i.test(value.CLOUDFRONT_DOMAIN)) {
    issues.push("CLOUDFRONT_DOMAIN must be an AWS CloudFront distribution hostname");
  }
  if (value.CLOUDFRONT_PRIVATE_KEY_BASE64) {
    try {
      const pem = Buffer.from(value.CLOUDFRONT_PRIVATE_KEY_BASE64, "base64").toString("utf8");
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== "rsa") throw new Error("not RSA");
    } catch { issues.push("CLOUDFRONT_PRIVATE_KEY_BASE64 must contain a valid base64-encoded RSA private key"); }
  }
  if (value.COOKIE_DOMAIN) issues.push("COOKIE_DOMAIN must be unset in production so the refresh cookie remains host-only");
  if (value.DAILY_DOMAIN) {
    try {
      const url = new URL(value.DAILY_DOMAIN.includes("://") ? value.DAILY_DOMAIN : `https://${value.DAILY_DOMAIN}`);
      if (url.protocol !== "https:" || !url.hostname || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid");
    } catch { issues.push("DAILY_DOMAIN must be a valid HTTPS hostname when configured"); }
  }
  if (!value.COOKIE_SECURE) issues.push("COOKIE_SECURE must be true in production");
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(value.HOST)) issues.push("HOST must bind to loopback behind Nginx in production");
  if (![1, 2].includes(value.TRUST_PROXY_HOPS)) issues.push("TRUST_PROXY_HOPS must match the reviewed one-hop Nginx or two-hop AWS ALB/Nginx topology");
  return issues;
}

const productionIssues = productionConfigIssues(parsed.data);
if (productionIssues.length) throw new Error(`Invalid production server environment: ${productionIssues.join("; ")}`);

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
  mobileTestPhones: new Set(parsed.data.MOBILE_TEST_PHONES.split(",").map((item) => item.trim()).filter(Boolean)),
};
