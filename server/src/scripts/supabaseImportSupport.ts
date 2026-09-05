type Row = Record<string, unknown>;

export type StorageUrlRewriter = {
  readonly rewriteCount: number;
  rewrite<T>(value: T): T;
};

export const SUPABASE_EXPORT_VERSION = 2;
export const SOURCE_SNAPSHOT_TABLE = "supabase_source_snapshot_v2";
export const MIGRATION_ARTIFACT_TABLE = "supabase_migration_artifact";
export const PRIVATE_ARCHIVE_PREFIX = "supabase_private_archive:";

// This mirrors scripts/lib/supabase-export-config.mjs. A test intentionally
// compares the two lists so the exporter and importer cannot drift silently.
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

// These source tables contain security/control-plane history that must be
// preserved but must never become an active browser-queryable compatibility
// table. The API's legacy-table allowlist intentionally does not contain them.
export const PRIVATE_ARCHIVE_TABLES = new Set([
  "forum_anonymous_authors",
  "login_otp_rate_limits",
  "message_deleted_for_user",
  "realtime_delivery_outbox",
  "verification_codes",
]);

export function importedLegacyTableName(table: string): string {
  return PRIVATE_ARCHIVE_TABLES.has(table) ? `${PRIVATE_ARCHIVE_PREFIX}${table}` : table;
}

export function createSupabaseStorageUrlRewriter(input: {
  projectUrl: string;
  buckets: Array<{ id: string; public?: boolean }>;
  objects: Array<{ bucket: string; path: string }>;
  publicObjectUrl: (bucket: string, path: string) => string;
}): StorageUrlRewriter {
  const source = new URL(input.projectUrl);
  if (source.pathname !== "/" || source.search || source.hash || source.username || source.password) {
    throw new Error("Supabase project URL must contain only an origin");
  }
  const publicBuckets = new Set(input.buckets.filter((bucket) => bucket.public).map((bucket) => bucket.id));
  const exportedObjects = new Set(input.objects.map((object) => `${object.bucket}\0${object.path}`));
  let rewriteCount = 0;

  const rewriteString = (value: string): string => {
    let candidate: URL;
    try {
      candidate = new URL(value);
    } catch {
      return value;
    }
    if (candidate.origin !== source.origin) return value;
    const storagePrefix = "/storage/v1/object/";
    if (!candidate.pathname.startsWith(storagePrefix)) return value;
    const publicPrefix = `${storagePrefix}public/`;
    if (!candidate.pathname.startsWith(publicPrefix) || candidate.search || candidate.hash || candidate.username || candidate.password) {
      throw new Error("Unsupported source-host Supabase Storage URL");
    }
    const encodedSegments = candidate.pathname.slice(publicPrefix.length).split("/");
    if (encodedSegments.length < 2 || encodedSegments.some((segment) => !segment)) {
      throw new Error("Malformed source-host Supabase Storage URL");
    }
    let segments: string[];
    try {
      segments = encodedSegments.map(decodeURIComponent);
    } catch {
      throw new Error("Malformed source-host Supabase Storage URL encoding");
    }
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0"))) {
      throw new Error("Unsafe source-host Supabase Storage URL path");
    }
    const [bucket, ...pathSegments] = segments;
    const objectPath = pathSegments.join("/");
    const canonicalPath = `${publicPrefix}${encodeURIComponent(bucket!)}/${pathSegments.map(encodeURIComponent).join("/")}`;
    if (candidate.pathname !== canonicalPath || !publicBuckets.has(bucket!) || !exportedObjects.has(`${bucket}\0${objectPath}`)) {
      throw new Error("Source-host Supabase Storage URL has no hash-verified exported public object");
    }
    const rewritten = input.publicObjectUrl(bucket!, objectPath);
    const rewrittenUrl = new URL(rewritten);
    if (!new Set(["http:", "https:"]).has(rewrittenUrl.protocol) || rewrittenUrl.origin === source.origin) {
      throw new Error("Destination public-storage URL is invalid");
    }
    rewriteCount += 1;
    return rewritten;
  };

  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return rewriteString(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Row).map(([key, child]) => [key, rewrite(child)]));
    }
    return value;
  };

  return {
    get rewriteCount() { return rewriteCount; },
    rewrite: <T>(value: T): T => rewrite(value) as T,
  };
}

const scalar = (value: unknown): string | undefined => {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
};

const component = (row: Row, field: string): string => {
  const value = scalar(row[field]);
  if (!value) throw new Error(`Source row has no stable ${field}`);
  return value;
};

export function legacyRecordIdFor(table: string, row: Row): string {
  const recordId = (() => {
    switch (table) {
      case "academic_specialisations": return `${component(row, "degree_id")}:${component(row, "id")}`;
      case "client_error_logs": return component(row, "event_id");
      case "email_provider_daily_usage": return `${component(row, "provider")}:${component(row, "usage_date")}`;
      case "forum_anonymous_authors": return component(row, "post_id");
      case "forum_room_state": return `${component(row, "user_id")}:${component(row, "scope_type")}:${component(row, "scope_key")}`;
      case "onboarding_progress": return component(row, "user_id");
      case "pending_profile_options": return `${component(row, "user_id")}:${component(row, "field")}`;
      case "platform_owners":
      case "profiles": return component(row, "user_id");
      case "realtime_channel_registry": return component(row, "channel");
      case "user_activity_daily": return `${component(row, "user_id")}:${component(row, "activity_date")}`;
      case "user_activity_sessions": return `${component(row, "user_id")}:${component(row, "session_id")}`;
      case "verified_academic_affiliations": return component(row, "user_id");
      default: return component(row, "id");
    }
  })();
  if (recordId.length > 100) {
    throw new Error(`${table} source identity exceeds the MySQL LegacyRecord limit`);
  }
  return recordId;
}

export function buildAnonymousAuthorMap(values: Row[], knownUsers: Set<string>): Map<string, string> {
  const authors = new Map<string, string>();
  for (const row of values) {
    const postId = component(row, "post_id");
    const authorId = component(row, "author_id");
    if (!knownUsers.has(authorId)) throw new Error(`Anonymous post ${postId} references missing user ${authorId}`);
    const existing = authors.get(postId);
    if (existing && existing !== authorId) throw new Error(`Anonymous post ${postId} has conflicting owners`);
    authors.set(postId, authorId);
  }
  return authors;
}

export function assertAnonymousAuthorMappings(posts: Row[], authors: Map<string, string>): void {
  const postsById = new Map(posts.map((post) => [component(post, "id"), post]));
  for (const [postId, authorId] of authors) {
    const post = postsById.get(postId);
    if (!post) throw new Error(`Anonymous-author mapping references missing post ${postId}`);
    if (post.is_anonymous !== true) throw new Error(`Anonymous-author mapping references non-anonymous post ${postId}`);
    const directAuthor = scalar(post.author_id);
    if (directAuthor && directAuthor !== authorId) throw new Error(`Anonymous post ${postId} has conflicting owners`);
  }
}

export function importedPostAuthor(row: Row, anonymousAuthors: Map<string, string>, knownUsers: Set<string>): string | undefined {
  const postId = component(row, "id");
  const direct = scalar(row.author_id);
  const privateAuthor = anonymousAuthors.get(postId);
  if (row.is_anonymous === true && direct && privateAuthor && direct !== privateAuthor) {
    throw new Error(`Anonymous post ${postId} has conflicting owners`);
  }
  const authorId = row.is_anonymous === true ? privateAuthor ?? direct : direct;
  if (authorId && !knownUsers.has(authorId)) throw new Error(`Post ${postId} references missing user ${authorId}`);
  return authorId;
}

export function deletedMessageUsersByMessage(values: Row[], knownUsers: Set<string>): Map<string, string[]> {
  const usersByMessage = new Map<string, Set<string>>();
  for (const row of values) {
    const messageId = component(row, "message_id");
    const userId = component(row, "user_id");
    if (!knownUsers.has(userId)) throw new Error(`Deleted-message marker ${messageId} references missing user ${userId}`);
    const users = usersByMessage.get(messageId) ?? new Set<string>();
    users.add(userId);
    usersByMessage.set(messageId, users);
  }
  return new Map([...usersByMessage].map(([messageId, users]) => [messageId, [...users].sort()]));
}

export function withDeletedMessageUsers(row: Row, usersByMessage: Map<string, string[]>): Row {
  const id = component(row, "id");
  const existing = Array.isArray(row.deleted_for_users)
    ? row.deleted_for_users.filter((value): value is string => typeof value === "string")
    : [];
  const deleted = [...new Set([...existing, ...(usersByMessage.get(id) ?? [])])].sort();
  return deleted.length ? { ...row, deleted_for_users: deleted } : row;
}

export function googleProviderSubject(sourceUser: Row): string | undefined {
  const identities = Array.isArray(sourceUser.identities) ? sourceUser.identities : [];
  const google = identities.find((identity) => identity && typeof identity === "object"
    && (identity as Row).provider === "google") as Row | undefined;
  const identityData = google?.identity_data && typeof google.identity_data === "object" ? google.identity_data as Row : {};
  const metadata = sourceUser.user_metadata && typeof sourceUser.user_metadata === "object" ? sourceUser.user_metadata as Row : {};
  return scalar(identityData.sub) ?? scalar(google?.id) ?? scalar(metadata.provider_id) ?? scalar(metadata.sub);
}

export function buildPasswordHashMap(values: Row[], knownUsers: Set<string>, emailUsers: Set<string>): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const row of values) {
    const userId = scalar(row.user_id) ?? scalar(row.id);
    const passwordHash = scalar(row.password_hash) ?? scalar(row.encrypted_password);
    if (!userId || !knownUsers.has(userId) || !emailUsers.has(userId)) {
      throw new Error("Password verifier references an unknown or non-email Supabase user");
    }
    if (!passwordHash || !/^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
      throw new Error(`Password verifier for ${userId} is not a supported bcrypt hash`);
    }
    if (hashes.has(userId)) throw new Error(`Password verifier for ${userId} is duplicated`);
    hashes.set(userId, passwordHash);
  }
  return hashes;
}

export function assertCompleteManifest(input: {
  export_version?: unknown;
  source_schema_tables?: unknown;
  tables?: unknown;
}): void {
  if (input.export_version !== SUPABASE_EXPORT_VERSION) {
    throw new Error(`Supabase export version ${SUPABASE_EXPORT_VERSION} is required; create a fresh frozen-source export`);
  }
  if (!input.tables || typeof input.tables !== "object" || Array.isArray(input.tables)) throw new Error("Invalid Supabase table export");
  const tableNames = Object.keys(input.tables as Record<string, unknown>).sort();
  const schemaNames = Array.isArray(input.source_schema_tables)
    ? input.source_schema_tables.filter((value): value is string => typeof value === "string").sort()
    : [];
  const expected = SUPABASE_SOURCE_TABLES;
  const missing = expected.filter((table) => !tableNames.includes(table) || !schemaNames.includes(table));
  const unexpected = [...new Set([...tableNames, ...schemaNames])].filter((table) => !expected.includes(table));
  if (missing.length || unexpected.length || tableNames.length !== expected.length || schemaNames.length !== expected.length) {
    throw new Error(`Incomplete Supabase manifest. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
  }
}
