import { EMAIL_LOGO_URL, prepareEmailBranding } from "./emailLogo.ts";

const DEFAULT_FROM = "Cirkle <verify@cirkle.world>";
const DELIVERY_TIMEOUT_MS = 10_000;

export type TransactionalEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
};

type EmailProvider = "zeptomail" | "zavu" | "ses";

type EmailDeliveryOptions = {
  primary?: string;
  fallback?: string;
};

const bytesToHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (value: string) =>
  bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

const hmac = async (key: ArrayBuffer | Uint8Array, value: string) =>
  crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(value),
  );

const getSignatureKey = async (secret: string, dateStamp: string, region: string) => {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "ses");
  return hmac(kService, "aws4_request");
};

const sendWithSes = async (email: TransactionalEmail) => {
  const region = Deno.env.get("AWS_REGION") || Deno.env.get("AWS_SES_REGION") || "ap-south-1";
  const accessKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const from = Deno.env.get("VERIFICATION_EMAIL_FROM") || DEFAULT_FROM;
  if (!accessKey || !secretKey) throw new Error("Amazon SES is not configured");

  const host = `email.${region}.amazonaws.com`;
  const branded = await prepareEmailBranding(email.html);
  const payload = JSON.stringify({
    FromEmailAddress: from,
    Destination: { ToAddresses: [email.to] },
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: email.text, Charset: "UTF-8" },
          Html: { Data: branded.html, Charset: "UTF-8" },
        },
        Attachments: branded.attachments,
      },
    },
  });
  const dateHeader = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = dateHeader.slice(0, 8);
  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${dateHeader}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateHeader}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
  const signature = bytesToHex(await hmac(await getSignatureKey(secretKey, dateStamp, region), stringToSign));

  const response = await fetch(`https://${host}/v2/email/outbound-emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: host,
      "X-Amz-Content-Sha256": payloadHash,
      "X-Amz-Date": dateHeader,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: payload,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Amazon SES email delivery failed", response.status, detail.slice(0, 300));
    throw new Error(`Amazon SES rejected the email (${response.status})`);
  }
};

const sendWithZavu = async (email: TransactionalEmail) => {
  const apiKey = Deno.env.get("ZAVU_API_KEY") || Deno.env.get("ZAVUDEV_API_KEY");
  if (!apiKey) throw new Error("Zavu is not configured");

  const branded = await prepareEmailBranding(email.html);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const senderId = Deno.env.get("ZAVU_SENDER_ID");
  if (senderId) headers["Zavu-Sender"] = senderId;
  if (email.idempotencyKey) headers["Idempotency-Key"] = email.idempotencyKey;

  const response = await fetch("https://api.zavu.dev/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: email.to,
      channel: "email",
      subject: email.subject,
      text: email.text,
      htmlBody: branded.html,
      attachments: branded.attachments.map((attachment) => ({
        filename: attachment.FileName,
        content: attachment.RawContent,
        content_type: attachment.ContentType,
        content_id: attachment.ContentId,
      })),
    }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Zavu email delivery failed", response.status, detail.slice(0, 300));
    throw new Error(`Zavu rejected the email (${response.status})`);
  }
};

const parseFrom = (from: string) => {
  const match = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (!match) return { address: from.trim(), name: "Cirkle" };
  return { name: match[1].trim() || "Cirkle", address: match[2].trim() };
};

const sendWithZeptoMail = async (email: TransactionalEmail) => {
  const token = Deno.env.get("ZEPTOMAIL_API_KEY") ||
    Deno.env.get("ZOHO_ZEPTOMAIL_TOKEN") ||
    Deno.env.get("ZEPTOMAIL_SEND_MAIL_TOKEN");
  if (!token) throw new Error("ZeptoMail is not configured");
  const authorization = token.trim().toLowerCase().startsWith("zoho-enczapikey ")
    ? token.trim()
    : `Zoho-enczapikey ${token.trim()}`;

  const from = parseFrom(Deno.env.get("VERIFICATION_EMAIL_FROM") || DEFAULT_FROM);
  const endpoint = Deno.env.get("ZEPTOMAIL_API_URL") || "https://api.zeptomail.in/v1.1/email";
  const branded = await prepareEmailBranding(email.html);
  const inlineImages = branded.attachments.map((attachment) => ({
    cid: attachment.ContentId,
    content: attachment.RawContent,
    mime_type: attachment.ContentType,
  }));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...(email.idempotencyKey ? { "Idempotency-Key": email.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: { address: from.address, name: from.name },
      to: [{ email_address: { address: email.to } }],
      subject: email.subject,
      textbody: email.text,
      htmlbody: inlineImages.length > 0 ? branded.html : branded.html.replace(/cid:cirkle-logo/g, EMAIL_LOGO_URL),
      ...(inlineImages.length > 0 ? { inline_images: inlineImages } : {}),
    }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("ZeptoMail email delivery failed", response.status, detail.slice(0, 300));
    throw new Error(`ZeptoMail rejected the email (${response.status})`);
  }
};

const allProviders: EmailProvider[] = ["zeptomail", "zavu", "ses"];

const isProvider = (value: string): value is EmailProvider =>
  value === "zeptomail" || value === "zavu" || value === "ses";

const normalizeProvider = (value: string): EmailProvider | undefined => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "zoho") return "zeptomail";
  return isProvider(normalized) ? normalized : undefined;
};

const hasProviderConfig = (provider: EmailProvider) => {
  if (provider === "zeptomail") {
    return Boolean(Deno.env.get("ZEPTOMAIL_API_KEY") || Deno.env.get("ZOHO_ZEPTOMAIL_TOKEN") || Deno.env.get("ZEPTOMAIL_SEND_MAIL_TOKEN"));
  }
  if (provider === "zavu") return Boolean(Deno.env.get("ZAVU_API_KEY") || Deno.env.get("ZAVUDEV_API_KEY"));
  return Boolean(Deno.env.get("AWS_ACCESS_KEY_ID") && Deno.env.get("AWS_SECRET_ACCESS_KEY"));
};

export const resolveEmailProviderOrder = (primaryValue?: string, fallbackValue?: string): EmailProvider[] => {
  const configuredPrimary = primaryValue ? normalizeProvider(primaryValue) : undefined;
  const primary = configuredPrimary ||
    (hasProviderConfig("zeptomail") ? "zeptomail" : hasProviderConfig("zavu") ? "zavu" : "ses");
  const configuredFallbacks = (fallbackValue || "")
    .split(",")
    .map(normalizeProvider)
    .filter((provider): provider is EmailProvider => Boolean(provider));
  const defaults = allProviders.filter((provider) => provider !== primary);
  return Array.from(new Set([primary, ...configuredFallbacks, ...defaults]));
};

const deliver = (provider: EmailProvider, email: TransactionalEmail) =>
  provider === "zeptomail" ? sendWithZeptoMail(email) : provider === "zavu" ? sendWithZavu(email) : sendWithSes(email);

export const sendTransactionalEmail = async (
  email: TransactionalEmail,
  options: EmailDeliveryOptions = {},
) => {
  const providers = resolveEmailProviderOrder(
    options.primary ?? Deno.env.get("EMAIL_PROVIDER_PRIMARY"),
    options.fallback ?? Deno.env.get("EMAIL_PROVIDER_FALLBACK"),
  );
  const primary = providers[0];
  const failures: string[] = [];

  for (const provider of providers) {
    try {
      await deliver(provider, email);
      if (provider !== primary) console.warn(`Transactional email delivered through ${provider} fallback`);
      return { provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown delivery error";
      failures.push(`${provider}: ${message}`);
      console.error(`Transactional email provider ${provider} failed`, message);
    }
  }

  console.error("All transactional email providers failed", failures.join("; "));
  throw new Error("Could not deliver the email. Try again shortly.");
};
