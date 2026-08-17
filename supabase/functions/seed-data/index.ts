import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const TEST_EMAIL_DOMAIN = "loadtest.cirkle.invalid";
const SEED_VERSION = "2026-08-17-mba-delhi-v1";
const COHORT_SCOPE = { scope_type: "COHORT", scope_key: "IIT_DELHI|MBA|GENERAL|2026", channel: "cohort" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (Deno.env.get("SEED_DATA_ENABLED") !== "true") return json({ error: "Test-data management is disabled" }, 404);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const accessToken = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!accessToken) return json({ error: "Authentication required" }, 401);
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken);
    if (authError || !authData.user) return json({ error: "Invalid session" }, 401);
    const { data: role } = await admin.from("user_roles").select("role").eq("user_id", authData.user.id).eq("role", "admin").maybeSingle();
    if (!role) return json({ error: "Admin access required" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body?.action === "purge" ? "purge" : "seed";
    const { data: seedState } = await admin.from("app_settings").select("value").eq("key", "test_seed_user_ids").maybeSingle();
    const trackedIds = (() => { try { return JSON.parse(seedState?.value || "[]") as string[]; } catch { return []; } })();

    if (action === "purge") {
      const ids = [...new Set(trackedIds)];
      if (!ids.length) return json({ success: true, deletedUsers: 0, message: "No tracked dummy data found" });

      await admin.from("posts").delete().in("author_id", ids);
      await admin.from("messages").delete().in("sender_id", ids);
      await admin.from("connections").delete().in("requester_id", ids);
      await admin.from("connections").delete().in("receiver_id", ids);
      await admin.from("chat_rooms").delete().in("created_by", ids);
      for (const userId of ids) {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw error;
      }
      await admin.from("app_settings").delete().in("key", ["test_seed_user_ids", "test_seed_version", "test_seed_summary"]);
      return json({ success: true, deletedUsers: ids.length, message: "All tracked dummy users and their data were removed" });
    }

    if (trackedIds.length) return json({ success: true, alreadySeeded: true, usersCreated: trackedIds.length, seedVersion: SEED_VERSION });

    const names = [
      "Aarav Mehta", "Aditi Rao", "Arjun Kapoor", "Ananya Singh", "Dev Malhotra", "Diya Sharma",
      "Ishaan Gupta", "Ishita Nair", "Kabir Khanna", "Kavya Iyer", "Krish Verma", "Meera Joshi",
      "Neil Bhatia", "Nisha Reddy", "Pranav Sethi", "Priya Menon", "Rahul Jain", "Rhea Arora",
      "Rohan Das", "Saanvi Shah", "Siddharth Bose", "Sneha Pillai", "Vihaan Chopra", "Zoya Mirza",
    ];
    const userIds: string[] = [];

    for (let index = 0; index < names.length; index++) {
      const email = `mba-delhi-2026-${String(index + 1).padStart(2, "0")}@${TEST_EMAIL_DOMAIN}`;
      const { data, error } = await admin.auth.admin.createUser({
        email, password: `D-${crypto.randomUUID()}-${crypto.randomUUID()}`, email_confirm: true,
        user_metadata: { name: names[index], is_dummy: true, seed_version: SEED_VERSION },
      });
      if (error || !data.user) throw error || new Error(`Could not create ${email}`);
      const userId = data.user.id;
      userIds.push(userId);
      // Persist progress first so an interrupted seed can always be fully purged.
      const { error: trackingError } = await admin.from("app_settings").upsert({
        key: "test_seed_user_ids", value: JSON.stringify(userIds), updated_by: authData.user.id,
      }, { onConflict: "key" });
      if (trackingError) throw trackingError;
      const { error: profileError } = await admin.from("profiles").upsert({
        user_id: userId, name: names[index], iit_name: "IIT Delhi", student_status: "alumni",
        headline: "MBA · General · IIT Delhi · Class of 2026", location: "New Delhi",
        is_verified: true, onboarding_completed: false,
      }, { onConflict: "user_id" });
      if (profileError) throw profileError;
      const { data: education, error: educationError } = await admin.from("education").insert({
        user_id: userId, institution: "IIT Delhi", degree: "MBA", branch_area: "General", passing_year: "2026",
      }).select("id").single();
      if (educationError) throw educationError;
      const { error: linkError } = await admin.from("profiles").update({ primary_education_id: education.id, onboarding_completed: true }).eq("user_id", userId);
      if (linkError) throw linkError;
      const { error: affiliationError } = await admin.from("verified_academic_affiliations").upsert({
        user_id: userId, network_id: "IIT", institute_id: "IIT_DELHI", degree_id: "MBA",
        specialisation_id: "GENERAL", graduation_year: 2026, member_status: "alumni",
        verification_status: "VERIFIED", source_education_id: education.id,
      }, { onConflict: "user_id" });
      if (affiliationError) throw affiliationError;
    }

    const topics = [
      "placement updates", "case interview practice", "product strategy", "finance electives", "consulting prep",
      "alumni meetup", "startup ideas", "marketing analytics", "operations project", "campus memories",
    ];
    const topLevelRows = Array.from({ length: 1200 }, (_, index) => ({
      ...COHORT_SCOPE,
      community_id: "default",
      author_id: userIds[index % userIds.length],
      content: `${names[index % names.length]}: MBA General 2026 load conversation #${index + 1} — ${topics[index % topics.length]}.`,
      is_anonymous: index % 37 === 0,
      created_at: new Date(Date.now() - (1200 - index) * 900).toISOString(),
    }));
    const parentIds: string[] = [];
    for (let offset = 0; offset < topLevelRows.length; offset += 200) {
      const { data, error } = await admin.from("posts").insert(topLevelRows.slice(offset, offset + 200)).select("id");
      if (error) throw error;
      parentIds.push(...(data || []).map((row) => row.id));
    }

    const replyRows = Array.from({ length: 300 }, (_, index) => ({
      ...COHORT_SCOPE,
      community_id: "default",
      author_id: userIds[(index + 3) % userIds.length],
      reply_to_id: parentIds[(index * 4) % parentIds.length],
      content: `Thread reply #${index + 1}: adding a cohort perspective to this discussion.`,
      is_anonymous: index % 41 === 0,
      created_at: new Date(Date.now() - (300 - index) * 850).toISOString(),
    }));
    for (let offset = 0; offset < replyRows.length; offset += 200) {
      const { error } = await admin.from("posts").insert(replyRows.slice(offset, offset + 200));
      if (error) throw error;
    }

    await admin.from("app_settings").upsert([
      { key: "test_seed_user_ids", value: JSON.stringify(userIds), updated_by: authData.user.id },
      { key: "test_seed_version", value: SEED_VERSION, updated_by: authData.user.id },
      { key: "test_seed_summary", value: JSON.stringify({ users: userIds.length, messages: 1500, scope: COHORT_SCOPE }), updated_by: authData.user.id },
    ], { onConflict: "key" });

    return json({ success: true, seedVersion: SEED_VERSION, usersCreated: userIds.length, messagesCreated: 1500, scope: COHORT_SCOPE });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Test-data operation failed" }, 500);
  }
});
