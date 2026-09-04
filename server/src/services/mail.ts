import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  CIRKLE_LOGO_CID,
  instituteVerificationEmail,
  loginCodeEmail,
  passwordResetEmail,
  verificationDecisionEmail,
} from "./mailTemplates.js";

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailDeliveryReceipt {
  provider: "zeptomail";
  accepted: true;
  clientReference: string;
  providerRequestId?: string;
}

interface ZeptoMailPayload extends Record<string, unknown> {
  from: { address: string; name: string };
  to: Array<{ email_address: { address: string } }>;
  subject: string;
  htmlbody: string;
  textbody: string;
  client_reference: string;
  track_clicks: false;
  track_opens: false;
  inline_images?: Array<{ cid: string; content: string; mime_type: "image/png" }>;
}

const LOGO_PATH = fileURLToPath(new URL("../../../public/cirkle-logo.png", import.meta.url));
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:/-]{1,160}$/;
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let logoContentPromise: Promise<string> | undefined;

function inlineLogoContent(): Promise<string> {
  logoContentPromise ??= readFile(LOGO_PATH).then((content) => content.toString("base64"));
  return logoContentPromise;
}

function authorizationHeader(tokenValue: string): string {
  const trimmed = tokenValue.trim();
  const token = /^zoho-enczapikey\s+/i.test(trimmed)
    ? trimmed.replace(/^zoho-enczapikey\s+/i, "").trim()
    : trimmed;
  if (!token || /[\r\n]/.test(token)) {
    throw new ApiError(503, "mail_not_configured", "Email delivery is not configured correctly");
  }
  return `Zoho-enczapikey ${token}`;
}

function sanitizedRequestId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

async function providerRequestId(response: Response): Promise<string | undefined> {
  const headerValue = response.headers.get("x-request-id")
    ?? response.headers.get("request-id")
    ?? response.headers.get("x-zeptomail-request-id");
  const fromHeader = sanitizedRequestId(headerValue);
  if (fromHeader) return fromHeader;

  try {
    const body = await response.text();
    if (!body || body.length > 16_384) return undefined;
    const parsed = JSON.parse(body) as { request_id?: unknown; error?: { request_id?: unknown } };
    return sanitizedRequestId(parsed.request_id) ?? sanitizedRequestId(parsed.error?.request_id);
  } catch {
    return undefined;
  }
}

function publicLogoUrl(): string {
  return new URL("/cirkle-logo.png", config.FRONTEND_URL).toString();
}

async function zeptoMailPayload(input: MailInput): Promise<ZeptoMailPayload> {
  const clientReference = `cirkle-${randomUUID()}`;
  let htmlbody = input.html;
  let inlineImages: ZeptoMailPayload["inline_images"];
  try {
    inlineImages = [{
      cid: CIRKLE_LOGO_CID,
      content: await inlineLogoContent(),
      mime_type: "image/png",
    }];
  } catch {
    htmlbody = htmlbody.replaceAll(`cid:${CIRKLE_LOGO_CID}`, publicLogoUrl());
    logger.warn("Cirkle email logo could not be embedded; using the public HTTPS logo URL");
  }

  return {
    from: { address: config.ZEPTOMAIL_FROM_EMAIL, name: config.ZEPTOMAIL_FROM_NAME },
    to: [{ email_address: { address: input.to } }],
    subject: input.subject,
    htmlbody,
    textbody: input.text,
    client_reference: clientReference,
    track_clicks: false,
    track_opens: false,
    ...(inlineImages ? { inline_images: inlineImages } : {}),
  };
}

export async function sendMail(input: MailInput): Promise<MailDeliveryReceipt | undefined> {
  if (!config.ZEPTOMAIL_TOKEN?.trim()) {
    if (config.NODE_ENV === "production") {
      throw new ApiError(503, "mail_not_configured", "Email delivery is not configured");
    }
    return undefined;
  }
  if (!SIMPLE_EMAIL.test(input.to) || input.to.length > 254) {
    throw new ApiError(400, "invalid_email", "A valid destination email is required");
  }

  const payload = await zeptoMailPayload(input);
  let response: Response;
  try {
    response = await fetch(config.ZEPTOMAIL_API_URL, {
      method: "POST",
      headers: {
        Authorization: authorizationHeader(config.ZEPTOMAIL_TOKEN),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ApiError(504, "mail_delivery_timeout", "The email provider did not respond in time");
    }
    throw new ApiError(502, "mail_delivery_failed", "The email provider could not accept the message");
  }

  const requestId = await providerRequestId(response);
  if (!response.ok) {
    const unavailable = response.status === 429 || response.status >= 500;
    throw new ApiError(
      unavailable ? 503 : 502,
      unavailable ? "mail_provider_unavailable" : "mail_delivery_rejected",
      unavailable ? "Email delivery is temporarily unavailable" : "The email provider rejected the message",
      {
        upstream_status: response.status,
        ...(requestId ? { provider_request_id: requestId } : {}),
      },
    );
  }

  return {
    provider: "zeptomail",
    accepted: true,
    clientReference: payload.client_reference,
    ...(requestId ? { providerRequestId: requestId } : {}),
  };
}

export async function sendLoginCode(email: string, code: string): Promise<void> {
  await sendMail({ to: email, ...loginCodeEmail(code) });
}

export async function sendInstituteCode(email: string, code: string): Promise<void> {
  await sendMail({ to: email, ...instituteVerificationEmail(code) });
}

export async function sendPasswordReset(email: string, url: string): Promise<void> {
  await sendMail({ to: email, ...passwordResetEmail(url) });
}

export async function sendVerificationDecision(email: string, approved: boolean, reason?: string): Promise<void> {
  await sendMail({ to: email, ...verificationDecisionEmail(approved, reason) });
}
