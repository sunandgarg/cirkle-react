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
import { isIitEmailAddress } from "./iitDomains.js";

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailDeliveryReceipt {
  provider: "zeptomail" | "zavu";
  accepted: true;
  clientReference: string;
  providerRequestId?: string;
}

export type MailProvider = MailDeliveryReceipt["provider"];

export interface MailRoutingOptions {
  forceProvider?: MailProvider;
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

interface ZavuMailPayload extends Record<string, unknown> {
  to: string;
  channel: "email";
  subject: string;
  text: string;
  htmlBody: string;
  attachments?: Array<{
    filename: "cirkle-logo.png";
    content: string;
    content_type: "image/png";
    content_id: typeof CIRKLE_LOGO_CID;
  }>;
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
    const parsed = JSON.parse(body) as {
      id?: unknown;
      request_id?: unknown;
      message?: { id?: unknown };
      data?: { id?: unknown };
      error?: { request_id?: unknown };
    };
    return sanitizedRequestId(parsed.request_id)
      ?? sanitizedRequestId(parsed.message?.id)
      ?? sanitizedRequestId(parsed.data?.id)
      ?? sanitizedRequestId(parsed.id)
      ?? sanitizedRequestId(parsed.error?.request_id);
  } catch {
    return undefined;
  }
}

function zavuAuthorizationHeader(tokenValue: string): string {
  const token = tokenValue.trim();
  if (!/^zv_live_[A-Za-z0-9_-]{20,}$/.test(token) || /[\r\n]/.test(token)) {
    throw new ApiError(503, "mail_not_configured", "IIT email delivery is not configured correctly");
  }
  return `Bearer ${token}`;
}

function zavuSenderHeader(senderValue: string): string {
  const sender = senderValue.trim();
  if (!/^[a-z0-9]{16,128}$/i.test(sender)) {
    throw new ApiError(503, "mail_not_configured", "IIT email delivery is not configured correctly");
  }
  return sender;
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

async function zavuMailPayload(input: MailInput): Promise<ZavuMailPayload> {
  let htmlBody = input.html;
  let attachments: ZavuMailPayload["attachments"];
  try {
    attachments = [{
      filename: "cirkle-logo.png",
      content: await inlineLogoContent(),
      content_type: "image/png",
      content_id: CIRKLE_LOGO_CID,
    }];
  } catch {
    htmlBody = htmlBody.replaceAll(`cid:${CIRKLE_LOGO_CID}`, publicLogoUrl());
    logger.warn("Cirkle email logo could not be embedded; using the public HTTPS logo URL");
  }

  return {
    to: input.to,
    channel: "email",
    subject: input.subject,
    text: input.text,
    htmlBody,
    ...(attachments ? { attachments } : {}),
  };
}

function routedProvider(input: MailInput, options: MailRoutingOptions): MailProvider {
  return options.forceProvider ?? (isIitEmailAddress(input.to) ? "zavu" : "zeptomail");
}

export async function sendMail(input: MailInput, options: MailRoutingOptions = {}): Promise<MailDeliveryReceipt | undefined> {
  const provider = routedProvider(input, options);
  const providerConfigured = provider === "zavu"
    ? Boolean(config.ZAVU_API_KEY?.trim() && config.ZAVU_SENDER_ID?.trim())
    : Boolean(config.ZEPTOMAIL_TOKEN?.trim());
  if (!providerConfigured) {
    if (config.NODE_ENV === "production") {
      throw new ApiError(503, "mail_not_configured", provider === "zavu"
        ? "IIT email delivery is not configured"
        : "Email delivery is not configured");
    }
    return undefined;
  }
  if (!SIMPLE_EMAIL.test(input.to) || input.to.length > 254) {
    throw new ApiError(400, "invalid_email", "A valid destination email is required");
  }

  const clientReference = `cirkle-${randomUUID()}`;
  const payload = provider === "zavu" ? await zavuMailPayload(input) : await zeptoMailPayload(input);
  const url = provider === "zavu" ? config.ZAVU_API_URL : config.ZEPTOMAIL_API_URL;
  const headers: Record<string, string> = provider === "zavu"
    ? {
      Authorization: zavuAuthorizationHeader(config.ZAVU_API_KEY ?? ""),
      "Content-Type": "application/json",
      Accept: "application/json",
      "Zavu-Sender": zavuSenderHeader(config.ZAVU_SENDER_ID ?? ""),
      "Idempotency-Key": clientReference,
    }
    : {
      Authorization: authorizationHeader(config.ZEPTOMAIL_TOKEN ?? ""),
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
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
    provider,
    accepted: true,
    clientReference: provider === "zeptomail"
      ? (payload as ZeptoMailPayload).client_reference
      : clientReference,
    ...(requestId ? { providerRequestId: requestId } : {}),
  };
}

export async function sendLoginCode(email: string, code: string): Promise<void> {
  await sendMail({ to: email, ...loginCodeEmail(code) });
}

export async function sendInstituteCode(email: string, code: string): Promise<void> {
  await sendMail({ to: email, ...instituteVerificationEmail(code) }, { forceProvider: "zavu" });
}

export async function sendPasswordReset(email: string, url: string): Promise<void> {
  await sendMail({ to: email, ...passwordResetEmail(url) });
}

export async function sendVerificationDecision(email: string, approved: boolean, reason?: string): Promise<void> {
  await sendMail({ to: email, ...verificationDecisionEmail(approved, reason) });
}
