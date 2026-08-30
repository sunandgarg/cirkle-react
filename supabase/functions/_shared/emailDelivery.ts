import { prepareEmailBranding } from "./emailLogo.ts";

const DEFAULT_FROM = "Cirkle <verify@cirkle.world>";
const DELIVERY_TIMEOUT_MS = 10_000;

export type TransactionalEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
};

type EmailProvider = "zavu" | "ses";

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

const parseProvider = (value: string | undefined, fallback: EmailProvider): EmailProvider =>
  value?.trim().toLowerCase() === "ses" ? "ses" : value?.trim().toLowerCase() === "zavu" ? "zavu" : fallback;

const deliver = (provider: EmailProvider, email: TransactionalEmail) =>
  provider === "zavu" ? sendWithZavu(email) : sendWithSes(email);

export const sendTransactionalEmail = async (email: TransactionalEmail) => {
  const primary = parseProvider(
    Deno.env.get("EMAIL_PROVIDER_PRIMARY"),
    Deno.env.get("ZAVU_API_KEY") || Deno.env.get("ZAVUDEV_API_KEY") ? "zavu" : "ses",
  );
  const fallback = parseProvider(
    Deno.env.get("EMAIL_PROVIDER_FALLBACK"),
    primary === "zavu" ? "ses" : "zavu",
  );
  const providers = primary === fallback ? [primary] : [primary, fallback];
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
