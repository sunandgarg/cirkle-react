import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const SES_FROM_EMAIL = "Cirkle <verify@cirkle.world>";

type MemberStatus = "current_student" | "alumni";
type IitDomains = { student: string; alumni: string };

const IIT_DOMAINS: Record<string, IitDomains> = {
  "IIT Bombay": { student: "iitb.ac.in", alumni: "alumni.iitb.ac.in" },
  "IIT Delhi": { student: "iitd.ac.in", alumni: "alumni.iitd.ac.in" },
  "IIT Madras": { student: "iitm.ac.in", alumni: "alumni.iitm.ac.in" },
  "IIT Kanpur": { student: "iitk.ac.in", alumni: "alumni.iitk.ac.in" },
  "IIT Kharagpur": { student: "iitkgp.ac.in", alumni: "alumni.iitkgp.ac.in" },
  "IIT Roorkee": { student: "iitr.ac.in", alumni: "alumni.iitr.ac.in" },
  "IIT Guwahati": { student: "iitg.ac.in", alumni: "alumni.iitg.ac.in" },
  "IIT Hyderabad": { student: "iith.ac.in", alumni: "alumni.iith.ac.in" },
  "IIT BHU": { student: "iitbhu.ac.in", alumni: "alumni.iitbhu.ac.in" },
  "IIT Indore": { student: "iiti.ac.in", alumni: "alumni.iiti.ac.in" },
  "IIT Ropar": { student: "iitrpr.ac.in", alumni: "alumni.iitrpr.ac.in" },
  "IIT Patna": { student: "iitp.ac.in", alumni: "alumni.iitp.ac.in" },
  "IIT Bhubaneswar": { student: "iitbbs.ac.in", alumni: "alumni.iitbbs.ac.in" },
  "IIT Gandhinagar": { student: "iitgn.ac.in", alumni: "alumni.iitgn.ac.in" },
  "IIT Jodhpur": { student: "iitj.ac.in", alumni: "alumni.iitj.ac.in" },
  "IIT Mandi": { student: "iitmandi.ac.in", alumni: "alumni.iitmandi.ac.in" },
  "IIT Tirupati": { student: "iittp.ac.in", alumni: "alumni.iittp.ac.in" },
  "IIT Palakkad": { student: "iitpkd.ac.in", alumni: "alumni.iitpkd.ac.in" },
  "IIT Dharwad": { student: "iitdh.ac.in", alumni: "alumni.iitdh.ac.in" },
  "IIT Bhilai": { student: "iitbhilai.ac.in", alumni: "alumni.iitbhilai.ac.in" },
  "IIT Goa": { student: "iitgoa.ac.in", alumni: "alumni.iitgoa.ac.in" },
  "IIT Jammu": { student: "iitjammu.ac.in", alumni: "alumni.iitjammu.ac.in" },
  "IIT Dhanbad (ISM)": { student: "iitism.ac.in", alumni: "alumni.iitism.ac.in" },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const normalizeAndValidate = (email: unknown, iitName: unknown, status: unknown) => {
  if (typeof email !== "string" || typeof iitName !== "string") throw new Error("Email and IIT are required");
  if (status !== "current_student" && status !== "alumni") throw new Error("Choose whether you are a current student or alumni");
  const domains = IIT_DOMAINS[iitName];
  if (!domains) throw new Error("Choose a supported IIT");
  const normalizedEmail = email.trim().toLowerCase();
  const domain = normalizedEmail.match(/^[^@\s]+@([^@\s]+)$/)?.[1];
  const expectedDomain = status === "alumni" ? domains.alumni : domains.student;
  if (domain !== expectedDomain) throw new Error(`Use your official ${iitName} email ending in @${expectedDomain}`);
  return { normalizedEmail, iitName, status: status as MemberStatus };
};

const randomCode = () => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(100000 + (value[0] % 900000));
};

const hashCode = async (userId: string, email: string, code: string, pepper: string) => {
  const bytes = new TextEncoder().encode(`${userId}:${email}:${code}:${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

const getSignatureKey = async (secret: string, dateStamp: string, region: string, service: string) => {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
};

const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const sendWithSes = async (params: { to: string; from: string; subject: string; text: string; html: string }) => {
  const region = Deno.env.get("AWS_REGION") || Deno.env.get("AWS_SES_REGION") || "ap-south-1";
  const accessKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!accessKey || !secretKey) throw new Error("AWS SES is not configured");

  const host = `email.${region}.amazonaws.com`;
  const payload = JSON.stringify({
    FromEmailAddress: params.from,
    Destination: { ToAddresses: [params.to] },
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: params.text, Charset: "UTF-8" },
          Html: { Data: params.html, Charset: "UTF-8" },
        },
      },
    },
  });
  const dateHeader = amzDate(new Date());
  const dateStamp = dateHeader.slice(0, 8);
  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${dateHeader}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateHeader}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
  const signature = bytesToHex(await hmac(await getSignatureKey(secretKey, dateStamp, region, "ses"), stringToSign));

  const delivery = await fetch(`https://${host}/v2/email/outbound-emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: host,
      "X-Amz-Content-Sha256": payloadHash,
      "X-Amz-Date": dateHeader,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: payload,
  });
  if (!delivery.ok) {
    const detail = await delivery.text();
    console.error("AWS SES verification email delivery failed", delivery.status, detail.slice(0, 300));
    throw new Error("Could not deliver the verification email. Try again shortly.");
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Authentication required" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const pepper = Deno.env.get("VERIFICATION_CODE_PEPPER");
    const emailFrom = Deno.env.get("VERIFICATION_EMAIL_FROM") || SES_FROM_EMAIL;
    if (!supabaseUrl || !serviceKey || !pepper) {
      return json({ error: "Email verification service is not configured" }, 503);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Invalid or expired session" }, 401);

    const body = await req.json().catch(() => ({}));
    let request: ReturnType<typeof normalizeAndValidate>;
    try {
      request = normalizeAndValidate(body.email, body.iit_name, body.student_status);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
    }

    const { normalizedEmail, iitName } = request;
    const { data: emailOwner } = await admin.from("verifications")
      .select("user_id").eq("iit_email_normalized", normalizedEmail).eq("verified_status", "VERIFIED").maybeSingle();
    if (emailOwner && emailOwner.user_id !== authData.user.id) {
      return json({ error: "This IIT email is already linked to another account", code: "EMAIL_ALREADY_LINKED" }, 409);
    }
    const { data: ownVerification } = await admin.from("verifications")
      .select("iit_email_normalized").eq("user_id", authData.user.id).eq("verified_status", "VERIFIED").maybeSingle();
    if (ownVerification?.iit_email_normalized === normalizedEmail) {
      return json({ success: true, already_verified: true });
    }
    if (ownVerification) {
      return json({ error: "Your account is already linked to another IIT email. Contact support to change it.", code: "USER_ALREADY_VERIFIED" }, 409);
    }

    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const [{ count: recentEmailCount }, { count: recentUserCount }] = await Promise.all([
      admin.from("verification_codes").select("id", { count: "exact", head: true })
        .eq("email", normalizedEmail).gte("created_at", fifteenMinutesAgo),
      admin.from("verification_codes").select("id", { count: "exact", head: true })
        .eq("user_id", authData.user.id).gte("created_at", oneHourAgo),
    ]);
    if ((recentEmailCount || 0) >= 3 || (recentUserCount || 0) >= 10) {
      return json({ error: "Too many verification requests. Try again later." }, 429);
    }

    const code = randomCode();
    const codeHash = await hashCode(authData.user.id, normalizedEmail, code, pepper);
    await admin.from("verification_codes").update({ used: true }).eq("user_id", authData.user.id).eq("email", normalizedEmail).eq("used", false);
    const { data: codeRow, error: insertError } = await admin.from("verification_codes").insert({
      user_id: authData.user.id,
      email: normalizedEmail,
      code: codeHash,
      attempts: 0,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    }).select("id").single();
    if (insertError || !codeRow) throw insertError || new Error("Could not create verification code");

    try {
      await sendWithSes({
        from: emailFrom,
        to: normalizedEmail,
        subject: "Your Cirkle verification code",
        text: `Your Cirkle verification code is ${code}. This code expires in 10 minutes.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>Verify your ${iitName} email</h2><p>Enter this code in Cirkle:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>`,
      });
    } catch (error) {
      await admin.from("verification_codes").delete().eq("id", codeRow.id);
      return json({ error: error instanceof Error ? error.message : "Could not deliver the verification email. Try again shortly." }, 502);
    }

    return json({ success: true, message: "Verification code sent" });
  } catch (error) {
    console.error("send-verification-email failed", error instanceof Error ? error.message : error);
    return json({ error: "Internal server error" }, 500);
  }
});
