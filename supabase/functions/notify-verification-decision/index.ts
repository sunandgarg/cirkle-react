import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

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

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character] || character));

const sendWithSes = async (params: { to: string; subject: string; text: string; html: string }) => {
  const region = Deno.env.get("AWS_REGION") || Deno.env.get("AWS_SES_REGION") || "ap-south-1";
  const accessKey = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const from = Deno.env.get("VERIFICATION_EMAIL_FROM") || "Cirkle <verify@cirkle.world>";
  if (!accessKey || !secretKey) throw new Error("AWS SES is not configured");

  const host = `email.${region}.amazonaws.com`;
  const payload = JSON.stringify({
    FromEmailAddress: from,
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
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Document decision delivery failed", response.status, detail.slice(0, 300));
    throw new Error("Could not deliver the decision email");
  }
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Notification service is not configured" }, 503);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let submissionId = "";
  try {
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Authentication required" }, 401);
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Invalid or expired session" }, 401);
    const { data: role } = await admin.from("user_roles").select("user_id").eq("user_id", authData.user.id).eq("role", "admin").maybeSingle();
    if (!role) return json({ error: "Admin access required" }, 403);

    const body = await request.json().catch(() => ({}));
    submissionId = typeof body.submission_id === "string" ? body.submission_id : "";
    if (!submissionId) return json({ error: "Submission ID is required" }, 400);

    const { data: submission, error: submissionError } = await admin.from("document_verifications")
      .select("id,user_id,iit_name,status,review_notes")
      .eq("id", submissionId)
      .maybeSingle();
    if (submissionError) throw submissionError;
    if (!submission || !["approved", "rejected"].includes(submission.status)) {
      return json({ error: "A reviewed submission is required" }, 409);
    }

    const { data: memberData, error: memberError } = await admin.auth.admin.getUserById(submission.user_id);
    if (memberError || !memberData.user?.email) throw memberError || new Error("Member login email was not found");

    const approved = submission.status === "approved";
    const note = submission.review_notes?.trim();
    const subject = approved ? "Your Cirkle IIT verification is approved" : "Action needed for your Cirkle verification";
    const text = approved
      ? `Your ${submission.iit_name} document has been approved. Sign in to Cirkle to finish your profile.`
      : `Your ${submission.iit_name} document was not approved.${note ? ` Reason: ${note}` : ""} Sign in to Cirkle to submit another document or verify by email.`;
    const safeIit = escapeHtml(submission.iit_name);
    const safeNote = note ? escapeHtml(note) : "";
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#111827"><h2>${approved ? "Verification approved" : "Verification needs attention"}</h2><p>Your <strong>${safeIit}</strong> document ${approved ? "has been approved." : "was not approved."}</p>${safeNote ? `<p style="padding:12px;background:#f3f4f6;border-radius:10px"><strong>Admin note:</strong> ${safeNote}</p>` : ""}<p><a href="https://cirkle.world/auth" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px">Open Cirkle</a></p><p style="font-size:12px;color:#6b7280">This email was sent to the login email connected to your Cirkle account.</p></div>`;

    await sendWithSes({ to: memberData.user.email, subject, text, html });
    await admin.from("document_verifications").update({
      decision_notified_at: new Date().toISOString(),
      decision_notification_error: null,
    }).eq("id", submission.id);
    return json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not send the decision email";
    console.error("notify-verification-decision failed", message);
    if (submissionId) {
      await admin.from("document_verifications").update({ decision_notification_error: message.slice(0, 500) }).eq("id", submissionId);
    }
    return json({ error: message }, 502);
  }
});
