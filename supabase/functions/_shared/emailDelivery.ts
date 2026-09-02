import { EMAIL_LOGO_URL, prepareEmailBranding } from "./emailLogo.ts";

declare const Deno: { env: { get: (name: string) => string | undefined } };

const DEFAULT_FROM = "Cirkle <verify@cirkle.world>";
const DELIVERY_TIMEOUT_MS = 10_000;

export type TransactionalEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
};

export type EmailProvider = "brevo" | "zeptomail" | "zavu" | "ses";

type EmailDeliveryOptions = {
  primary?: string;
  fallback?: string;
};

const bytesToHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (value: string) =>
  bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

const deterministicUuid = async (value: string) => {
  const hex = (await sha256Hex(value)).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const normalized = hex.join("");
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
};

const hmac = async (key: ArrayBuffer | Uint8Array, value: string) =>
  crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
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

const sendWithBrevo = async (email: TransactionalEmail) => {
  const apiKey = Deno.env.get("BREVO_API_KEY") || Deno.env.get("SENDINBLUE_API_KEY");
  if (!apiKey) throw new Error("Brevo is not configured");

  const from = parseFrom(Deno.env.get("VERIFICATION_EMAIL_FROM") || DEFAULT_FROM);
  const endpoint = Deno.env.get("BREVO_API_URL") || "https://api.brevo.com/v3/smtp/email";
  const branded = await prepareEmailBranding(email.html);
  const idempotencyKey = email.idempotencyKey
    ? await deterministicUuid(email.idempotencyKey)
    : undefined;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: from,
      to: [{ email: email.to }],
      subject: email.subject,
      textContent: email.text,
      // Brevo's transactional endpoint does not expose Content-ID for inline
      // attachments, so use the public Cirkle asset instead of a broken cid URL.
      htmlContent: branded.html.replace(/cid:cirkle-logo/g, EMAIL_LOGO_URL),
      ...(idempotencyKey
        ? { headers: { "Idempotency-Key": idempotencyKey } }
        : {}),
      tags: ["cirkle-transactional"],
    }),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Brevo email delivery failed", response.status, detail.slice(0, 300));
    throw new Error(`Brevo rejected the email (${response.status})`);
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

const allProviders: EmailProvider[] = ["zeptomail", "brevo", "zavu", "ses"];

const isProvider = (value: string): value is EmailProvider =>
  value === "brevo" || value === "zeptomail" || value === "zavu" || value === "ses";

const normalizeProvider = (value: string): EmailProvider | undefined => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "zoho") return "zeptomail";
  return isProvider(normalized) ? normalized : undefined;
};

const hasProviderConfig = (provider: EmailProvider) => {
  if (provider === "brevo") {
    return Boolean(Deno.env.get("BREVO_API_KEY") || Deno.env.get("SENDINBLUE_API_KEY"));
  }
  if (provider === "zeptomail") {
    return Boolean(Deno.env.get("ZEPTOMAIL_API_KEY") || Deno.env.get("ZOHO_ZEPTOMAIL_TOKEN") || Deno.env.get("ZEPTOMAIL_SEND_MAIL_TOKEN"));
  }
  if (provider === "zavu") return Boolean(Deno.env.get("ZAVU_API_KEY") || Deno.env.get("ZAVUDEV_API_KEY"));
  return Boolean(Deno.env.get("AWS_ACCESS_KEY_ID") && Deno.env.get("AWS_SECRET_ACCESS_KEY"));
};

const INSTITUTE_EMAIL_DOMAINS = new Set([
  "iitb.ac.in", "alumni.iitb.ac.in", "iitd.ac.in", "alumni.iitd.ac.in",
  "iitm.ac.in", "alumni.iitm.ac.in", "iitk.ac.in", "alumni.iitk.ac.in",
  "iitkgp.ac.in", "alumni.iitkgp.ac.in", "iitr.ac.in", "alumni.iitr.ac.in",
  "iitg.ac.in", "alumni.iitg.ac.in", "iith.ac.in", "alumni.iith.ac.in",
  "iitbhu.ac.in", "alumni.iitbhu.ac.in", "iiti.ac.in", "alumni.iiti.ac.in",
  "iitrpr.ac.in", "alumni.iitrpr.ac.in", "iitp.ac.in", "alumni.iitp.ac.in",
  "iitbbs.ac.in", "alumni.iitbbs.ac.in", "iitgn.ac.in", "alumni.iitgn.ac.in",
  "iitj.ac.in", "alumni.iitj.ac.in", "iitmandi.ac.in", "alumni.iitmandi.ac.in",
  "iittp.ac.in", "alumni.iittp.ac.in", "iitpkd.ac.in", "alumni.iitpkd.ac.in",
  "iitdh.ac.in", "alumni.iitdh.ac.in", "iitbhilai.ac.in", "alumni.iitbhilai.ac.in",
  "iitgoa.ac.in", "alumni.iitgoa.ac.in", "iitjammu.ac.in", "alumni.iitjammu.ac.in",
  "iitism.ac.in", "alumni.iitism.ac.in",
]);

export const isInstituteEmailAddress = (email: string) => {
  const domain = email.trim().toLowerCase().match(/^[^@\s]+@([^@\s]+)$/)?.[1];
  return Boolean(domain && INSTITUTE_EMAIL_DOMAINS.has(domain));
};

const brevoDailyLimit = () => {
  const configured = Number.parseInt(Deno.env.get("BREVO_DAILY_LIMIT") || "299", 10);
  return Number.isFinite(configured) ? Math.min(300, Math.max(1, configured)) : 299;
};

const quotaRpc = async (functionName: string, body: Record<string, unknown>) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Email provider quota service is not configured");
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.error("Email provider quota RPC failed", functionName, response.status);
    throw new Error("Email provider quota service is unavailable");
  }
  return response;
};

const reserveBrevoQuota = async () => {
  const response = await quotaRpc("reserve_email_provider_daily_quota", {
    p_provider: "brevo",
    p_daily_limit: brevoDailyLimit(),
  });
  return (await response.json()) === true;
};

const releaseBrevoQuota = async () => {
  await quotaRpc("release_email_provider_daily_quota", { p_provider: "brevo" });
};

export const resolveEmailProviderOrder = (primaryValue?: string, fallbackValue?: string): EmailProvider[] => {
  const configuredPrimary = primaryValue ? normalizeProvider(primaryValue) : undefined;
  const primary = configuredPrimary ||
    (hasProviderConfig("zeptomail")
      ? "zeptomail"
      : hasProviderConfig("brevo")
      ? "brevo"
      : hasProviderConfig("zavu")
      ? "zavu"
      : "ses");
  const configuredFallbacks = (fallbackValue || "")
    .split(",")
    .map(normalizeProvider)
    .filter((provider): provider is EmailProvider => Boolean(provider));
  const defaults = allProviders.filter((provider) => provider !== primary);
  return Array.from(new Set([primary, ...configuredFallbacks, ...defaults]));
};

const deliver = (provider: EmailProvider, email: TransactionalEmail) =>
  provider === "brevo"
    ? sendWithBrevo(email)
    : provider === "zeptomail"
    ? sendWithZeptoMail(email)
    : provider === "zavu"
    ? sendWithZavu(email)
    : sendWithSes(email);

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
    let quotaReserved = false;
    try {
      if (provider === "brevo") {
        quotaReserved = await reserveBrevoQuota();
        if (!quotaReserved) {
          failures.push(`brevo: daily limit of ${brevoDailyLimit()} reached`);
          console.warn("Brevo daily limit reached; continuing with the next provider");
          continue;
        }
      }
      await deliver(provider, email);
      if (provider !== primary) console.warn(`Transactional email delivered through ${provider} fallback`);
      return { provider };
    } catch (error) {
      if (provider === "brevo" && quotaReserved) {
        try {
          await releaseBrevoQuota();
        } catch (releaseError) {
          console.error("Could not release failed Brevo quota reservation", releaseError instanceof Error ? releaseError.message : releaseError);
        }
      }
      const message = error instanceof Error ? error.message : "unknown delivery error";
      failures.push(`${provider}: ${message}`);
      console.error(`Transactional email provider ${provider} failed`, message);
    }
  }

  console.error("All transactional email providers failed", failures.join("; "));
  throw new Error("Could not deliver the email. Try again shortly.");
};
