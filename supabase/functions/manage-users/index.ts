import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

const clean = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const accessToken = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Authentication required" }, 401);
  const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
  if (authError || !authData.user) return json({ error: "Invalid session" }, 401);
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", authData.user.id).eq("role", "admin").maybeSingle();
  if (!role) return json({ error: "Admin access required" }, 403);

  try {
    const body = await req.json();
    if (body?.action === "create_member") {
      const email = clean(body.email, 254).toLowerCase();
      const password = String(body.password ?? "");
      const name = clean(body.name, 120);
      const institute = clean(body.iit_name, 120);
      const degree = clean(body.degree, 80);
      const specialisation = clean(body.specialisation, 100);
      const year = Number(body.graduation_year);
      const memberStatus = body.student_status === "current_student" ? "current_student" : "alumni";
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email" }, 400);
      if (password.length < 8) return json({ error: "Password must contain at least 8 characters" }, 400);
      if (!name || institute !== "IIT Delhi" || degree !== "MBA" || specialisation !== "General" || year !== 2026) {
        return json({ error: "The requested academic profile is invalid" }, 400);
      }

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name, full_name: name },
      });
      if (createError || !created.user) throw createError || new Error("Could not create member");
      const userId = created.user.id;
      try {
        const { error: profileError } = await admin.from("profiles").upsert({
          user_id: userId, name, iit_name: institute, student_status: memberStatus,
          headline: `${degree} · ${specialisation} · ${institute} · Class of ${year}`,
          location: "New Delhi", is_verified: true, onboarding_completed: false,
        }, { onConflict: "user_id" });
        if (profileError) throw profileError;
        const { data: education, error: educationError } = await admin.from("education").insert({
          user_id: userId, institution: institute, degree, branch_area: specialisation, passing_year: String(year), location: "New Delhi",
        }).select("id").single();
        if (educationError) throw educationError;
        const { error: linkError } = await admin.from("profiles").update({
          primary_education_id: education.id, onboarding_completed: true,
        }).eq("user_id", userId);
        if (linkError) throw linkError;
        const { error: affiliationError } = await admin.from("verified_academic_affiliations").upsert({
          user_id: userId, network_id: "IIT", institute_id: "IIT_DELHI", degree_id: "MBA",
          specialisation_id: "GENERAL", graduation_year: year, member_status: memberStatus,
          verification_status: "VERIFIED", source_education_id: education.id,
        }, { onConflict: "user_id" });
        if (affiliationError) throw affiliationError;
      } catch (error) {
        await admin.auth.admin.deleteUser(userId);
        throw error;
      }
      return json({ success: true, user_id: userId });
    }

    if (body?.action === "delete_member") {
      const targetId = clean(body.user_id, 64);
      const confirmation = clean(body.confirmation, 120);
      if (!targetId || targetId === authData.user.id) return json({ error: "You cannot delete your own account here" }, 400);
      const { data: targetRole } = await admin.from("user_roles").select("role").eq("user_id", targetId).eq("role", "admin").maybeSingle();
      if (targetRole) return json({ error: "Admin accounts cannot be deleted from this control" }, 403);
      const { data: targetProfile } = await admin.from("profiles").select("name").eq("user_id", targetId).maybeSingle();
      if (!targetProfile) return json({ error: "Member not found" }, 404);
      if (confirmation !== (targetProfile.name || "Unnamed member")) return json({ error: "Confirmation name did not match" }, 400);
      const { error } = await admin.auth.admin.deleteUser(targetId);
      if (error) throw error;
      return json({ success: true });
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "User management failed" }, 500);
  }
});

