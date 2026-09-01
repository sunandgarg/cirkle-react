import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";
import { iitVerificationEmail } from "../_shared/emailTemplate.ts";
import { sendTransactionalEmail } from "../_shared/emailDelivery.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Authentication required" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const pepper = Deno.env.get("VERIFICATION_CODE_PEPPER");
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
      const emailContent = iitVerificationEmail(code, iitName);
      const delivery = await sendTransactionalEmail(
        {
          to: normalizedEmail,
          ...emailContent,
          idempotencyKey: `iit-verification:${codeRow.id}`,
        },
        {
          // Institute mail systems can filter providers differently from consumer
          // inboxes. Keep their routing independently configurable without
          // changing the provider used by login and password-reset emails.
          primary: Deno.env.get("EMAIL_PROVIDER_INSTITUTE_PRIMARY") || undefined,
          fallback: Deno.env.get("EMAIL_PROVIDER_INSTITUTE_FALLBACK") || undefined,
        },
      );
      console.info(JSON.stringify({
        event: "iit_verification_email_accepted",
        provider: delivery.provider,
        recipient_domain: normalizedEmail.split("@")[1],
        code_id: codeRow.id,
      }));
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
