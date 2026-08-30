import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";
import { documentDecisionEmail } from "../_shared/emailTemplate.ts";
import { sendTransactionalEmail } from "../_shared/emailDelivery.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

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
    const { subject, text, html } = documentDecisionEmail({
      approved,
      iitName: submission.iit_name,
      note,
    });

    await sendTransactionalEmail({
      to: memberData.user.email,
      subject,
      text,
      html,
      idempotencyKey: `document-decision:${submission.id}:${submission.status}`,
    });
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
