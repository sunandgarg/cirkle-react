export const SUPABASE_EXPORT_VERSION = 2;

// Keep this list explicit. A service-role export must fail on schema drift
// instead of silently copying only the tables an older release knew about.
export const SUPABASE_SOURCE_TABLES = [
  "academic_degrees", "academic_institutes", "academic_networks", "academic_specialisations", "ad_messages",
  "app_settings", "applications", "blog_bookmarks", "blog_comments", "blog_likes", "blogs", "call_participants",
  "call_sessions", "chat_members", "chat_rooms", "client_error_logs", "comments", "connections", "consultations",
  "course_verification_requests", "custom_options", "custom_skills", "document_verifications", "education",
  "email_provider_daily_usage", "event_scan_runs", "events", "forum_anonymous_authors", "forum_deleted_for_user",
  "forum_room_state", "iit_recruiters", "job_engagement_events", "job_scan_runs", "job_scan_sources", "jobs",
  "login_otp_rate_limits", "message_deleted_for_user", "messages", "nav_config", "notifications", "onboarding_progress",
  "pending_profile_options", "pinned_messages", "platform_owners", "poll_votes", "polls", "posts",
  "professional_experience", "profiles", "reactions", "realtime_channel_registry", "realtime_delivery_outbox",
  "reports", "rsvps", "saved_views", "stories", "user_activity_daily", "user_activity_sessions",
  "user_pinned_messages", "user_roles", "verification_audit_log", "verification_codes", "verifications",
  "verified_academic_affiliations",
].sort();

// PostgREST pagination without a total order can skip or repeat rows. Most
// tables have a unique `id`; these tables use a different or composite key.
export const SUPABASE_TABLE_ORDER = {
  academic_specialisations: "degree_id.asc,id.asc",
  client_error_logs: "event_id.asc",
  email_provider_daily_usage: "provider.asc,usage_date.asc",
  forum_anonymous_authors: "post_id.asc",
  forum_room_state: "user_id.asc,scope_type.asc,scope_key.asc",
  onboarding_progress: "user_id.asc",
  pending_profile_options: "user_id.asc,field.asc",
  platform_owners: "user_id.asc",
  profiles: "user_id.asc",
  realtime_channel_registry: "channel.asc",
  user_activity_daily: "user_id.asc,activity_date.asc",
  user_activity_sessions: "user_id.asc,session_id.asc",
  verified_academic_affiliations: "user_id.asc",
};

export function assertSupabaseSourceSchema(liveTables) {
  const live = [...new Set(liveTables)].sort();
  const missingFromAllowlist = live.filter((table) => !SUPABASE_SOURCE_TABLES.includes(table));
  const missingFromSource = SUPABASE_SOURCE_TABLES.filter((table) => !live.includes(table));
  if (missingFromAllowlist.length || missingFromSource.length) {
    throw new Error(
      `Supabase schema drift detected. Unreviewed source tables: ${missingFromAllowlist.join(", ") || "none"}. `
      + `Expected tables absent from source: ${missingFromSource.join(", ") || "none"}.`,
    );
  }
  return live;
}

const nonEmptyString = (value) => typeof value === "string" && value ? value : undefined;

export function emailProviderUserIds(users) {
  const ids = new Set();
  for (const user of users) {
    const userId = nonEmptyString(user?.id);
    if (!userId) throw new Error("Supabase auth export contains a user without an ID");
    const providers = Array.isArray(user?.app_metadata?.providers) ? user.app_metadata.providers : [];
    if (providers.includes("email")) ids.add(userId);
  }
  return ids;
}

export function validatePasswordHashRows(users, values) {
  if (!Array.isArray(values)) throw new Error("Password hash export must contain a JSON array");
  const knownUsers = new Set(users.map((user) => nonEmptyString(user?.id)));
  if (knownUsers.has(undefined) || knownUsers.size !== users.length) {
    throw new Error("Supabase auth export contains duplicate or missing user IDs");
  }
  const emailUsers = emailProviderUserIds(users);
  const seen = new Set();
  const rows = values.map((row) => {
    const userId = nonEmptyString(row?.user_id) ?? nonEmptyString(row?.id);
    const passwordHash = nonEmptyString(row?.password_hash) ?? nonEmptyString(row?.encrypted_password);
    if (!userId || !knownUsers.has(userId) || !emailUsers.has(userId)) {
      throw new Error("Password hash references an unknown or non-email Supabase user");
    }
    if (seen.has(userId)) throw new Error("Password hash export contains a duplicate user");
    if (!passwordHash || !/^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
      throw new Error("Password hash export contains a non-bcrypt verifier");
    }
    seen.add(userId);
    return { user_id: userId, password_hash: passwordHash };
  });
  if (seen.size !== emailUsers.size) {
    throw new Error(`Password hash export is incomplete: expected ${emailUsers.size}, received ${seen.size}`);
  }
  return rows.sort((left, right) => left.user_id.localeCompare(right.user_id));
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}
