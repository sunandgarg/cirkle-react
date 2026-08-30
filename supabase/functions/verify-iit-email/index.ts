import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type MemberStatus = "current_student" | "alumni";
const IIT_DOMAINS: Record<string, { student: string; alumni: string }> = {
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
    if (!supabaseUrl || !serviceKey || !pepper) return json({ error: "Verification service is not configured" }, 503);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Invalid or expired session" }, 401);

    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const iitName = typeof body.iit_name === "string" ? body.iit_name : "";
    const status = body.student_status as MemberStatus;
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code) || (status !== "current_student" && status !== "alumni")) {
      return json({ error: "Enter a valid verification code" }, 400);
    }
    const domains = IIT_DOMAINS[iitName];
    const domain = email.match(/^[^@\s]+@([^@\s]+)$/)?.[1];
    const expectedDomain = status === "alumni" ? domains?.alumni : domains?.student;
    if (!domains || domain !== expectedDomain) return json({ error: "Invalid IIT email" }, 400);

    const { data: codeRow, error: codeError } = await admin.from("verification_codes")
      .select("id,code,attempts,expires_at")
      .eq("user_id", authData.user.id).eq("email", email).eq("used", false)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (codeError) throw codeError;
    if (!codeRow || new Date(codeRow.expires_at).getTime() <= Date.now()) {
      return json({ error: "Invalid or expired code. Request a new one." }, 400);
    }
    if ((codeRow.attempts || 0) >= 5) return json({ error: "Too many incorrect attempts. Request a new code." }, 429);

    const expectedHash = await hashCode(authData.user.id, email, code, pepper);
    if (expectedHash !== codeRow.code) {
      await admin.from("verification_codes").update({ attempts: (codeRow.attempts || 0) + 1 }).eq("id", codeRow.id);
      return json({ error: "Invalid or expired code. Please try again." }, 400);
    }

    const { data: memberProfile } = await admin.from("profiles")
      .select("name,phone_full")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    const phone = String(memberProfile?.phone_full || authData.user.phone || authData.user.user_metadata?.phone_full || authData.user.user_metadata?.phone || "");
    const displayName = String(memberProfile?.name || authData.user.user_metadata?.name || authData.user.email || "Cirkle Member");
    const { error: completionError } = await admin.rpc("complete_iit_email_verification", {
      p_code_id: codeRow.id,
      p_user_id: authData.user.id,
      p_email: email,
      p_iit_name: iitName,
      p_student_status: status,
      p_locked_phone: phone,
      p_display_name: displayName,
    });
    if (completionError) throw completionError;
    return json({ success: true });
  } catch (error) {
    console.error("verify-iit-email failed", error instanceof Error ? error.message : error);
    return json({ error: "Verification could not be completed" }, 500);
  }
});
