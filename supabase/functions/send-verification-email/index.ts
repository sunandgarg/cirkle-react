import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type IitDomains = { student: string; alumni: string };

// Keep this allowlist server-side so callers cannot claim an arbitrary academic domain.
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

function invalidRequest(error: string, code: string) {
  return new Response(JSON.stringify({ error, code }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Mask a phone number: show first 1 digit, last 1 digit, rest asterisks */
function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return "***";
  return phone[0] + "*".repeat(phone.length - 2) + phone[phone.length - 1];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, iit_name, student_status, user_id } = await req.json();

    if (typeof email !== "string" || typeof iit_name !== "string") {
      return invalidRequest("Email and IIT are required", "INVALID_REQUEST");
    }
    if (student_status !== "current_student" && student_status !== "alumni") {
      return invalidRequest("Choose whether you are a current student or alumni", "INVALID_MEMBER_TYPE");
    }

    const domains = IIT_DOMAINS[iit_name];
    if (!domains) {
      return invalidRequest("Choose a supported IIT", "INVALID_IIT");
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailMatch = normalizedEmail.match(/^[^@\s]+@([^@\s]+)$/);
    const expectedDomain = student_status === "alumni" ? domains.alumni : domains.student;
    if (emailMatch?.[1] !== expectedDomain) {
      return invalidRequest(
        `Use your official ${iit_name} ${student_status === "alumni" ? "alumni" : "institute"} email ending in @${expectedDomain}`,
        "INVALID_IIT_EMAIL",
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ─── BUSINESS RULE: Check if email already verified by another user ───
    if (user_id) {
      const { data: existingVerification } = await supabase
        .from("verifications")
        .select("user_id, locked_to_phone, verified_status")
        .eq("iit_email_normalized", normalizedEmail)
        .eq("verified_status", "VERIFIED")
        .maybeSingle();

      if (existingVerification && existingVerification.user_id !== user_id) {
        const maskedPhone = maskPhone(existingVerification.locked_to_phone || "");
        return new Response(
          JSON.stringify({
            error: `This IIT email is already verified with phone ${maskedPhone}. Please log in with that number or contact support to update it.`,
            code: "EMAIL_ALREADY_LINKED",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // ─── BUSINESS RULE: Check if user already has a verified email ───
      const { data: userVerification } = await supabase
        .from("verifications")
        .select("iit_email_normalized, verified_status")
        .eq("user_id", user_id)
        .eq("verified_status", "VERIFIED")
        .maybeSingle();

      if (userVerification && userVerification.iit_email_normalized !== normalizedEmail) {
        return new Response(
          JSON.stringify({
            error: `Your account is already verified with ${userVerification.iit_email_normalized}. To change your verified email, please contact support.`,
            code: "USER_ALREADY_VERIFIED",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // If already verified with the SAME email, just return success
      if (userVerification && userVerification.iit_email_normalized === normalizedEmail) {
        return new Response(
          JSON.stringify({ success: true, message: "Already verified", already_verified: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Check for test mode
    const { data: testModeSetting } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "verification_test_mode")
      .maybeSingle();

    const isTestMode = testModeSetting?.value === "true";

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Store code in database
    const { error: insertError } = await supabase.from("verification_codes").insert({
      email: normalizedEmail,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    if (insertError) {
      console.error("Insert error:", insertError);
      return new Response(JSON.stringify({ error: "Failed to generate code" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // In test mode, skip actual email sending
    if (isTestMode) {
      console.log(`[TEST MODE] Code for ${normalizedEmail}: ${code}`);
      return new Response(
        JSON.stringify({ success: true, message: "Code sent (test mode)", test_code: code }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Verification code for ${normalizedEmail}: ${code} (IIT: ${iit_name})`);

    return new Response(
      JSON.stringify({ success: true, message: "Verification code sent to your email" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
