import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";
import { loginCodeEmail } from "../_shared/emailTemplate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const SES_FROM_EMAIL = "Cirkle <verify@cirkle.world>";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const normalizeEmail = (value: unknown) => {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
};

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const bytesToHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
};

const hmac = async (key: ArrayBuffer | Uint8Array, value: string) =>
  crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(value),
  );

const getSignatureKey = async (secret: string, dateStamp: string, region: string, service: string) => {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
};

const amzDate = (date: Date) =>
  date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const sendWithSes = async (params: { to: string; code: string }) => {
  const region = Deno.env.get("AWS_REGION") || Deno.env.get("AWS_SES_REGION") || "ap-south-1";
  const accessKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const from = Deno.env.get("VERIFICATION_EMAIL_FROM") || SES_FROM_EMAIL;

  if (!accessKey || !secretKey) {
    throw new Error("AWS SES login OTP service is not configured");
  }

  const host = `email.${region}.amazonaws.com`;
  const endpoint = `https://${host}/v2/email/outbound-emails`;
  const { subject, text, html } = loginCodeEmail(params.code);
  const payload = JSON.stringify({
    FromEmailAddress: from,
    Destination: { ToAddresses: [params.to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: text, Charset: "UTF-8" },
          Html: { Data: html, Charset: "UTF-8" },
        },
      },
    },
  });

  const now = new Date();
  const dateHeader = amzDate(now);
  const dateStamp = dateHeader.slice(0, 8);
  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${dateHeader}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateHeader}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
  const signature = bytesToHex(await hmac(await getSignatureKey(secretKey, dateStamp, region, "ses"), stringToSign));

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: host,
        "X-Amz-Content-Sha256": payloadHash,
        "X-Amz-Date": dateHeader,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: payload,
      // Never leave the auth UI waiting indefinitely when SES has a transient
      // network problem. A retry is safe from the client after this fails.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("AWS SES login OTP request failed", error instanceof Error ? error.message : error);
    throw new Error("Email delivery is taking too long. Try again shortly.");
  }

  if (!response.ok) {
    const detail = await response.text();
    console.error("AWS SES login OTP delivery failed", response.status, detail.slice(0, 300));
    throw new Error("Could not deliver the login code. Try again shortly.");
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const pepper = Deno.env.get("VERIFICATION_CODE_PEPPER");
    if (!supabaseUrl || !serviceKey || !pepper) return json({ error: "Login OTP service is not configured" }, 503);

    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const redirectTo = typeof body.redirect_to === "string" ? body.redirect_to : undefined;
    if (!isValidEmail(email)) return json({ error: "Enter a valid email address" }, 400);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const forwardedFor = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { data: allowed, error: rateError } = await admin.rpc("reserve_login_otp_attempt", {
      p_email_hash: await sha256Hex(`${pepper}:email:${email}`),
      p_ip_hash: await sha256Hex(`${pepper}:ip:${forwardedFor}`),
    });
    if (rateError) throw new Error("Login code rate limiter is unavailable");
    if (allowed !== true) return json({ error: "Too many code requests. Wait 15 minutes and try again." }, 429);
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (error) throw error;

    const code = data.properties?.email_otp;
    if (!code) throw new Error("Supabase did not return an email OTP");
    await sendWithSes({ to: email, code });

    return json({ success: true });
  } catch (error) {
    console.error("request-login-otp failed", error instanceof Error ? error.message : error);
    return json({ error: error instanceof Error ? error.message : "Could not send login code" }, 500);
  }
});
