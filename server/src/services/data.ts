import { Prisma, type Event, type Profile } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import type { RequestContext } from "../types.js";
import { newId, sha256 } from "../security/crypto.js";
import { emitDbChange } from "../realtime/events.js";
import { allowedForumScopes, canUseForumScope } from "../security/forumScope.js";
import { applyCardinality, matchesFilter, matchesLogicNode, parseInValue, parseOrExpression, projectColumns, type ParsedLogicNode, type SerializedFilter, type SerializedQuery } from "../data/query.js";
import { contentTombstone, deletedContentFields, isDeletedForEveryone, privateMediaObjectKeys } from "../security/tombstone.js";
import { dateOnly, normalizeDateOfBirth, normalizeHttpUrl, normalizeSocialLinks } from "./profile.js";
import { assertOwnedReadyObject, canAccessStoryOwner, storyIsActive } from "./storage.js";
import { applyProfileEntryModeration, assertModeratedProfileWrite, profileEntryVisible, validateModeratedProfileEntry, type CatalogOption, type ModeratedProfileTable } from "./moderation.js";
import { createForumPostsWithSlowMode } from "./forumSlowMode.js";
import { isCanonicalRealtimeRecordId } from "../realtime/appsyncChannels.js";
import { forumPostMediaHandles, redactAnonymousPostForViewer } from "./forum.js";
import { dailyParticipantLeaseIsFresh } from "./daily.js";

type Row = Record<string, unknown>;

export function callSessionRecordIdentity(sessionId: string): Prisma.LegacyRecordWhereUniqueInput {
  return { table_name_record_id: { table_name: "call_sessions", record_id: sessionId } };
}

interface TablePolicy {
  delegate: string;
  read: readonly string[];
  write: readonly string[];
  ownerField?: string;
  adminWrite?: boolean;
  verifiedRead?: boolean;
}

const policies: Record<string, TablePolicy> = {
  profiles: { delegate: "profile", read: ["user_id", "name", "slug", "avatar_url", "cover_photo_url", "headline", "bio", "location", "date_of_birth", "phone_country_code", "phone_number", "phone_full", "iit_email", "iit_name", "student_status", "community_id", "role", "is_verified", "onboarding_completed", "is_mentor", "mentor_category", "mentor_price_chat", "mentor_price_audio", "mentor_price_video", "expertise", "skills", "experience", "social_links", "primary_education_id", "slug_updated_at", "created_at", "updated_at"], write: ["name", "slug", "avatar_url", "cover_photo_url", "headline", "bio", "location", "date_of_birth", "iit_name", "student_status", "onboarding_completed", "is_mentor", "mentor_category", "mentor_price_chat", "mentor_price_audio", "mentor_price_video", "expertise", "skills", "experience", "social_links", "primary_education_id", "slug_updated_at"], ownerField: "user_id" },
  posts: { delegate: "post", read: ["id", "author_id", "content", "community_id", "channel", "scope_type", "scope_key", "is_anonymous", "tags", "campus_filter", "degree_filter", "branch_filter", "batch_filter", "cohort_filter", "student_status_filter", "image_url", "image_path", "media_url", "media_type", "media_path", "media_metadata", "file_url", "file_path", "file_name", "file_type", "file_size", "voice_url", "voice_path", "voice_duration", "client_id", "message_type", "reply_to_id", "reshared_post_id", "is_deleted_for_everyone", "deleted_by_user_id", "deleted_for_users", "seen_by", "deleted_at", "edited_at", "pinned_at", "created_at", "updated_at"], write: ["content", "community_id", "channel", "scope_type", "scope_key", "is_anonymous", "tags", "campus_filter", "degree_filter", "branch_filter", "batch_filter", "cohort_filter", "student_status_filter", "image_url", "image_path", "media_url", "media_type", "media_path", "media_metadata", "file_url", "file_path", "file_name", "file_type", "file_size", "voice_url", "voice_path", "voice_duration", "client_id", "message_type", "reply_to_id", "reshared_post_id", "edited_at", "is_deleted_for_everyone", "pinned_at"], ownerField: "author_id", verifiedRead: true },
  comments: { delegate: "comment", read: ["id", "post_id", "author_id", "content", "parent_comment_id", "edited_at", "created_at", "updated_at"], write: ["post_id", "content", "parent_comment_id", "edited_at"], ownerField: "author_id", verifiedRead: true },
  reactions: { delegate: "reaction", read: ["id", "entity_id", "user_id", "entity_type", "emoji", "created_at"], write: ["entity_id", "entity_type", "emoji"], ownerField: "user_id", verifiedRead: true },
  reports: { delegate: "report", read: ["id", "entity_id", "reporter_id", "entity_type", "reason", "status", "resolved_at", "resolved_by", "created_at"], write: ["entity_id", "entity_type", "reason"], ownerField: "reporter_id" },
  connections: { delegate: "connection", read: ["id", "requester_id", "receiver_id", "status", "note", "responded_at", "created_at", "updated_at"], write: [], verifiedRead: true },
  jobs: { delegate: "job", read: ["id", "created_by", "community_id", "title", "company", "company_logo_url", "location", "job_type", "category", "experience", "experience_level", "easy_apply", "description", "application_url", "apply_url", "source_url", "source_type", "status", "salary_min", "salary_max", "salary_currency", "salary_text", "skills", "source_fingerprint", "scan_run_id", "discovered_at", "last_seen_at", "expires_at", "published_at", "created_at", "updated_at"], write: ["created_by", "community_id", "title", "company", "company_logo_url", "location", "job_type", "category", "experience", "experience_level", "easy_apply", "description", "application_url", "apply_url", "source_url", "source_type", "status", "salary_min", "salary_max", "salary_currency", "salary_text", "skills", "source_fingerprint", "scan_run_id", "discovered_at", "last_seen_at", "expires_at", "published_at"], adminWrite: true },
  applications: { delegate: "application", read: ["id", "job_id", "applicant_id", "note", "resume_url", "status", "created_at", "updated_at"], write: ["job_id", "note", "resume_url"], ownerField: "applicant_id", verifiedRead: true },
  events: { delegate: "event", read: ["id", "title", "description", "location", "start_time", "end_time", "image_url", "registration_url", "organizer_name", "organizer", "source_iit", "audience_type", "audience_targets", "audience_mode", "target_iits", "target_courses", "target_specialisations", "source_url", "source_fingerprint", "scan_run_id", "source_type", "status", "community_id", "created_by", "published_at", "created_at", "updated_at"], write: ["title", "description", "location", "start_time", "end_time", "image_url", "registration_url", "organizer_name", "organizer", "source_iit", "audience_type", "audience_targets", "audience_mode", "target_iits", "target_courses", "target_specialisations", "source_url", "source_fingerprint", "scan_run_id", "source_type", "status", "community_id", "published_at"], adminWrite: true },
  rsvps: { delegate: "rsvp", read: ["id", "event_id", "user_id", "status", "created_at", "updated_at"], write: ["event_id", "status"], ownerField: "user_id", verifiedRead: true },
};

export const legacyTables = new Set([
  "academic_degrees", "academic_institutes", "academic_networks", "academic_specialisations", "ad_messages", "app_settings",
  "blog_bookmarks", "blog_comments", "blog_likes", "blogs", "call_participants", "call_sessions", "chat_members", "chat_rooms",
  "client_error_logs", "consultations", "course_verification_requests", "custom_options", "custom_skills", "document_verifications", "education",
  "email_provider_daily_usage", "event_scan_runs", "forum_deleted_for_user", "forum_room_state", "iit_recruiters", "job_engagement_events",
  "job_scan_runs", "job_scan_sources", "messages", "nav_config", "notifications", "onboarding_progress", "pending_profile_options", "pinned_messages",
  "poll_votes", "polls", "professional_experience", "realtime_channel_registry", "realtime_delivery_outbox", "saved_views", "stories",
  "user_activity_daily", "user_activity_sessions", "user_pinned_messages", "user_roles", "verification_audit_log", "verification_codes", "verifications",
  "verified_academic_affiliations",
]);

const legacyPublicRead = new Set(["academic_degrees", "academic_institutes", "academic_networks", "academic_specialisations", "app_settings", "custom_options", "custom_skills", "nav_config", "blogs", "blog_comments", "blog_likes", "polls", "poll_votes"]);
const legacyCommunityRead = new Set(["ad_messages"]);
const legacyAdminOnly = new Set(["client_error_logs", "email_provider_daily_usage", "event_scan_runs", "iit_recruiters", "job_scan_runs", "job_scan_sources", "realtime_channel_registry", "realtime_delivery_outbox", "user_activity_daily", "verification_audit_log"]);
const legacyUserOwned = new Set(["blog_bookmarks", "course_verification_requests", "document_verifications", "forum_deleted_for_user", "forum_room_state", "job_engagement_events", "notifications", "onboarding_progress", "pending_profile_options", "saved_views", "user_pinned_messages", "verifications"]);
const legacyRpcWriteOnly = new Set([
  "chat_members", "chat_rooms", "client_error_logs", "consultations", "email_provider_daily_usage", "event_scan_runs", "iit_recruiters",
  "job_engagement_events", "job_scan_runs", "pending_profile_options", "realtime_channel_registry", "realtime_delivery_outbox",
  "user_activity_daily", "user_activity_sessions", "user_roles", "verification_audit_log", "verification_codes", "verifications", "verified_academic_affiliations",
]);

const isAdmin = (ctx: RequestContext): boolean => ctx.auth.role === "admin" || ctx.auth.role === "owner";
const delegate = (name: string): any => (prisma as unknown as Record<string, any>)[name];
const verifiedLegacyTables = new Set([
  "messages", "chat_rooms", "chat_members", "call_sessions", "call_participants", "consultations",
  "stories", "polls", "poll_votes", "blog_comments", "blog_likes", "blog_bookmarks",
]);

export const legacyTableRequiresVerification = (table: string): boolean => verifiedLegacyTables.has(table);

export function blogIsPublic(row: Row, now = Date.now()): boolean {
  if (row.published !== true) return false;
  const status = typeof row.status === "string" ? row.status : "published";
  if (status === "draft" || (status !== "published" && status !== "scheduled")) return false;
  if (row.scheduled_at == null || row.scheduled_at === "") return status === "published";
  const scheduledAt = new Date(String(row.scheduled_at)).getTime();
  return Number.isFinite(scheduledAt) && scheduledAt <= now;
}

export function normalizeBlogPublishing(row: Row): Row {
  const next = { ...row };
  const status = typeof next.status === "string" ? next.status : next.published === true ? "published" : "draft";
  if (!new Set(["draft", "published", "scheduled"]).has(status)) {
    throw new ApiError(400, "invalid_blog_status", "Article status must be draft, published, or scheduled");
  }
  next.status = status;
  if (status === "scheduled") {
    const scheduledAt = new Date(String(next.scheduled_at ?? ""));
    if (Number.isNaN(scheduledAt.getTime())) throw new ApiError(400, "invalid_blog_schedule", "A scheduled article needs a valid publication time");
    next.scheduled_at = scheduledAt.toISOString();
    next.published = true;
  } else {
    next.scheduled_at = null;
    next.published = status === "published";
  }
  return next;
}

export function assertLegacyMutationAllowed(table: string, operation: SerializedQuery["operation"]): void {
  if (operation === "select") return;
  if (legacyRpcWriteOnly.has(table)) throw new ApiError(403, "rpc_required", `${table} can only be changed through its authorized server workflow`);
  if ((table === "document_verifications" || table === "course_verification_requests") && operation !== "insert") {
    throw new ApiError(403, "rpc_required", `${table} decisions and withdrawals require an authorized RPC`);
  }
  if (table === "notifications" && operation !== "update") throw new ApiError(403, "rpc_required", "Notifications can only be created or removed by an authorized server workflow");
  if (table === "call_sessions" && operation !== "update") throw new ApiError(403, "rpc_required", "Call sessions can only be created by the call provider workflow");
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as { toNumber?: unknown }).toNumber === "function") return (value as { toNumber(): number }).toNumber();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]));
  return value;
}

function assertColumns(policy: TablePolicy, query: SerializedQuery): void {
  for (const filter of query.filters) {
    if (filter.operator !== "or" && (!filter.column || !policy.read.includes(filter.column))) throw new ApiError(400, "column_not_allowed", `Column ${filter.column ?? "(missing)"} is not queryable`);
  }
  for (const order of query.order) if (!policy.read.includes(order.column)) throw new ApiError(400, "column_not_allowed", `Column ${order.column} is not sortable`);
}

const privateProfileQueryColumns = new Set(["iit_email", "date_of_birth", "phone_country_code", "phone_number", "phone_full"]);
const anonymousPostPrivateQueryColumns = new Set([
  "author_id",
  "deleted_by_user_id",
  "client_id",
  "image_url",
  "image_path",
  "media_url",
  "media_path",
  "media_metadata",
  "file_url",
  "file_path",
  "file_name",
  "voice_url",
  "voice_path",
]);

export function assertPrivateQuerySafety(query: Pick<SerializedQuery, "table" | "filters" | "order">, ctx: RequestContext): void {
  if (isAdmin(ctx)) return;
  const directlyEquals = (column: string, expected: unknown): boolean => query.filters.some((filter) => filter.operator === "eq" && filter.column === column && filter.value === expected);
  if (query.table === "profiles") {
    const referencesPrivate = query.order.some((order) => privateProfileQueryColumns.has(order.column))
      || query.filters.some((filter) => filter.operator !== "or" && !!filter.column && privateProfileQueryColumns.has(filter.column))
      || query.filters.some((filter) => filter.operator === "or" && parseOrExpression(filter.expression ?? String(filter.value ?? "")).some((node) => {
        const containsPrivate = (part: ParsedLogicNode): boolean => part.kind === "predicate" ? privateProfileQueryColumns.has(part.column) : part.children.some(containsPrivate);
        return containsPrivate(node);
      }));
    if (referencesPrivate && !directlyEquals("user_id", ctx.auth.id)) {
      throw new ApiError(403, "private_profile_query_denied", "Private profile fields can only be queried for your own profile");
    }
  }
  if (query.table === "posts") {
    const containsAnonymousPrivateField = (part: ParsedLogicNode): boolean => part.kind === "predicate"
      ? anonymousPostPrivateQueryColumns.has(part.column)
      : part.children.some(containsAnonymousPrivateField);
    const referencesAnonymousPrivate = query.order.some((order) => anonymousPostPrivateQueryColumns.has(order.column))
      || query.filters.some((filter) => filter.operator !== "or" && !!filter.column && anonymousPostPrivateQueryColumns.has(filter.column))
      || query.filters.some((filter) => filter.operator === "or"
        && parseOrExpression(filter.expression ?? String(filter.value ?? "")).some(containsAnonymousPrivateField));
    const explicitlyPublic = directlyEquals("is_anonymous", false) || directlyEquals("is_anonymous", "false");
    const ownAuthor = directlyEquals("author_id", ctx.auth.id);
    if (referencesAnonymousPrivate && !explicitlyPublic && !ownAuthor) {
      throw new ApiError(403, "anonymous_author_query_denied", "Anonymous author identity-bearing fields cannot be filtered or ordered");
    }
  }
}

export function assertProfilePatch(patch: Row, current: Row | undefined, ctx: RequestContext): void {
  if (isAdmin(ctx)) return;
  if (current?.is_verified === true && ((patch.iit_name !== undefined && patch.iit_name !== current.iit_name)
    || (patch.student_status !== undefined && patch.student_status !== current.student_status))) {
    throw new ApiError(403, "verified_identity_immutable", "Verified institute and member-status identity cannot be changed from profile editing");
  }
  if (patch.onboarding_completed === true && (current?.is_verified !== true || !current.phone_number)) {
    throw new ApiError(403, "onboarding_requirements_missing", "Verification and a saved phone are required before completing onboarding");
  }
}

async function catalogOptions(client: any = prisma): Promise<CatalogOption[]> {
  const records = await client.legacyRecord.findMany({ where: { table_name: "custom_options" }, take: 5000 });
  return (records as Array<{ owner_id: string | null; data: Prisma.JsonValue }>).flatMap((record) => {
    const row = record.data as Row;
    return typeof row.id === "string" && typeof row.category === "string" && typeof row.value === "string"
      && new Set(["pending", "approved", "rejected"]).has(String(row.status))
      ? [{ id: row.id, category: row.category, value: row.value, status: row.status as CatalogOption["status"], owner_id: record.owner_id }]
      : [];
  });
}

const moderatedProfileTable = (table: string): table is ModeratedProfileTable => table === "education" || table === "professional_experience";

async function prepareModeratedProfileRow(table: ModeratedProfileTable, row: Row, actorId: string, client: any = prisma): Promise<Row> {
  validateModeratedProfileEntry(table, row);
  return applyProfileEntryModeration(table, row, await catalogOptions(client), actorId);
}

export function buildFilter(filters: SerializedFilter[], allowed: readonly string[]): Row {
  const terms: Row[] = [];
  const logicWhere = (node: ParsedLogicNode): Row => {
    if (node.kind === "and" || node.kind === "or") return { [node.kind === "and" ? "AND" : "OR"]: node.children.map(logicWhere) };
    if (!allowed.includes(node.column)) throw new ApiError(400, "column_not_allowed", `Column ${node.column} is not queryable`);
    const expression: unknown = (() => {
      switch (node.operator) {
        case "eq": return node.value;
        case "neq": return { not: node.value };
        case "gt": return { gt: node.value };
        case "gte": return { gte: node.value };
        case "lt": return { lt: node.value };
        case "lte": return { lte: node.value };
        case "in": return { in: node.value };
        case "is": return node.value;
        case "like":
        case "ilike": return { contains: String(node.value ?? "").replace(/^%|%$/g, "") };
      }
    })();
    return { [node.column]: expression };
  };
  for (const filter of filters) {
    if (filter.operator === "or") {
      const expression = filter.expression ?? String(filter.value ?? "");
      terms.push({ OR: parseOrExpression(expression).map(logicWhere) });
      continue;
    }
    if (!filter.column) throw new ApiError(400, "invalid_filter", "Filter column is required");
    const value = filter.value;
    const expression: unknown = (() => {
      switch (filter.operator) {
        case "eq": return value;
        case "neq": return { not: value };
        case "gt": return { gt: value };
        case "gte": return { gte: value };
        case "lt": return { lt: value };
        case "lte": return { lte: value };
        case "in": return { in: parseInValue(value) };
        case "is": return value;
        case "like":
        case "ilike": return { contains: String(value ?? "").replace(/^%|%$/g, "") };
        case "contains": return { array_contains: value };
        case "containedBy": throw new ApiError(400, "operator_not_supported", "Contained-by queries require a typed endpoint on MySQL");
        case "textSearch": return { contains: String(value ?? "") };
        case "overlaps": throw new ApiError(400, "operator_not_supported", "Array overlap queries require a typed endpoint on MySQL");
        case "not": {
          const nested = filter.options?.operator;
          if (nested === "in") return { notIn: parseInValue(value) };
          if (nested === "eq") return { not: value };
          throw new ApiError(400, "operator_not_supported", "Unsupported NOT filter");
        }
      }
    })();
    terms.push({ [filter.column]: expression });
  }
  return terms.length ? { AND: terms } : {};
}

async function baseWhere(table: string, ctx: RequestContext): Promise<Row> {
  if (isAdmin(ctx)) return {};
  const scopeWhere = async (): Promise<Row[]> => (await allowedForumScopes(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role)).map((scope) => ({ scope_type: scope.scope_type, scope_key: scope.scope_key }));
  switch (table) {
    case "profiles": return { OR: [{ user_id: ctx.auth.id }, { community_id: ctx.auth.community_id, is_verified: true }] };
    case "posts": return { deleted_at: null, OR: [...await scopeWhere(), { author_id: ctx.auth.id }] };
    case "comments": return { post: { OR: [...await scopeWhere(), { author_id: ctx.auth.id }] } };
    case "reactions": {
      const visiblePosts = await prisma.post.findMany({ where: { OR: [...await scopeWhere(), { author_id: ctx.auth.id }] }, select: { id: true }, take: 5000 });
      return { entity_type: { in: ["post", "forum_msg"] }, entity_id: { in: visiblePosts.map((post) => post.id) } };
    }
    case "reports": return { reporter_id: ctx.auth.id };
    case "connections": return { OR: [{ requester_id: ctx.auth.id }, { receiver_id: ctx.auth.id }] };
    case "applications": return { applicant_id: ctx.auth.id };
    case "jobs": return { community_id: ctx.auth.community_id, status: "published", OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] };
    case "events": return { id: { in: await visibleEventIds(ctx) } };
    case "rsvps": return { user_id: ctx.auth.id };
    default: return {};
  }
}

function cleanWrite(policy: TablePolicy, values: unknown, ctx: RequestContext, table: string, operation: "insert" | "update" | "upsert"): Row[] {
  const list = Array.isArray(values) ? values : [values];
  if (!list.length || list.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new ApiError(400, "invalid_values", "Values must be an object or object array");
  return list.map((item) => {
    const source = item as Row;
    const accepted = new Set([
      ...policy.write, "id", "created_at", "updated_at", ...(policy.ownerField ? [policy.ownerField] : []),
      ...(["jobs", "events"].includes(table) ? ["created_by", "community_id"] : []),
    ]);
    const unknown = Object.keys(source).filter((key) => !accepted.has(key));
    if (unknown.length) throw new ApiError(400, "column_not_writable", `Unsupported write columns: ${unknown.join(", ")}`);
    const result: Row = {};
    for (const key of policy.write) if (key in source) result[key] = source[key];
    if (table === "profiles" && Object.prototype.hasOwnProperty.call(source, "date_of_birth")) result.date_of_birth = normalizeDateOfBirth(source.date_of_birth);
    if (table === "profiles" && Object.prototype.hasOwnProperty.call(source, "social_links")) result.social_links = normalizeSocialLinks(source.social_links);
    const externalFields = table === "jobs"
      ? ["company_logo_url", "application_url", "apply_url", "source_url"]
      : table === "events" ? ["image_url", "registration_url", "source_url"]
        : table === "posts" ? ["image_url", "media_url", "file_url", "voice_url"] : [];
    for (const field of externalFields) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
      result[field] = source[field] == null || source[field] === "" ? null : normalizeHttpUrl(source[field], field);
    }
    if (source.id && typeof source.id === "string") result.id = source.id;
    if (policy.ownerField && operation !== "update") result[policy.ownerField] = ctx.auth.id;
    if (table === "posts") {
      result.community_id = ctx.auth.community_id;
      if (operation !== "insert") {
        const mutable = new Set(["content", "edited_at", "is_deleted_for_everyone", ...(isAdmin(ctx) ? ["pinned_at"] : [])]);
        for (const key of Object.keys(result)) if (!mutable.has(key) && key !== "author_id") delete result[key];
        if (source.pinned_at !== undefined && !isAdmin(ctx)) throw new ApiError(403, "admin_required", "Only an administrator can pin a forum post");
      } else if (!isAdmin(ctx)) {
        delete result.pinned_at;
      }
    }
    if (table === "jobs" || table === "events") {
      if (operation === "update") {
        delete result.created_by;
        delete result.community_id;
      } else {
        result.created_by = ctx.auth.id;
        result.community_id = ctx.auth.community_id;
      }
    }
    return result;
  });
}

function normalizeLegacyExternalUrls(table: string, row: Row): void {
  const fields = table === "ad_messages" ? ["link_url"]
    : table === "job_scan_sources" ? ["source_url"]
      : table === "nav_config" ? ["icon_url"]
        : table === "blogs" ? ["cover_image_url"] : [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    row[field] = row[field] == null || row[field] === "" ? null : normalizeHttpUrl(row[field], field);
  }
}

async function visiblePost(postId: unknown, ctx: RequestContext): Promise<{ id: string; author_id: string | null; scope_type: string; scope_key: string; reply_to_id: string | null }> {
  if (typeof postId !== "string" || !postId) throw new ApiError(400, "post_required", "A valid post ID is required");
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, author_id: true, scope_type: true, scope_key: true, reply_to_id: true, deleted_at: true, is_deleted_for_everyone: true } });
  if (!post || post.deleted_at || post.is_deleted_for_everyone || (post.author_id !== ctx.auth.id && !(await canUseForumScope(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role, post.scope_type, post.scope_key)))) {
    throw new ApiError(404, "post_not_found", "The post is unavailable");
  }
  return post;
}

export function assertPostReferenceScope(
  source: Row,
  target: Row,
  kind: "reply" | "reshare",
): void {
  if (target.reply_to_id || target.scope_type !== source.scope_type || target.scope_key !== source.scope_key) {
    throw new ApiError(
      400,
      kind === "reply" ? "invalid_reply_target" : "invalid_reshare_target",
      `${kind === "reply" ? "Reply" : "Reshare"} target must be a visible top-level post in the same forum scope`,
    );
  }
}

export function assertCommentParent(
  postId: unknown,
  parent: { post_id: string; parent_comment_id: string | null } | null,
): void {
  if (!parent || typeof postId !== "string" || !postId || parent.post_id !== postId || parent.parent_comment_id) {
    throw new ApiError(400, "invalid_parent_comment", "Replies must target a top-level comment on the same post");
  }
}

export function commentTombstonePatch(now = new Date()): { content: string; author_id: null; edited_at: Date } {
  return { content: "", author_id: null, edited_at: now };
}

export function pollVoteRecordKey(pollId: string, userId: string): string {
  return `poll-vote:${sha256(`${pollId}\n${userId}`).slice(0, 64)}`;
}

export function pollRecordKey(postId: string): string {
  return `poll:${sha256(postId).slice(0, 64)}`;
}

export function validatePollOption(poll: Row, value: unknown): number {
  const options = Array.isArray(poll.options) ? poll.options : [];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= options.length) {
    throw new ApiError(400, "invalid_poll_option", "The selected poll option is invalid");
  }
  return value;
}

export function validatePollPayload(row: Row): void {
  const allowed = new Set(["id", "post_id", "created_by", "question", "options", "created_at", "updated_at"]);
  const unknown = Object.keys(row).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ApiError(400, "column_not_writable", `Unsupported poll columns: ${unknown.join(", ")}`);
  if (typeof row.question !== "string" || !row.question.trim() || row.question.trim().length > 500) {
    throw new ApiError(400, "invalid_poll", "A poll question is required");
  }
  if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 20
    || row.options.some((option) => typeof option !== "string" || !option.trim() || option.trim().length > 200)) {
    throw new ApiError(400, "invalid_poll", "A poll needs between 2 and 20 valid options");
  }
}

export function assertPollVotePayload(row: Row): void {
  const allowed = new Set(["id", "poll_id", "user_id", "option_index", "created_at", "updated_at"]);
  const unknown = Object.keys(row).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ApiError(400, "column_not_writable", `Unsupported poll-vote columns: ${unknown.join(", ")}`);
}

async function visiblePoll(pollId: unknown, ctx: RequestContext): Promise<Row> {
  if (typeof pollId !== "string" || !pollId) throw new ApiError(400, "poll_required", "A valid poll ID is required");
  const records = await prisma.legacyRecord.findMany({ where: {
    table_name: "polls",
    data: { path: "$.id", equals: pollId },
  }, take: 2 });
  if (records.length > 1) throw new ApiError(409, "poll_identity_conflict", "The poll identity is ambiguous and requires administrator repair");
  const record = records[0];
  const poll = record?.data as Row | undefined;
  if (!poll || !Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 20) {
    throw new ApiError(404, "poll_not_found", "The poll is unavailable");
  }
  await visiblePost(poll.post_id, ctx);
  return poll;
}

type EventAudienceProfile = Pick<Profile, "user_id" | "is_verified" | "iit_name" | "primary_education_id">;
type EventAudienceRecord = Pick<Event, "id" | "status" | "audience_mode" | "target_iits" | "target_courses" | "target_specialisations">;

const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function eventVisibleToMember(event: EventAudienceRecord, profile: EventAudienceProfile | null, education: Row[], admin = false): boolean {
  if (admin) return true;
  if (event.status !== "published") return false;
  if (event.audience_mode === "everyone" || event.audience_mode == null) return true;
  if (event.audience_mode !== "targeted" || !profile?.is_verified) return false;
  const institutes = stringList(event.target_iits);
  if (institutes.length && (!profile.iit_name || !institutes.includes(profile.iit_name))) return false;
  const courses = stringList(event.target_courses);
  const specialisations = stringList(event.target_specialisations);
  if (!courses.length && !specialisations.length) return true;
  return education.some((item) => {
    if (profile.primary_education_id && item.id !== profile.primary_education_id) return false;
    return (!courses.length || courses.includes(String(item.degree ?? "")))
      && (!specialisations.length || specialisations.includes(String(item.branch_area ?? "")));
  });
}

async function eventAudienceContext(ctx: RequestContext): Promise<{ profile: EventAudienceProfile | null; education: Row[] }> {
  const [profile, records] = await Promise.all([
    prisma.profile.findUnique({ where: { user_id: ctx.auth.id }, select: { user_id: true, is_verified: true, iit_name: true, primary_education_id: true } }),
    prisma.legacyRecord.findMany({ where: { table_name: "education", owner_id: ctx.auth.id }, take: 500 }),
  ]);
  return { profile, education: records.map((record) => record.data as Row) };
}

async function visibleEventIds(ctx: RequestContext): Promise<string[]> {
  if (isAdmin(ctx)) return (await prisma.event.findMany({ select: { id: true } })).map((event) => event.id);
  const [events, audience] = await Promise.all([
    prisma.event.findMany({ select: { id: true, status: true, audience_mode: true, target_iits: true, target_courses: true, target_specialisations: true } }),
    eventAudienceContext(ctx),
  ]);
  return events.filter((event) => eventVisibleToMember(event, audience.profile, audience.education)).map((event) => event.id);
}

async function validateCoreWrite(table: string, value: Row, ctx: RequestContext): Promise<void> {
  if (table === "profiles" && value.primary_education_id != null && !isAdmin(ctx)) {
    if (typeof value.primary_education_id !== "string" || !value.primary_education_id) throw new ApiError(400, "invalid_primary_education", "Primary education is invalid");
    const education = await prisma.legacyRecord.findFirst({ where: {
      table_name: "education", owner_id: ctx.auth.id,
      data: { path: "$.id", equals: value.primary_education_id },
    } });
    const row = education?.data as Row | undefined;
    if (!row || (row.approval_status !== "approved" && row.approval_status != null)) {
      throw new ApiError(400, "invalid_primary_education", "Primary education must be an approved profile entry owned by you");
    }
  }
  if (table === "posts") {
    if (value.id != null) {
      if (typeof value.id !== "string" || !isCanonicalRealtimeRecordId(value.id.toLowerCase())) {
        throw new ApiError(400, "invalid_post_id", "Forum post IDs must use canonical UUID format");
      }
      value.id = value.id.toLowerCase();
    }
    if (!value.scope_type || !value.scope_key) {
      const global = (await allowedForumScopes(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role)).find((scope) => scope.scope_type === "GLOBAL");
      value.scope_type = global?.scope_type ?? "GLOBAL";
      value.scope_key = global?.scope_key ?? "IIT_ALL";
    }
    if (!(await canUseForumScope(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role, String(value.scope_type), String(value.scope_key)))) {
      throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
    }
    if (value.reply_to_id) assertPostReferenceScope(value, await visiblePost(value.reply_to_id, ctx), "reply");
    if (value.reshared_post_id) assertPostReferenceScope(value, await visiblePost(value.reshared_post_id, ctx), "reshare");
    for (const [field, bucket] of [["image_path", "post-images"], ["media_path", "post-images"], ["file_path", "forum-files"], ["voice_path", "voice-notes"]] as const) {
      if (value[field] != null && value[field] !== "") value[field] = await assertOwnedReadyObject(bucket, value[field], ctx.auth.id);
    }
  }
  if (table === "comments") {
    await visiblePost(value.post_id, ctx);
    if (value.parent_comment_id) {
      const parent = await prisma.comment.findUnique({ where: { id: String(value.parent_comment_id) }, select: { post_id: true, parent_comment_id: true } });
      assertCommentParent(value.post_id, parent);
    }
  }
  if (table === "reactions" || table === "reports") {
    const entityType = String(value.entity_type ?? (table === "reactions" ? "post" : "forum_msg"));
    if (!new Set(["post", "forum_msg"]).has(entityType)) throw new ApiError(400, "unsupported_entity_type", "Only post reactions and reports are supported here");
    await visiblePost(value.entity_id, ctx);
  }
  if (table === "applications") {
    if (!ctx.auth.is_verified && !isAdmin(ctx)) throw new ApiError(403, "verification_required", "Verified membership is required to apply");
    const job = typeof value.job_id === "string" ? await prisma.job.findUnique({ where: { id: value.job_id } }) : null;
    if (!job || job.community_id !== ctx.auth.community_id || job.status !== "published" || (job.expires_at && job.expires_at <= new Date())) {
      throw new ApiError(404, "job_not_available", "This job is not available for applications");
    }
  }
  if (table === "rsvps") {
    const event = typeof value.event_id === "string" ? await prisma.event.findUnique({ where: { id: value.event_id } }) : null;
    const audience = await eventAudienceContext(ctx);
    if (!event || !eventVisibleToMember(event, audience.profile, audience.education, isAdmin(ctx))) throw new ApiError(404, "event_not_available", "This event is not available");
  }
}

const immutableCoreUpdateFields: Record<string, readonly string[]> = {
  posts: ["community_id", "scope_type", "scope_key", "reply_to_id", "reshared_post_id"],
  comments: ["post_id", "parent_comment_id"],
  reactions: ["entity_id", "entity_type"],
  reports: ["entity_id", "entity_type"],
  applications: ["job_id"],
  rsvps: ["event_id"],
};

export function assertCoreUpdateRelationsImmutable(table: string, patch: Row): void {
  const changed = (immutableCoreUpdateFields[table] ?? []).filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
  if (changed.length) {
    throw new ApiError(400, "relation_immutable", `${changed.join(", ")} cannot be changed after creation`);
  }
}

export function assertCoreUpsertRelationsUnchanged(table: string, value: Row, current: Row): void {
  const changed = (immutableCoreUpdateFields[table] ?? []).filter((field) =>
    Object.prototype.hasOwnProperty.call(value, field) && JSON.stringify(value[field]) !== JSON.stringify(current[field]));
  if (changed.length) {
    throw new ApiError(400, "relation_immutable", `${changed.join(", ")} cannot be changed after creation`);
  }
}

export function assertCoreDeleteAllowed(table: string, ctx: RequestContext): void {
  if (table === "posts" && !isAdmin(ctx)) {
    throw new ApiError(403, "post_delete_requires_tombstone", "Members must use the time-bounded delete-for-everyone or hide-for-me workflow");
  }
}

const coreConflictKeys: Record<string, string[][]> = {
  profiles: [["user_id"]],
  posts: [["author_id", "client_id"]],
  reactions: [["entity_type", "entity_id", "user_id", "emoji"]],
  applications: [["job_id", "applicant_id"]],
  rsvps: [["event_id", "user_id"]],
  jobs: [["source_fingerprint"]],
  events: [["source_fingerprint"]],
};

export function resolveConflictKeys(table: string, requested: string | undefined, allowed: string[][]): string[] {
  const keys = requested?.split(",").map((item) => item.trim()).filter(Boolean) ?? allowed[0];
  if (!keys || !allowed.some((candidate) => candidate.length === keys.length && candidate.every((key) => keys.includes(key)))) {
    throw new ApiError(400, "invalid_upsert_conflict", `Unsupported upsert conflict key for ${table}`);
  }
  return keys;
}

export function conflictIdentity(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

export function deriveVirtualUserRoles(users: Array<{ id: string; role: string }>): Row[] {
  return users.flatMap((user) => user.role === "owner"
    ? [{ user_id: user.id, role: "owner" }, { user_id: user.id, role: "admin" }]
    : [{ user_id: user.id, role: user.role }]);
}

function uniqueWhere(table: string, row: Row): Row {
  return table === "profiles" ? { user_id: row.user_id } : { id: row.id };
}

function guardedMutationWhere(table: string, row: Row, policy: TablePolicy, ctx: RequestContext): Row {
  const where = uniqueWhere(table, row);
  if (!isAdmin(ctx) && policy.ownerField) where[policy.ownerField] = ctx.auth.id;
  return where;
}

async function lockSecuritySensitiveCoreRow(client: any, table: string, row: Row): Promise<Row | null> {
  if (table === "profiles") await client.$queryRaw(Prisma.sql`SELECT user_id FROM profiles WHERE user_id = ${String(row.user_id)} LIMIT 1 FOR UPDATE`);
  else if (table === "posts") await client.$queryRaw(Prisma.sql`SELECT id FROM posts WHERE id = ${String(row.id)} LIMIT 1 FOR UPDATE`);
  else if (table === "comments") await client.$queryRaw(Prisma.sql`SELECT id FROM comments WHERE id = ${String(row.id)} LIMIT 1 FOR UPDATE`);
  else if (table === "reactions") await client.$queryRaw(Prisma.sql`SELECT id FROM reactions WHERE id = ${String(row.id)} LIMIT 1 FOR UPDATE`);
  else if (table === "reports") await client.$queryRaw(Prisma.sql`SELECT id FROM reports WHERE id = ${String(row.id)} LIMIT 1 FOR UPDATE`);
  else if (table === "applications") await client.$queryRaw(Prisma.sql`SELECT id FROM applications WHERE id = ${String(row.id)} LIMIT 1 FOR UPDATE`);
  else if (table === "rsvps") await client.$queryRaw(Prisma.sql`SELECT id FROM rsvps WHERE id = ${String(row.id)} LIMIT 1 FOR UPDATE`);
  else return row;
  const model = (client as Record<string, any>)[policies[table]!.delegate];
  return model.findUnique({ where: uniqueWhere(table, row) });
}

function assertFreshPostMutation(current: Row, patch: Row, ctx: RequestContext): void {
  if (patch.is_deleted_for_everyone === false && isDeletedForEveryone(current)) {
    throw new ApiError(409, "deleted_content_immutable", "A post deleted for everyone cannot be restored");
  }
  if (isDeletedForEveryone(current) && patch.is_deleted_for_everyone !== true) {
    throw new ApiError(409, "deleted_content_immutable", "A post deleted for everyone cannot be restored or edited");
  }
  if (patch.is_deleted_for_everyone === true && !isAdmin(ctx)
    && new Date(String(current.created_at)).getTime() < Date.now() - 3 * 60_000) {
    throw new ApiError(409, "delete_window_expired", "Cannot delete for everyone after 3 minutes");
  }
}

function privateMediaKeys(rows: Row[], kind: "post" | "message" | "story"): string[] {
  return [...new Set(rows.flatMap((row) => privateMediaObjectKeys(row, kind)))];
}

async function revokePrivateMedia(rows: Row[], kind: "post" | "message" | "story", client: any = prisma): Promise<void> {
  const objectKeys = privateMediaKeys(rows, kind);
  for (const objectKey of objectKeys) {
    const slash = objectKey.indexOf("/");
    const bucket = objectKey.slice(0, slash);
    const objectPath = objectKey.slice(slash + 1);
    const postWhere = bucket === "post-images"
      ? { OR: [{ image_path: objectPath }, { media_path: objectPath }], deleted_at: null, is_deleted_for_everyone: false }
      : bucket === "forum-files" ? { file_path: objectPath, deleted_at: null, is_deleted_for_everyone: false }
        : bucket === "voice-notes" ? { voice_path: objectPath, deleted_at: null, is_deleted_for_everyone: false } : undefined;
    const messageFields = bucket === "chat-media" ? ["media_path", "file_path", "image_path"]
      : bucket === "post-images" ? ["media_path"] : bucket === "voice-notes" ? ["voice_path"] : [];
    const [activePost, messageRecords] = await Promise.all([
      postWhere ? client.post.findFirst({ where: postWhere, select: { id: true } }) : Promise.resolve(null),
      messageFields.length ? client.legacyRecord.findMany({ where: {
        table_name: "messages",
        OR: messageFields.map((field) => ({ data: { path: `$.${field}`, equals: objectPath } })),
      }, take: 100 }) : Promise.resolve([]),
    ]);
    const activeMessage = (messageRecords as Array<{ data: Prisma.JsonValue }>).some((record) => {
      const message = record.data as Row;
      const correctBucket = bucket === "post-images" ? message.media_bucket === "post-images"
        : bucket === "chat-media" ? message.media_bucket !== "post-images" : true;
      return correctBucket && !isDeletedForEveryone(message);
    });
    const storyRecords = bucket === "stories" ? await client.legacyRecord.findMany({ where: {
      table_name: "stories",
      data: { path: "$.image_path", equals: objectPath },
    }, take: 20 }) : [];
    const storyStillVisible = (storyRecords as Array<{ data: Prisma.JsonValue }>).some((record) => {
      const story = record.data as Row;
      const expiry = new Date(String(story.expires_at ?? ""));
      return story.deleted_at == null && !Number.isNaN(expiry.getTime()) && expiry > new Date();
    });
    if (!activePost && !activeMessage && !storyStillVisible) await client.fileObject.updateMany({
      where: { object_key: objectKey, deleted_at: null },
      data: { status: "deleted", deleted_at: new Date() },
    });
  }
}

function secureOutput(table: string, row: Row, ctx: RequestContext, columns?: string | string[], mediaHandles?: Map<string, string>): Row {
  let copy = table === "posts" ? contentTombstone(row) : { ...row };
  if (table === "posts") copy = redactAnonymousPostForViewer(copy, ctx.auth.id, ctx.auth.role, mediaHandles);
  if (table === "profiles") copy.date_of_birth = dateOnly(copy.date_of_birth);
  if (table === "profiles" && copy.user_id !== ctx.auth.id && !isAdmin(ctx)) {
    delete copy.iit_email;
    delete copy.date_of_birth;
    delete copy.phone_country_code;
    delete copy.phone_number;
    delete copy.phone_full;
  }
  return projectColumns(copy, columns);
}

export function realtimeSafeCoreRow(table: string, row: Row, mediaHandles?: Map<string, string>): Row {
  const copy = table === "posts" ? contentTombstone(row) : { ...row };
  return table === "posts" ? redactAnonymousPostForViewer(copy, "", "member", mediaHandles) : copy;
}

export function queryReferencesDeletedContent(query: Pick<SerializedQuery, "filters" | "order">): boolean {
  const logicContainsPrivateField = (node: ParsedLogicNode): boolean => node.kind === "predicate"
    ? deletedContentFields.has(node.column)
    : node.children.some(logicContainsPrivateField);
  return query.order.some((order) => deletedContentFields.has(order.column)) || query.filters.some((filter) => filter.operator === "or"
    ? parseOrExpression(filter.expression ?? String(filter.value ?? "")).some(logicContainsPrivateField)
    : !!filter.column && deletedContentFields.has(filter.column));
}

async function executeCore(query: SerializedQuery, ctx: RequestContext): Promise<{ data: unknown; count?: number }> {
  const policy = policies[query.table]!;
  assertColumns(policy, query);
  assertPrivateQuerySafety(query, ctx);
  if (policy.verifiedRead && !ctx.auth.is_verified && !isAdmin(ctx)) throw new ApiError(403, "verification_required", "Verified membership is required");
  const model = delegate(policy.delegate);
  const security = await baseWhere(query.table, ctx);
  const requested = buildFilter(query.filters, policy.read);
  const deletedContentGuard = query.table === "posts" && queryReferencesDeletedContent(query) ? { is_deleted_for_everyone: false, deleted_at: null } : {};
  const whereTerms = [security, requested, deletedContentGuard].filter((term) => Object.keys(term).length);
  const where = whereTerms.length > 1 ? { AND: whereTerms } : whereTerms[0] ?? {};

  if (query.operation === "select") {
    const from = query.range?.from ?? 0;
    const take = query.range ? Math.min(query.range.to - from + 1, 500) : Math.min(query.limit ?? 100, 500);
    const [rows, count] = await Promise.all([
      query.options?.head ? Promise.resolve([]) : model.findMany({ where, skip: from, take, orderBy: query.order.map((item) => ({ [item.column]: item.ascending ? "asc" : "desc" })) }),
      query.options?.count ? model.count({ where }) : Promise.resolve(undefined),
    ]);
    const serializedRows = serialize(rows) as Row[];
    const mediaHandles = query.table === "posts" ? await forumPostMediaHandles(serializedRows as any) : undefined;
    const result = serializedRows.map((row) => secureOutput(query.table, row, ctx, query.columns, mediaHandles));
    return { data: applyCardinality(result, query.cardinality), ...(count === undefined ? {} : { count }) };
  }

  if (policy.adminWrite && !isAdmin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required");
  if (!policy.adminWrite && !policy.write.length) throw new ApiError(403, "write_not_allowed", `Use an RPC to mutate ${query.table}`);

  if (query.operation === "upsert") {
    const allowed = coreConflictKeys[query.table];
    if (!allowed) throw new ApiError(400, "upsert_not_supported", `Upsert is not supported for ${query.table}`);
    const values = cleanWrite(policy, query.values, ctx, query.table, "upsert");
    for (const value of values) await validateCoreWrite(query.table, value, ctx);
    const keys = resolveConflictKeys(query.table, query.options?.onConflict, allowed);
    const output: Row[] = [];
    for (const value of values) {
      if (keys.some((key) => value[key] === undefined || value[key] === null || value[key] === "")) throw new ApiError(400, "missing_conflict_value", `Upsert requires ${keys.join(", ")}`);
      const conflict = conflictIdentity(value, keys);
      const secured = Object.keys(security).length ? { AND: [security, conflict] } : conflict;
      const existing = await model.findFirst({ where: secured });
      let saved: Row;
      if (existing) {
        assertCoreUpsertRelationsUnchanged(query.table, value, existing as Row);
        if (query.table === "profiles") assertProfilePatch(value, existing as Row, ctx);
        const patch = { ...value }; delete patch.id;
        if (query.table === "jobs" || query.table === "events") {
          delete patch.created_by;
          delete patch.community_id;
        }
        if (query.table === "posts") {
          saved = await prisma.$transaction(async (tx) => {
            const fresh = await lockSecuritySensitiveCoreRow(tx, query.table, existing as Row);
            if (!fresh || (!isAdmin(ctx) && fresh.author_id !== ctx.auth.id)) throw new ApiError(409, "record_changed", "The post changed while this request was being processed");
            assertFreshPostMutation(fresh, patch, ctx);
            const updated = await tx.post.update({ where: guardedMutationWhere(query.table, fresh, policy, ctx) as any, data: patch as any });
            if (value.is_deleted_for_everyone === true) await revokePrivateMedia([fresh], "post", tx);
            return updated;
          });
        } else if (query.table === "profiles") {
          saved = await prisma.$transaction(async (tx) => {
            const fresh = await lockSecuritySensitiveCoreRow(tx, query.table, existing as Row);
            if (!fresh || (!isAdmin(ctx) && fresh.user_id !== ctx.auth.id)) throw new ApiError(409, "record_changed", "The profile changed while this request was being processed");
            assertProfilePatch(patch, fresh, ctx);
            return tx.profile.update({ where: { user_id: String(fresh.user_id) }, data: patch as any });
          }) as unknown as Row;
        } else saved = await model.update({ where: guardedMutationWhere(query.table, existing as Row, policy, ctx), data: patch });
      } else {
        if (query.table === "profiles") assertProfilePatch(value, undefined, ctx);
        saved = query.table === "posts"
          ? (await createForumPostsWithSlowMode([value as Prisma.PostUncheckedCreateInput], ctx.auth))[0] as unknown as Row
          : await model.create({ data: value });
      }
      const savedRow = serialize(saved) as Row;
      const mediaHandles = query.table === "posts" ? await forumPostMediaHandles([savedRow as any]) : undefined;
      const row = secureOutput(query.table, savedRow, ctx, query.columns, mediaHandles);
      output.push(row);
      emitDbChange({ table: query.table, event: existing ? "UPDATE" : "INSERT", row: realtimeSafeCoreRow(query.table, savedRow, mediaHandles), actor_id: ctx.auth.id });
    }
    return { data: applyCardinality(output, query.cardinality) };
  }

  if (query.operation === "insert") {
    const values = cleanWrite(policy, query.values, ctx, query.table, "insert");
    for (const value of values) await validateCoreWrite(query.table, value, ctx);
    let rows: unknown[];
    const notificationRows: Row[] = [];
    if (query.table === "applications") {
      const results = await Promise.all(values.map((data) => prisma.$transaction(async (tx) => {
          const application = await tx.application.create({ data: data as any });
          const job = await tx.job.findUnique({ where: { id: application.job_id } });
          let notification: Row | undefined;
          if (job?.created_by && job.created_by !== ctx.auth.id) {
            const notificationId = newId();
            notification = { id: notificationId, user_id: job.created_by, title: "New job application", message: `A member applied for ${job.title}.`, type: "job_application", link: "/jobs", is_read: false, created_at: new Date().toISOString() };
            await tx.legacyRecord.create({ data: {
              table_name: "notifications", record_id: `application:${application.id}`, owner_id: job.created_by,
              community_id: ctx.auth.community_id,
              data: notification as Prisma.InputJsonValue,
            } });
          }
          return { application, notification };
        })));
      rows = results.map((result) => result.application);
      notificationRows.push(...results.flatMap((result) => result.notification ? [result.notification] : []));
    } else if (query.table === "posts") {
      rows = await createForumPostsWithSlowMode(values as Prisma.PostUncheckedCreateInput[], ctx.auth);
    } else {
      rows = await prisma.$transaction(values.map((data) => model.create({ data })));
    }
    const serializedRows = serialize(rows) as Row[];
    const mediaHandles = query.table === "posts" ? await forumPostMediaHandles(serializedRows as any) : undefined;
    const output = serializedRows.map((row) => secureOutput(query.table, row, ctx, query.columns, mediaHandles));
    serializedRows.forEach((row) => emitDbChange({ table: query.table, event: "INSERT", row: realtimeSafeCoreRow(query.table, row, mediaHandles), actor_id: ctx.auth.id }));
    notificationRows.forEach((row) => emitDbChange({ table: "notifications", event: "INSERT", row, actor_id: ctx.auth.id, audience_ids: [String(row.user_id)] }));
    return { data: applyCardinality(output, query.cardinality) };
  }

  const matches = await model.findMany({ where, take: 501 });
  if (matches.length > 500) throw new ApiError(413, "mutation_too_broad", "Mutation targets more than 500 rows");
  if (!isAdmin(ctx) && policy.ownerField && matches.some((row: Row) => row[policy.ownerField!] !== ctx.auth.id)) throw new ApiError(403, "ownership_required", "You do not own every selected row");
  if (!matches.length) return { data: applyCardinality([], query.cardinality) };

  if (query.operation === "delete") {
    assertCoreDeleteAllowed(query.table, ctx);
    if (query.table === "posts") {
      const deletedAt = new Date();
      const saved = await prisma.$transaction(async (tx) => {
        const rows = await Promise.all(matches.map((row: Row) => tx.post.update({
          where: { id: String(row.id) },
          data: {
            content: "", tags: Prisma.DbNull, campus_filter: null, degree_filter: null, branch_filter: null,
            batch_filter: null, cohort_filter: null, student_status_filter: null,
            image_url: null, image_path: null, media_url: null, media_type: null, media_path: null,
            media_metadata: Prisma.DbNull, file_url: null, file_path: null, file_name: null, file_type: null,
            file_size: null, voice_url: null, voice_path: null, voice_duration: null,
            is_deleted_for_everyone: true, deleted_by_user_id: ctx.auth.id, deleted_at: deletedAt,
          },
        })));
        await revokePrivateMedia(matches as Row[], "post", tx);
        return rows;
      });
      const serialized = serialize(saved) as Row[];
      const output = serialized.map((row) => secureOutput(query.table, contentTombstone(row, true), ctx, query.columns));
      serialized.forEach((row) => emitDbChange({
        table: query.table, event: "UPDATE", row: realtimeSafeCoreRow(query.table, contentTombstone(row, true)), actor_id: ctx.auth.id,
      }));
      return { data: applyCardinality(output, query.cardinality) };
    }
    if (query.table === "comments") {
      const patch = commentTombstonePatch();
      const saved = await prisma.$transaction(async (tx) => Promise.all(matches.map((row: Row) => tx.comment.update({
        where: { id: String(row.id) },
        data: patch,
      }))));
      const output = (serialize(saved) as Row[]).map((row) => secureOutput(query.table, row, ctx, query.columns));
      (serialize(saved) as Row[]).forEach((row) => emitDbChange({
        table: query.table, event: "UPDATE", row: realtimeSafeCoreRow(query.table, row), actor_id: ctx.auth.id,
      }));
      return { data: applyCardinality(output, query.cardinality) };
    }
    await prisma.$transaction(async (tx) => {
      const transactionModel = (tx as unknown as Record<string, any>)[policy.delegate];
      await Promise.all(matches.map((row: Row) => transactionModel.delete({ where: { id: row.id } })));
    });
    const output = (serialize(matches) as Row[]).map((row) => secureOutput(query.table, row, ctx, query.columns));
    (serialize(matches) as Row[]).forEach((row) => emitDbChange({ table: query.table, event: "DELETE", row: realtimeSafeCoreRow(query.table, row), actor_id: ctx.auth.id }));
    return { data: applyCardinality(output, query.cardinality) };
  }

  if (query.table === "profiles" && query.values && typeof query.values === "object" && !Array.isArray(query.values) && !isAdmin(ctx)) {
    const patch = query.values as Row;
    for (const current of matches as Row[]) assertProfilePatch(patch, current, ctx);
  }

  if (query.table === "posts") {
    const postPatch = query.values as Row | undefined;
    if (postPatch?.is_deleted_for_everyone === false && matches.some((row: Row) => isDeletedForEveryone(row))) {
      throw new ApiError(409, "deleted_content_immutable", "A post deleted for everyone cannot be restored");
    }
    if (postPatch?.is_deleted_for_everyone === true && !isAdmin(ctx)) {
      const deadline = Date.now() - 3 * 60_000;
      if (matches.some((row: Row) => new Date(String(row.created_at)).getTime() < deadline)) throw new ApiError(409, "delete_window_expired", "Cannot delete for everyone after 3 minutes");
    }
  }
  const update = cleanWrite(policy, query.values, ctx, query.table, "update")[0]!;
  delete update.id;
  assertCoreUpdateRelationsImmutable(query.table, update);
  if (query.table === "posts") {
    for (const [field, bucket] of [["image_path", "post-images"], ["media_path", "post-images"], ["file_path", "forum-files"], ["voice_path", "voice-notes"]] as const) {
      if (Object.prototype.hasOwnProperty.call(update, field) && update[field] != null && update[field] !== "") {
        update[field] = await assertOwnedReadyObject(bucket, update[field], ctx.auth.id);
      }
    }
  }
  if (query.table === "profiles") await validateCoreWrite(query.table, update, ctx);
  const rows = await prisma.$transaction(async (tx) => {
    const transactionModel = (tx as unknown as Record<string, any>)[policy.delegate];
    const updated: Row[] = [];
    const freshRows: Row[] = [];
    const ordered = [...matches as Row[]].sort((left, right) => String(uniqueWhere(query.table, left).id ?? uniqueWhere(query.table, left).user_id)
      .localeCompare(String(uniqueWhere(query.table, right).id ?? uniqueWhere(query.table, right).user_id)));
    for (const row of ordered) {
      const fresh = await lockSecuritySensitiveCoreRow(tx, query.table, row) ?? row;
      if (!isAdmin(ctx) && policy.ownerField && fresh[policy.ownerField] !== ctx.auth.id) {
        throw new ApiError(409, "record_changed", "The record changed while this request was being processed");
      }
      if (query.table === "profiles") assertProfilePatch(update, fresh, ctx);
      if (query.table === "posts") assertFreshPostMutation(fresh, update, ctx);
      freshRows.push(fresh);
      updated.push(await transactionModel.update({ where: guardedMutationWhere(query.table, fresh, policy, ctx), data: update }));
    }
    if (query.table === "posts" && (query.values as Row | undefined)?.is_deleted_for_everyone === true) {
      await revokePrivateMedia(freshRows, "post", tx);
    }
    return updated;
  });
  const serializedRows = serialize(rows) as Row[];
  const mediaHandles = query.table === "posts" ? await forumPostMediaHandles(serializedRows as any) : undefined;
  const output = serializedRows.map((row) => secureOutput(query.table, row, ctx, query.columns, mediaHandles));
  serializedRows.forEach((row) => emitDbChange({ table: query.table, event: "UPDATE", row: realtimeSafeCoreRow(query.table, row, mediaHandles), actor_id: ctx.auth.id }));
  return { data: applyCardinality(output, query.cardinality) };
}

function legacyOwner(table: string, row: Row, ctx: RequestContext): string | undefined {
  const candidates: Record<string, string[]> = {
    messages: ["sender_id"], chat_members: ["user_id"], call_participants: ["user_id"], consultations: ["client_id"],
    blog_comments: ["author_id"], blog_bookmarks: ["user_id"], blog_likes: ["user_id"], course_verification_requests: ["user_id"],
    document_verifications: ["user_id"], education: ["user_id"], forum_deleted_for_user: ["user_id"], forum_room_state: ["user_id"],
    job_engagement_events: ["user_id"], notifications: ["user_id"], onboarding_progress: ["user_id"], pending_profile_options: ["user_id"],
    professional_experience: ["user_id"], saved_views: ["user_id"], stories: ["user_id", "author_id"], user_pinned_messages: ["user_id"],
    user_roles: ["user_id"], verifications: ["user_id"], verified_academic_affiliations: ["user_id"], polls: ["created_by"], poll_votes: ["user_id"],
  };
  for (const field of candidates[table] ?? []) if (typeof row[field] === "string") return row[field] as string;
  return legacyUserOwned.has(table) ? ctx.auth.id : undefined;
}

async function isChatMember(userId: string, roomId: unknown): Promise<boolean> {
  if (typeof roomId !== "string") return false;
  return !!await prisma.legacyRecord.findFirst({ where: {
    table_name: "chat_members",
    owner_id: userId,
    data: { path: "$.room_id", equals: roomId },
  }, select: { id: true } });
}

export function normalizeNewMessageShape(raw: Row, actorId: string, now = new Date()): Row {
  const roomId = typeof raw.room_id === "string" ? raw.room_id.trim() : "";
  if (!roomId || roomId.length > 100) throw new ApiError(400, "invalid_chat_room", "A valid chat room is required");
  const messageType = raw.message_type === undefined ? "text" : raw.message_type;
  if (messageType !== "text" && messageType !== "image" && messageType !== "voice") {
    throw new ApiError(400, "invalid_message_type", "Message type must be text, image, or voice");
  }
  const clientId = raw.client_id === undefined ? newId() : raw.client_id;
  if (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) {
    throw new ApiError(400, "invalid_client_message_id", "Message identifier is invalid");
  }
  const mediaPath = raw.media_path == null || raw.media_path === "" ? null : raw.media_path;
  if (mediaPath !== null && typeof mediaPath !== "string") throw new ApiError(400, "invalid_media_path", "Message media path is invalid");
  if (messageType !== "text" && !mediaPath) throw new ApiError(400, "message_media_required", "Image and voice messages require an uploaded file");
  if (messageType === "text" && mediaPath) throw new ApiError(400, "unexpected_message_media", "Text messages cannot include an attachment");
  const contentInput = typeof raw.content === "string" ? raw.content.trim() : "";
  if (messageType === "text" && !contentInput) throw new ApiError(400, "message_content_required", "Message text is required");
  if (contentInput.length > 10_000) throw new ApiError(400, "message_too_long", "Message text is too long");
  const replyTo = raw.reply_to_message_id == null || raw.reply_to_message_id === "" ? null : raw.reply_to_message_id;
  if (replyTo !== null && (typeof replyTo !== "string" || replyTo.length > 100)) {
    throw new ApiError(400, "invalid_reply_message", "Reply message is invalid");
  }
  let voiceDuration: number | null = null;
  if (messageType === "voice") {
    voiceDuration = Number(raw.voice_duration);
    if (!Number.isInteger(voiceDuration) || voiceDuration < 1 || voiceDuration > 3_600) {
      throw new ApiError(400, "invalid_voice_duration", "Voice duration must be between 1 and 3600 seconds");
    }
  }
  const timestamp = now.toISOString();
  return {
    id: newId(),
    room_id: roomId,
    sender_id: actorId,
    client_id: clientId,
    content: messageType === "text" ? contentInput : messageType === "image" ? "Photo" : "Voice message",
    message_type: messageType,
    media_url: null,
    media_path: mediaPath,
    media_bucket: mediaPath ? "chat-media" : null,
    voice_duration: voiceDuration,
    reply_to_message_id: replyTo,
    status: "sent",
    read_by: [actorId],
    deleted_for_users: [],
    is_deleted_for_everyone: false,
    deleted_for_everyone: false,
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function normalizeNewBlogCommentShape(raw: Row, actorId: string, now = new Date()): Row {
  const blogId = typeof raw.blog_id === "string" ? raw.blog_id.trim() : "";
  if (!blogId || blogId.length > 100) throw new ApiError(400, "invalid_blog", "A valid article is required");
  const parentId = raw.parent_id == null || raw.parent_id === "" ? null : raw.parent_id;
  if (parentId !== null && (typeof parentId !== "string" || parentId.length > 100)) {
    throw new ApiError(400, "invalid_parent_comment", "Parent comment is invalid");
  }
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!content) throw new ApiError(400, "comment_content_required", "Comment text is required");
  if (content.length > 5_000) throw new ApiError(400, "comment_too_long", "Comment text is too long");
  const timestamp = now.toISOString();
  return {
    id: newId(), blog_id: blogId, parent_id: parentId, author_id: actorId,
    content, is_hidden: false, created_at: timestamp, updated_at: timestamp,
  };
}

export function normalizeBlogAffinityShape(table: "blog_likes" | "blog_bookmarks", raw: Row, actorId: string, now = new Date()): Row {
  const blogId = typeof raw.blog_id === "string" ? raw.blog_id.trim() : "";
  if (!blogId || blogId.length > 100) throw new ApiError(400, "invalid_blog", "A valid article is required");
  return {
    id: newId(),
    blog_id: blogId,
    user_id: actorId,
    created_at: now.toISOString(),
    ...(table === "blog_bookmarks" ? { updated_at: now.toISOString() } : {}),
  };
}

async function assertBlogInteractionAvailable(blogId: unknown, ctx: RequestContext): Promise<void> {
  const record = typeof blogId === "string" ? await prisma.legacyRecord.findFirst({ where: {
    table_name: "blogs", data: { path: "$.id", equals: blogId },
  }, select: { data: true } }) : null;
  if (!record || (!isAdmin(ctx) && !blogIsPublic(record.data as Row))) {
    throw new ApiError(404, "blog_not_available", "This article is not available");
  }
}

export function normalizeMessageUpdatePatch(current: Row, raw: Row, actorId: string, isModerator = false, now = new Date()): Row {
  if (current.sender_id !== actorId && !isModerator) throw new ApiError(403, "ownership_required", "You can only change your own messages");
  if (isDeletedForEveryone(current)) throw new ApiError(409, "deleted_content_immutable", "A message deleted for everyone cannot be restored or edited");
  const keys = Object.keys(raw);
  const deleteIntent = raw.is_deleted_for_everyone === true || raw.deleted_for_everyone === true;
  if (deleteIntent) {
    if (keys.some((key) => !new Set(["is_deleted_for_everyone", "deleted_for_everyone", "deleted_at"]).has(key))) {
      throw new ApiError(400, "column_not_writable", "Delete-for-everyone cannot be combined with other message changes");
    }
    const createdAt = new Date(String(current.created_at ?? "")).getTime();
    if (!isModerator && (!Number.isFinite(createdAt) || createdAt < now.getTime() - 3 * 60_000)) {
      throw new ApiError(409, "delete_window_expired", "Cannot delete for everyone after 3 minutes");
    }
    return contentTombstone({
      ...current,
      is_deleted_for_everyone: true,
      deleted_for_everyone: true,
      deleted_at: now.toISOString(),
      deleted_by_user_id: actorId,
    }, true);
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "content") || keys.some((key) => !new Set(["content", "edited_at"]).has(key))) {
    throw new ApiError(400, "column_not_writable", "Only text editing or delete-for-everyone is supported for messages");
  }
  if (current.message_type !== "text") throw new ApiError(400, "message_not_editable", "Only text messages can be edited");
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!content) throw new ApiError(400, "message_content_required", "Message text is required");
  if (content.length > 10_000) throw new ApiError(400, "message_too_long", "Message text is too long");
  return { content, edited_at: now.toISOString() };
}

export function normalizeCallParticipantCreate(
  currentSession: Row,
  actorId: string,
  now = new Date(),
  hasLiveParticipants = false,
): Row {
  const sessionId = typeof currentSession.id === "string" ? currentSession.id : "";
  const roomId = typeof currentSession.room_id === "string" ? currentSession.room_id : "";
  const startedAt = new Date(String(currentSession.started_at ?? "")).getTime();
  const ageMs = now.getTime() - startedAt;
  if (!sessionId || !roomId || currentSession.ended_at || !Number.isFinite(startedAt) || ageMs < -60_000
    || ageMs >= 24 * 60 * 60_000 || (ageMs >= 5 * 60_000 && !hasLiveParticipants)) {
    throw new ApiError(410, "call_session_expired", "This call session is no longer accepting participants");
  }
  const timestamp = now.toISOString();
  return {
    id: newId(), session_id: sessionId, room_id: roomId, user_id: actorId,
    joined_at: timestamp, lease_refreshed_at: timestamp, left_at: null, created_at: timestamp, updated_at: timestamp,
  };
}

export function normalizeCallParticipantUpdate(current: Row, raw: Row, actorId: string, isModerator = false, now = new Date()): Row {
  if (current.user_id !== actorId && !isModerator) throw new ApiError(403, "ownership_required", "You can only leave your own call participant record");
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === "lease_refreshed_at") {
    if (current.left_at) throw new ApiError(410, "call_participant_inactive", "This call participant is no longer active");
    if (!dailyParticipantLeaseIsFresh(current, now.getTime())) {
      throw new ApiError(410, "call_participant_lease_expired", "This call participant lease expired; rejoin the call");
    }
    return { lease_refreshed_at: now.toISOString() };
  }
  if (keys.some((key) => key !== "left_at") || !Object.prototype.hasOwnProperty.call(raw, "left_at")) {
    throw new ApiError(400, "column_not_writable", "Only heartbeat or leaving an active call participant is supported");
  }
  if (current.left_at) return { left_at: current.left_at };
  return { left_at: now.toISOString() };
}

export function normalizeCallSessionFinalization(
  current: Row,
  raw: Row,
  participants: Row[],
  actorId: string,
  isModerator = false,
  now = new Date(),
): Row {
  const allowed = new Set(["ended_at", "duration_seconds", "failure_reason", "participant_count"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "column_not_writable", "Unsupported call session update");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "ended_at") || raw.ended_at == null) {
    throw new ApiError(400, "server_owned_call_state", "Call counts and duration are computed when the last participant leaves");
  }
  if (current.ended_at) {
    return {
      ended_at: current.ended_at,
      duration_seconds: current.duration_seconds ?? 0,
      participant_count: current.participant_count ?? 0,
      failure_reason: current.failure_reason ?? null,
    };
  }
  if (participants.some((row) => dailyParticipantLeaseIsFresh(row, now.getTime()))) {
    throw new ApiError(409, "call_still_active", "The call cannot end while a participant is still active");
  }
  const callerParticipated = participants.some((row) => row.user_id === actorId);
  if (!isModerator && current.started_by !== actorId && !callerParticipated) {
    throw new ApiError(403, "call_finalize_denied", "Only the caller or a participant can finalize this call");
  }
  const startedAt = new Date(String(current.started_at ?? "")).getTime();
  return {
    ended_at: now.toISOString(),
    duration_seconds: Number.isFinite(startedAt) ? Math.max(0, Math.floor((now.getTime() - startedAt) / 1000)) : 0,
    participant_count: new Set(participants.flatMap((row) => typeof row.user_id === "string" ? [row.user_id] : [])).size,
    failure_reason: raw.failure_reason ? "client_reported_failure" : null,
  };
}

async function legacyRealtimeContext(table: string, row: Row): Promise<{ room?: string; audience_ids?: string[] }> {
  const room = typeof row.room_id === "string" ? row.room_id : undefined;
  if (table !== "messages" || !room) return {};
  const members = await prisma.legacyRecord.findMany({ where: {
    table_name: "chat_members",
    data: { path: "$.room_id", equals: room },
  } });
  const audience_ids = members.flatMap((record) => {
    const member = record.data as Row;
    return member.room_id === room && typeof member.user_id === "string" ? [member.user_id] : [];
  });
  return { room, audience_ids };
}

async function legacyReadable(table: string, record: { owner_id: string | null; community_id: string | null; data: Prisma.JsonValue }, ctx: RequestContext): Promise<boolean> {
  const row = record.data as Row;
  if (table === "stories") {
    if (!storyIsActive(row)) return false;
    const ownerId = record.owner_id ?? (typeof row.user_id === "string" ? row.user_id : typeof row.author_id === "string" ? row.author_id : "");
    return !!ownerId && canAccessStoryOwner(ctx.auth.id, ownerId);
  }
  if (table === "polls" || table === "poll_votes") {
    try {
      await visiblePoll(table === "polls" ? row.id : row.poll_id, ctx);
      return true;
    } catch (error) {
      if (error instanceof ApiError && [400, 404].includes(error.status)) return false;
      throw error;
    }
  }
  if (moderatedProfileTable(table)) return profileEntryVisible(row, record.owner_id, ctx.auth.id, isAdmin(ctx));
  if (isAdmin(ctx)) return true;
  if (record.owner_id === ctx.auth.id) return true;
  if (legacyPublicRead.has(table)) {
    if (table === "blogs") return blogIsPublic(row);
    if (table === "blog_comments") return row.is_hidden !== true;
    if (table === "custom_options") return row.status === "approved";
    return true;
  }
  if (legacyCommunityRead.has(table)) return !record.community_id || record.community_id === ctx.auth.community_id;
  if (table === "chat_rooms") return isChatMember(ctx.auth.id, row.id);
  if (table === "messages") {
    if (Array.isArray(row.deleted_for_users) && row.deleted_for_users.includes(ctx.auth.id)) return false;
    return isChatMember(ctx.auth.id, row.room_id);
  }
  if (table === "call_sessions") return isChatMember(ctx.auth.id, row.chat_room_id ?? row.room_id);
  if (table === "call_participants") return isChatMember(ctx.auth.id, row.room_id ?? row.chat_room_id);
  if (table === "consultations") return row.client_id === ctx.auth.id || row.consultant_id === ctx.auth.id;
  return false;
}

function applyLegacyQuery(rows: Row[], query: SerializedQuery, paginate = true): Row[] {
  let result = rows.filter((row) => query.filters.every((filter) => filter.operator === "or"
    ? parseOrExpression(filter.expression ?? String(filter.value ?? "")).some((part) => matchesLogicNode(row, part))
    : matchesFilter(row, filter)));
  for (const ordering of [...query.order].reverse()) {
    result = result.sort((a, b) => {
      const comparison = String(a[ordering.column] ?? "").localeCompare(String(b[ordering.column] ?? ""));
      return ordering.ascending ? comparison : -comparison;
    });
  }
  if (!paginate) return result;
  const from = query.range?.from ?? 0;
  const amount = query.range ? query.range.to - from + 1 : query.limit ?? 100;
  return result.slice(from, from + Math.min(amount, 500));
}

export const publicLegacyRow = (table: string, row: Row, viewerId?: string): Row => {
  if (table === "messages") return contentTombstone(row);
  if (table === "polls") {
    const { created_by: _privateCreator, ...safe } = row;
    return safe;
  }
  if (table === "poll_votes" && row.user_id !== viewerId) {
    return { poll_id: row.poll_id, option_index: row.option_index };
  }
  return row;
};

function requiredMessageScope(
  query: Pick<SerializedQuery, "operation" | "filters">,
  actorId: string,
): Prisma.LegacyRecordWhereInput | undefined {
  if (query.operation === "insert" || query.operation === "upsert") return undefined;
  const equals = (column: string): unknown => query.filters.find((filter) => filter.operator === "eq" && filter.column === column)?.value;
  const roomId = equals("room_id");
  if (typeof roomId === "string" && roomId) {
    return { data: { path: "$.room_id", equals: roomId } };
  }
  const messageId = equals("id");
  if (typeof messageId === "string" && messageId) {
    return { data: { path: "$.id", equals: messageId } };
  }
  const senderId = equals("sender_id");
  const clientId = equals("client_id");
  if (senderId === actorId && typeof clientId === "string" && clientId) {
    return { AND: [
      { owner_id: actorId },
      { data: { path: "$.client_id", equals: clientId } },
    ] };
  }
  throw new ApiError(400, "message_scope_required", "Message queries must identify a chat room, message, or your client message id");
}

export function legacyCandidateWhere(query: Pick<SerializedQuery, "table" | "operation" | "filters">, actorId: string): Prisma.LegacyRecordWhereInput {
  const base: Prisma.LegacyRecordWhereInput = { table_name: query.table };
  if (query.table === "messages") {
    const scope = requiredMessageScope(query, actorId);
    return scope ? { ...base, AND: [scope] } : base;
  }
  // Push exact scalar predicates into MySQL before authorization and the
  // compatibility-layer filters run. This keeps per-user/profile queries
  // correct after a logical table grows beyond the former global 2,000-row
  // sample without trusting a client-controlled SQL/JSON path.
  const exact = query.filters.flatMap((filter): Prisma.LegacyRecordWhereInput[] => {
    if (filter.operator !== "eq" || !filter.column || !/^[a-z][a-z0-9_]{0,79}$/.test(filter.column)) return [];
    if (filter.value === null || !["string", "number", "boolean"].includes(typeof filter.value)) return [];
    return [{ data: { path: `$.${filter.column}`, equals: filter.value as Prisma.InputJsonValue } }];
  });
  return exact.length ? { ...base, AND: exact } : base;
}

async function executeLegacy(query: SerializedQuery, ctx: RequestContext): Promise<{ data: unknown; count?: number }> {
  if (legacyTableRequiresVerification(query.table)
    && !ctx.auth.is_verified && !isAdmin(ctx)) {
    throw new ApiError(403, "verification_required", "Verified membership is required for chats, consultations, and calls");
  }
  if (legacyAdminOnly.has(query.table) && !isAdmin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required");
  if (query.table === "poll_votes" && query.operation === "select") {
    const privateFilter = query.filters.find((filter) => filter.column === "id"
      || (filter.column === "user_id" && (filter.operator !== "eq" || filter.value !== ctx.auth.id)));
    const privateOrder = query.order.find((order) => order.column === "id" || order.column === "user_id");
    if (privateFilter || privateOrder) {
      throw new ApiError(403, "private_poll_ballot", "Individual poll ballots are private");
    }
  }
  const needsSelection = query.operation === "select" || query.operation === "update" || query.operation === "delete";
  const candidates = needsSelection
    ? await prisma.legacyRecord.findMany({ where: legacyCandidateWhere(query, ctx.auth.id), orderBy: { created_at: "desc" } })
    : [];
  const storyAudience = query.table === "stories" ? new Set([
    ctx.auth.id,
    ...(await prisma.connection.findMany({ where: {
      status: "accepted",
      OR: [{ requester_id: ctx.auth.id }, { receiver_id: ctx.auth.id }],
    }, select: { requester_id: true, receiver_id: true } })).map((connection) => connection.requester_id === ctx.auth.id ? connection.receiver_id : connection.requester_id),
  ]) : undefined;
  const scopedMessageRoom = query.table === "messages"
    ? query.filters.find((filter) => filter.operator === "eq" && filter.column === "room_id")?.value
    : undefined;
  const scopedMessageReadable = typeof scopedMessageRoom === "string"
    ? await isChatMember(ctx.auth.id, scopedMessageRoom)
    : undefined;
  const authorized: Row[] = [];
  const potentiallyMatched = needsSelection ? candidates.filter((record) => {
    const row = publicLegacyRow(query.table, record.data as Row, ctx.auth.id);
    return query.filters.every((filter) => filter.operator === "or"
      ? parseOrExpression(filter.expression ?? String(filter.value ?? "")).some((part) => matchesLogicNode(row, part))
      : matchesFilter(row, filter));
  }) : [];
  for (const record of potentiallyMatched) {
    const row = record.data as Row;
    const storyOwner = record.owner_id ?? (typeof row.user_id === "string" ? row.user_id : typeof row.author_id === "string" ? row.author_id : "");
    const readable = storyAudience
      ? storyIsActive(row) && storyAudience.has(storyOwner)
      : query.table === "messages" && scopedMessageReadable !== undefined
        ? scopedMessageReadable && !(Array.isArray(row.deleted_for_users) && row.deleted_for_users.includes(ctx.auth.id))
        : await legacyReadable(query.table, record, ctx);
    if (readable) authorized.push(publicLegacyRow(query.table, row, ctx.auth.id));
  }
  const selected = needsSelection ? applyLegacyQuery(authorized, query) : [];

  if (query.operation === "select") {
    let outputRows = selected;
    if (query.table === "messages" && typeof scopedMessageRoom === "string" && selected.length) {
      const memberships = await prisma.legacyRecord.findMany({ where: {
        table_name: "chat_members",
        data: { path: "$.room_id", equals: scopedMessageRoom },
      }, select: { data: true } });
      outputRows = selected.map((message) => {
        const readBy = new Set(Array.isArray(message.read_by) ? message.read_by as string[] : []);
        for (const record of memberships) {
          const membership = record.data as Row;
          const memberId = typeof membership.user_id === "string" ? membership.user_id : "";
          const lastReadAt = typeof membership.last_read_at === "string" ? membership.last_read_at : "";
          if (memberId && lastReadAt && lastReadAt >= String(message.created_at ?? "")) readBy.add(memberId);
        }
        return { ...message, read_by: [...readBy] };
      });
    }
    const rows = query.options?.head ? [] : outputRows.map((row) => projectColumns(serialize(row) as Row, query.columns));
    const count = query.options?.count ? applyLegacyQuery(authorized, query, false).length : undefined;
    return { data: applyCardinality(rows, query.cardinality), ...(count === undefined ? {} : { count }) };
  }

  assertLegacyMutationAllowed(query.table, query.operation);

  const adminWrite = legacyAdminOnly.has(query.table) || ["app_settings", "nav_config", "ad_messages", "custom_options", "custom_skills", "academic_degrees", "academic_institutes", "academic_networks", "academic_specialisations", "blogs"].includes(query.table);
  if (adminWrite && !isAdmin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required");

  if (query.operation === "upsert") {
    const conflictChoices: Record<string, string[][]> = {
      app_settings: [["key"]],
      forum_deleted_for_user: [["post_id", "user_id"]],
      polls: [["post_id"]],
      onboarding_progress: [["user_id"]],
      job_scan_sources: [["source_url"]],
      blog_bookmarks: [["blog_id", "user_id"]],
      blog_likes: [["blog_id", "user_id"]],
      poll_votes: [["poll_id", "user_id"]],
    };
    const choices = conflictChoices[query.table];
    if (!choices) throw new ApiError(400, "upsert_not_supported", `Upsert is not supported for ${query.table}`);
    const keys = resolveConflictKeys(query.table, query.options?.onConflict, choices);
    const input = Array.isArray(query.values) ? query.values : [query.values];
    const upserted: Row[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "invalid_values", "Values must be objects");
      const row = { ...(raw as Row) };
      normalizeLegacyExternalUrls(query.table, row);
      if (keys.includes("user_id") && !isAdmin(ctx)) row.user_id = ctx.auth.id;
      if (query.table === "blog_likes" || query.table === "blog_bookmarks") {
        const normalized = normalizeBlogAffinityShape(query.table, row, ctx.auth.id);
        for (const key of Object.keys(row)) delete row[key];
        Object.assign(row, normalized);
        await assertBlogInteractionAvailable(row.blog_id, ctx);
      }
      if (query.table === "polls") {
        const post = await visiblePost(row.post_id, ctx);
        if (!isAdmin(ctx) && post.author_id !== ctx.auth.id) throw new ApiError(403, "ownership_required", "Only the post author can configure its poll");
        const recordKey = pollRecordKey(post.id);
        const existingPoll = await prisma.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "polls", record_id: recordKey } } });
        row.id = existingPoll && typeof (existingPoll.data as Row).id === "string" ? (existingPoll.data as Row).id : newId();
        row.post_id = post.id;
        row.created_by = post.author_id ?? ctx.auth.id;
        validatePollPayload(row);
      }
      if (query.table === "poll_votes") {
        assertPollVotePayload(row);
        row.user_id = ctx.auth.id;
        const poll = await visiblePoll(row.poll_id, ctx);
        row.id = pollVoteRecordKey(String(row.poll_id), ctx.auth.id);
        row.option_index = validatePollOption(poll, row.option_index);
      }
      if (keys.some((key) => row[key] === undefined || row[key] === null || row[key] === "")) throw new ApiError(400, "missing_conflict_value", `Upsert requires ${keys.join(", ")}`);
      const existing = query.table === "poll_votes"
        ? await prisma.legacyRecord.findFirst({ where: {
          table_name: "poll_votes", owner_id: ctx.auth.id,
          data: { path: "$.poll_id", equals: String(row.poll_id) },
        } })
        : query.table === "polls"
          ? await prisma.legacyRecord.findFirst({ where: {
            table_name: "polls", data: { path: "$.post_id", equals: String(row.post_id) },
          } })
        : await prisma.legacyRecord.findFirst({ where: {
          table_name: query.table,
          AND: keys.map((key) => ({ data: { path: `$.${key}`, equals: row[key] as Prisma.InputJsonValue } })),
        } });
      if (existing) {
        if (!isAdmin(ctx) && query.table !== "polls" && existing.owner_id !== ctx.auth.id) throw new ApiError(403, "ownership_required", "You do not own this row");
        if (query.table === "polls"
          && (JSON.stringify((existing.data as Row).options ?? []) !== JSON.stringify(row.options ?? [])
            || String((existing.data as Row).question ?? "") !== String(row.question ?? ""))) {
          throw new ApiError(409, "poll_content_immutable", "Published poll questions and options cannot be changed");
        }
        const next = { ...(existing.data as Row), ...row, id: (existing.data as Row).id, updated_at: new Date().toISOString() };
        const saved = await prisma.legacyRecord.update({ where: { id: existing.id }, data: { data: next as Prisma.InputJsonValue } });
        upserted.push(saved.data as Row);
        emitDbChange({ table: query.table, event: "UPDATE", row: saved.data as Row, actor_id: ctx.auth.id });
      } else {
        const owner_id = legacyOwner(query.table, row, ctx);
        if (owner_id && owner_id !== ctx.auth.id && !isAdmin(ctx)) throw new ApiError(403, "ownership_required", "Cannot create a row for another user");
        const record_id = query.table === "poll_votes"
          ? pollVoteRecordKey(String(row.poll_id), ctx.auth.id)
          : query.table === "polls"
            ? `poll:${sha256(String(row.post_id)).slice(0, 64)}`
          : typeof row.id === "string" ? row.id : sha256(keys.map((key) => String(row[key])).join("\n")).slice(0, 64);
        row.id = typeof row.id === "string" ? row.id : newId();
        const saved = await prisma.legacyRecord.create({ data: { table_name: query.table, record_id, owner_id, community_id: typeof row.community_id === "string" ? row.community_id : ctx.auth.community_id, data: row as Prisma.InputJsonValue } });
        upserted.push(saved.data as Row);
        emitDbChange({ table: query.table, event: "INSERT", row: saved.data as Row, actor_id: ctx.auth.id });
      }
    }
    return { data: applyCardinality(upserted.map((row) => projectColumns(row, query.columns)), query.cardinality) };
  }

  if (query.operation === "insert") {
    const input = Array.isArray(query.values) ? query.values : [query.values];
    const created: Row[] = [];
    const inserted: Row[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "invalid_values", "Values must be objects");
      const data = { ...(raw as Row) };
      data.created_at ??= new Date().toISOString();
      data.updated_at ??= data.created_at;
      normalizeLegacyExternalUrls(query.table, data);
      if (query.table === "blogs") Object.assign(data, normalizeBlogPublishing(data));
      if (moderatedProfileTable(query.table)) {
        assertModeratedProfileWrite(query.table, data, undefined, isAdmin(ctx));
        if (!isAdmin(ctx)) data.user_id = ctx.auth.id;
        if (query.table === "education") data.is_verified = false;
        Object.assign(data, await prepareModeratedProfileRow(query.table, data, ctx.auth.id));
      }
      if (query.table === "chat_members") throw new ApiError(403, "rpc_required", "Chat membership can only be changed through an authorized chat operation");
      if (query.table === "messages") {
        const normalized = normalizeNewMessageShape(data, ctx.auth.id);
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, normalized);
        if (!(await isChatMember(ctx.auth.id, data.room_id))) throw new ApiError(403, "chat_membership_required", "Chat membership is required");
        if (data.media_path) {
          data.media_path = await assertOwnedReadyObject(
            "chat-media",
            data.media_path,
            ctx.auth.id,
            data.message_type === "image" ? /^image\// : /^audio\//,
          );
        }
        if (data.reply_to_message_id) {
          const reply = await prisma.legacyRecord.findFirst({ where: {
            table_name: "messages",
            AND: [
              { data: { path: "$.id", equals: String(data.reply_to_message_id) } },
              { data: { path: "$.room_id", equals: String(data.room_id) } },
            ],
          }, select: { data: true } });
          if (!reply || isDeletedForEveryone(reply.data as Row)) throw new ApiError(400, "invalid_reply_message", "Reply message must exist in the same room");
        }
      }
      if (query.table === "blog_comments") {
        const normalized = normalizeNewBlogCommentShape(data, ctx.auth.id);
        const blog = await prisma.legacyRecord.findFirst({ where: {
          table_name: "blogs", data: { path: "$.id", equals: String(normalized.blog_id) },
        }, select: { data: true } });
        if (!blog || (!isAdmin(ctx) && !blogIsPublic(blog.data as Row))) throw new ApiError(404, "blog_not_available", "This article is not available for comments");
        if (normalized.parent_id) {
          const parent = await prisma.legacyRecord.findFirst({ where: {
            table_name: "blog_comments",
            AND: [
              { data: { path: "$.id", equals: String(normalized.parent_id) } },
              { data: { path: "$.blog_id", equals: String(normalized.blog_id) } },
            ],
          }, select: { data: true } });
          if (!parent || (parent.data as Row).is_hidden === true) throw new ApiError(400, "invalid_parent_comment", "Parent comment must be visible and belong to this article");
        }
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, normalized);
      }
      if (query.table === "blog_likes" || query.table === "blog_bookmarks") {
        const normalized = normalizeBlogAffinityShape(query.table, data, ctx.auth.id);
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, normalized);
        await assertBlogInteractionAvailable(data.blog_id, ctx);
      }
      if (query.table === "call_participants") {
        const sessionId = typeof data.session_id === "string" ? data.session_id : "";
        if (!sessionId) throw new ApiError(400, "call_session_not_found", "Call session was not found");
        const result = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE table_name = 'call_sessions' AND record_id = ${sessionId} LIMIT 1 FOR UPDATE`);
          const session = await tx.legacyRecord.findUnique({ where: callSessionRecordIdentity(sessionId) });
          const sessionRow = session?.data as Row | undefined;
          if (!sessionRow || sessionRow.id !== sessionId) throw new ApiError(404, "call_session_not_found", "Call session was not found");
          const participants = await tx.legacyRecord.findMany({ where: {
            table_name: "call_participants",
            data: { path: "$.session_id", equals: sessionId },
          }, select: { data: true } });
          const normalized = normalizeCallParticipantCreate(
            sessionRow,
            ctx.auth.id,
            new Date(),
            participants.some((record) => dailyParticipantLeaseIsFresh(record.data as Row)),
          );
          const membership = await tx.legacyRecord.findFirst({ where: {
            table_name: "chat_members", owner_id: ctx.auth.id,
            data: { path: "$.room_id", equals: String(normalized.room_id) },
          }, select: { id: true } });
          if (!membership) throw new ApiError(403, "call_membership_required", "An active chat call membership is required");
          const recordId = `call-participant:${sha256(`${sessionId}\n${ctx.auth.id}`).slice(0, 64)}`;
          const existing = await tx.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "call_participants", record_id: recordId } } });
          const row = existing ? { ...(existing.data as Row), ...normalized, id: (existing.data as Row).id } : normalized;
          const saved = await tx.legacyRecord.upsert({
            where: { table_name_record_id: { table_name: "call_participants", record_id: recordId } },
            create: { table_name: "call_participants", record_id: recordId, owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: row as Prisma.InputJsonValue },
            update: { owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: row as Prisma.InputJsonValue },
          });
          return { saved, existing: !!existing, roomId: String(normalized.room_id) };
        });
        const output = publicLegacyRow(query.table, result.saved.data as Row, ctx.auth.id);
        created.push(output);
        emitDbChange({ table: query.table, event: result.existing ? "UPDATE" : "INSERT", row: output, actor_id: ctx.auth.id, room: `room-${result.roomId}` });
        continue;
      }
      if (query.table === "document_verifications" || query.table === "course_verification_requests") data.status = "pending";
      if (query.table === "document_verifications" || query.table === "course_verification_requests") data.user_id = ctx.auth.id;
      if (query.table === "document_verifications") {
        if (typeof data.iit_name !== "string" || typeof data.student_status !== "string" || !new Set(["current_student", "alumni"]).has(data.student_status)) {
          throw new ApiError(400, "invalid_verification_submission", "A valid institute and member type are required");
        }
        data.document_path = await assertOwnedReadyObject("verification-documents", data.document_path, ctx.auth.id);
      }
      if (query.table === "stories") {
        data.user_id = ctx.auth.id;
        if (Object.prototype.hasOwnProperty.call(data, "author_id")) data.author_id = ctx.auth.id;
        data.expires_at = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
        data.image_url = null;
        if (data.image_path != null && data.image_path !== "") data.image_path = await assertOwnedReadyObject("stories", data.image_path, ctx.auth.id);
        const storyContent = typeof data.content === "string" ? data.content.trim() : "";
        if (!storyContent && !data.image_path) throw new ApiError(400, "story_content_required", "A story needs text or an uploaded image");
        if (storyContent.length > 5000) throw new ApiError(400, "story_too_long", "Story text is too long");
      }
      if (query.table === "polls") {
        const post = await visiblePost(data.post_id, ctx);
        if (!isAdmin(ctx) && post.author_id !== ctx.auth.id) throw new ApiError(403, "ownership_required", "Only the post author can configure its poll");
        data.id = newId();
        data.post_id = post.id;
        data.created_by = post.author_id ?? ctx.auth.id;
        validatePollPayload(data);
        const existingPoll = await prisma.legacyRecord.findFirst({ where: {
          table_name: "polls", data: { path: "$.post_id", equals: String(data.post_id) },
        } });
        if (existingPoll) throw new ApiError(409, "poll_exists", "This post already has a poll");
      }
      if (query.table === "poll_votes") {
        assertPollVotePayload(data);
        data.user_id = ctx.auth.id;
        const poll = await visiblePoll(data.poll_id, ctx);
        data.id = pollVoteRecordKey(String(data.poll_id), ctx.auth.id);
        data.option_index = validatePollOption(poll, data.option_index);
        const existingVote = await prisma.legacyRecord.findFirst({ where: {
          table_name: "poll_votes", owner_id: ctx.auth.id,
          data: { path: "$.poll_id", equals: String(data.poll_id) },
        } });
        if (existingVote) throw new ApiError(409, "poll_vote_exists", "You have already voted in this poll");
      }
      const owner_id = legacyOwner(query.table, data, ctx);
      if (owner_id && owner_id !== ctx.auth.id && !isAdmin(ctx)) throw new ApiError(403, "ownership_required", "Cannot create a row for another user");
      const record_id = query.table === "poll_votes"
        ? pollVoteRecordKey(String(data.poll_id), ctx.auth.id)
        : query.table === "polls"
          ? pollRecordKey(String(data.post_id))
        : query.table === "blog_likes" || query.table === "blog_bookmarks"
          ? `${query.table === "blog_likes" ? "blog-like" : "blog-bookmark"}:${sha256(`${String(data.blog_id)}\n${ctx.auth.id}`).slice(0, 64)}`
        : query.table === "messages" && typeof data.client_id === "string" && data.client_id
        ? `message:${sha256(`${ctx.auth.id}\n${String(data.room_id)}\n${data.client_id}`).slice(0, 64)}`
        : typeof data.id === "string" ? data.id : newId();
      data.id = typeof data.id === "string" ? data.id : newId();
      try {
        const record = await prisma.legacyRecord.create({ data: { table_name: query.table, record_id, owner_id, community_id: typeof data.community_id === "string" ? data.community_id : ctx.auth.community_id, data: data as Prisma.InputJsonValue } });
        created.push(publicLegacyRow(query.table, record.data as Row, ctx.auth.id));
        inserted.push(publicLegacyRow(query.table, record.data as Row, ctx.auth.id));
      } catch (error) {
        if ((query.table === "blog_likes" || query.table === "blog_bookmarks") && (error as { code?: string }).code === "P2002") {
          const duplicate = await prisma.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: query.table, record_id } } });
          if (duplicate?.owner_id === ctx.auth.id) {
            created.push(publicLegacyRow(query.table, duplicate.data as Row, ctx.auth.id));
            continue;
          }
          throw new ApiError(409, "blog_interaction_conflict", "This article interaction already exists");
        }
        if (query.table === "poll_votes" && (error as { code?: string }).code === "P2002") {
          throw new ApiError(409, "poll_vote_exists", "You have already voted in this poll");
        }
        if (query.table === "polls" && (error as { code?: string }).code === "P2002") {
          throw new ApiError(409, "poll_exists", "This post already has a poll");
        }
        if (query.table !== "messages" || (error as { code?: string }).code !== "P2002") throw error;
        const duplicate = await prisma.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "messages", record_id } } });
        const duplicateRow = duplicate?.data as Row | undefined;
        if (!duplicateRow || duplicate?.owner_id !== ctx.auth.id || duplicateRow.client_id !== data.client_id || duplicateRow.room_id !== data.room_id) {
          throw new ApiError(409, "message_id_conflict", "Message identifier is already in use");
        }
        created.push(publicLegacyRow(query.table, duplicateRow, ctx.auth.id));
      }
    }
    for (const row of inserted) emitDbChange({ table: query.table, event: "INSERT", row, actor_id: ctx.auth.id, ...await legacyRealtimeContext(query.table, row) });
    return { data: applyCardinality(created.map((row) => projectColumns(row, query.columns)), query.cardinality) };
  }

  const targetIds = new Set(selected.map((row) => String(row.id)));
  const targetRecords = candidates.filter((record) => targetIds.has(String((record.data as Row).id)));
  if (!targetRecords.length) return { data: applyCardinality([], query.cardinality) };
  if (query.table === "polls") {
    for (const record of targetRecords) {
      const post = await visiblePost((record.data as Row).post_id, ctx);
      if (!isAdmin(ctx) && post.author_id !== ctx.auth.id) throw new ApiError(403, "ownership_required", "Only the post author can change its poll");
    }
  }
  for (const record of targetRecords) {
    if (!isAdmin(ctx) && record.owner_id !== ctx.auth.id && query.table !== "call_sessions" && query.table !== "polls") throw new ApiError(403, "ownership_required", "You do not own every selected row");
  }
  if (query.operation === "delete") {
    if (query.table === "messages" && !isAdmin(ctx)) {
      throw new ApiError(403, "message_delete_requires_tombstone", "Messages cannot be hard-deleted; use delete-for-everyone within the allowed window");
    }
    if (query.table === "call_participants" && !isAdmin(ctx)) {
      throw new ApiError(403, "call_participant_delete_denied", "Call participant history cannot be hard-deleted");
    }
    const deletedRows = await prisma.$transaction(async (tx) => {
      const ids = targetRecords.map((record) => record.id).sort();
      for (const id of ids) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE id = ${id} AND table_name = ${query.table} LIMIT 1 FOR UPDATE`);
      }
      const freshRecords = await tx.legacyRecord.findMany({ where: { id: { in: ids }, table_name: query.table } });
      if (freshRecords.length !== ids.length) {
        throw new ApiError(409, "record_changed", "A selected record changed while this request was being processed; refresh and try again");
      }
      for (const record of freshRecords) {
        const freshRow = publicLegacyRow(query.table, record.data as Row, ctx.auth.id);
        const stillMatches = query.filters.every((filter) => filter.operator === "or"
          ? parseOrExpression(filter.expression ?? String(filter.value ?? "")).some((part) => matchesLogicNode(freshRow, part))
          : matchesFilter(freshRow, filter));
        if (!stillMatches) throw new ApiError(409, "record_changed", "A selected record changed while this request was being processed; refresh and try again");
        if (!isAdmin(ctx) && record.owner_id !== ctx.auth.id && query.table !== "polls") {
          throw new ApiError(403, "ownership_required", "You no longer own this row");
        }
        if (query.table === "education" && !isAdmin(ctx) && (record.data as Row).is_verified === true) {
          throw new ApiError(409, "verified_education_immutable", "Verified education cannot be deleted");
        }
        if (query.table === "polls" && !isAdmin(ctx)) {
          const postId = String((record.data as Row).post_id ?? "");
          const post = postId ? await tx.post.findUnique({ where: { id: postId }, select: { author_id: true } }) : null;
          if (!post || post.author_id !== ctx.auth.id) throw new ApiError(403, "ownership_required", "Only the post author can remove its poll");
        }
      }
      if (query.table === "polls") {
        for (const record of freshRecords) {
          const pollId = (record.data as Row).id;
          if (typeof pollId === "string" && pollId) {
            await tx.legacyRecord.deleteMany({ where: {
              table_name: "poll_votes",
              data: { path: "$.poll_id", equals: pollId },
            } });
          }
        }
      }
      await tx.legacyRecord.deleteMany({ where: { id: { in: ids }, table_name: query.table } });
      if (query.table === "education") {
        const educationIds = freshRecords.map((record) => (record.data as Row).id).filter((id): id is string => typeof id === "string");
        if (educationIds.length) await tx.profile.updateMany({ where: { primary_education_id: { in: educationIds } }, data: { primary_education_id: null } });
      }
      if (query.table === "messages" || query.table === "stories") {
        await revokePrivateMedia(freshRecords.map((record) => record.data as Row), query.table === "stories" ? "story" : "message", tx);
      }
      return freshRecords.map((record) => publicLegacyRow(query.table, record.data as Row, ctx.auth.id));
    });
    for (const row of deletedRows) emitDbChange({ table: query.table, event: "DELETE", row, actor_id: ctx.auth.id, ...await legacyRealtimeContext(query.table, row) });
    return { data: applyCardinality(deletedRows, query.cardinality) };
  }

  if (!query.values || typeof query.values !== "object" || Array.isArray(query.values)) throw new ApiError(400, "invalid_values", "Update values must be an object");
  const patch = { ...(query.values as Row) };
  normalizeLegacyExternalUrls(query.table, patch);
  if (query.table === "blog_likes" || query.table === "blog_bookmarks") {
    throw new ApiError(403, "affinity_update_denied", "Likes and bookmarks can only be created or removed");
  }
  if (query.table === "blog_comments") {
    const allowed = isAdmin(ctx) ? new Set(["content", "is_hidden"]) : new Set(["content"]);
    if (Object.keys(patch).some((key) => !allowed.has(key))) throw new ApiError(400, "column_not_writable", "Unsupported blog comment update");
    if (Object.prototype.hasOwnProperty.call(patch, "content")) {
      if (typeof patch.content !== "string" || !patch.content.trim()) throw new ApiError(400, "comment_content_required", "Comment text is required");
      if (patch.content.trim().length > 5_000) throw new ApiError(400, "comment_too_long", "Comment text is too long");
      patch.content = patch.content.trim();
    }
    if (Object.prototype.hasOwnProperty.call(patch, "is_hidden") && typeof patch.is_hidden !== "boolean") {
      throw new ApiError(400, "invalid_comment_visibility", "Comment visibility must be a boolean");
    }
  }
  if (query.table === "notifications" && Object.keys(patch).some((key) => key !== "is_read")) {
    throw new ApiError(400, "column_not_writable", "Only notification read state can be changed directly");
  }
  if (query.table === "stories" && Object.keys(patch).some((key) => !new Set(["content", "deleted_at"]).has(key))) {
    throw new ApiError(400, "column_not_writable", "Story media and audience cannot be changed after publishing");
  }
  if (query.table === "poll_votes" && Object.keys(patch).some((key) => key !== "option_index")) {
    throw new ApiError(400, "column_not_writable", "Only the selected poll option can be changed");
  }
  if (query.table === "polls") {
    throw new ApiError(403, "poll_content_immutable", "Published poll questions and options cannot be changed; remove and recreate the poll to reset it");
  }
  const updated: Row[] = [];
  for (const record of targetRecords) {
    const selectedCurrent = record.data as Row;
    if (query.table === "call_sessions") {
      const saved = await prisma.$transaction(async (tx) => {
        const sessionId = String(selectedCurrent.id ?? "");
        await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE table_name = 'call_sessions' AND record_id = ${sessionId} LIMIT 1 FOR UPDATE`);
        const freshRecord = await tx.legacyRecord.findUnique({ where: callSessionRecordIdentity(sessionId) });
        const fresh = freshRecord?.data as Row | undefined;
        if (!freshRecord || !fresh || fresh.id !== sessionId) throw new ApiError(404, "call_session_not_found", "Call session was not found");
        const roomId = fresh.room_id ?? fresh.chat_room_id;
        if (!isAdmin(ctx)) {
          const membership = await tx.legacyRecord.findFirst({ where: {
            table_name: "chat_members", owner_id: ctx.auth.id,
            data: { path: "$.room_id", equals: String(roomId ?? "") },
          }, select: { id: true } });
          if (!membership) throw new ApiError(403, "call_membership_required", "Chat membership is required");
        }
        const participantRecords = await tx.legacyRecord.findMany({ where: {
          table_name: "call_participants",
          data: { path: "$.session_id", equals: sessionId },
        }, select: { data: true } });
        const effectivePatch = normalizeCallSessionFinalization(
          fresh,
          patch,
          participantRecords.map((participant) => participant.data as Row),
          ctx.auth.id,
          isAdmin(ctx),
        );
        const next = { ...fresh, ...effectivePatch, id: fresh.id, updated_at: new Date().toISOString() };
        return tx.legacyRecord.update({ where: { id: freshRecord.id }, data: { data: next as Prisma.InputJsonValue } });
      });
      updated.push(publicLegacyRow(query.table, saved.data as Row, ctx.auth.id));
      continue;
    }
    const saved = await prisma.$transaction(async (tx) => {
      // Call participant changes and finalization share the session lock so a
      // leave cannot race a stale participant count. Other legacy mutations
      // lock the target row directly.
      if (query.table === "call_participants") {
        const sessionId = String(selectedCurrent.session_id ?? "");
        await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE table_name = 'call_sessions' AND record_id = ${sessionId} LIMIT 1 FOR UPDATE`);
      }
      await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE id = ${record.id} AND table_name = ${query.table} LIMIT 1 FOR UPDATE`);
      const freshRecord = await tx.legacyRecord.findUnique({ where: { id: record.id } });
      if (!freshRecord || freshRecord.table_name !== query.table) {
        throw new ApiError(409, "record_changed", "The record changed while this request was being processed; refresh and try again");
      }
      if (!isAdmin(ctx) && freshRecord.owner_id !== ctx.auth.id && query.table !== "polls") {
        throw new ApiError(403, "ownership_required", "You no longer own this row");
      }
      const current = freshRecord.data as Row;
      if (moderatedProfileTable(query.table)) assertModeratedProfileWrite(query.table, patch, current, isAdmin(ctx));
      const effectivePatch = query.table === "messages"
        ? normalizeMessageUpdatePatch(current, patch, ctx.auth.id, isAdmin(ctx))
        : query.table === "call_participants"
          ? normalizeCallParticipantUpdate(current, patch, ctx.auth.id, isAdmin(ctx))
          : patch;
      let next: Row = { ...current, ...effectivePatch, id: current.id, updated_at: new Date().toISOString() };
      if (query.table === "blogs") next = normalizeBlogPublishing(next);
      if (moderatedProfileTable(query.table)) {
        next.user_id = current.user_id;
        if (query.table === "education") next.is_verified = current.is_verified ?? false;
        next = await prepareModeratedProfileRow(query.table, next, ctx.auth.id, tx);
      }
      if (query.table === "poll_votes") {
        const poll = await visiblePoll(current.poll_id, ctx);
        next.user_id = ctx.auth.id;
        next.poll_id = current.poll_id;
        next.option_index = validatePollOption(poll, next.option_index);
      }
      if (query.table === "polls") validatePollPayload(next);
      const stored = await tx.legacyRecord.update({ where: { id: freshRecord.id }, data: { data: next as Prisma.InputJsonValue } });
      if (query.table === "messages" && isDeletedForEveryone(next) || query.table === "stories" && next.deleted_at != null) {
        await revokePrivateMedia([current], query.table === "stories" ? "story" : "message", tx);
      }
      return stored;
    });
    updated.push(publicLegacyRow(query.table, saved.data as Row, ctx.auth.id));
  }
  const leaseHeartbeat = query.table === "call_participants"
    && Object.keys(patch).length === 1
    && Object.prototype.hasOwnProperty.call(patch, "lease_refreshed_at");
  if (!leaseHeartbeat) {
    for (const row of updated) emitDbChange({ table: query.table, event: "UPDATE", row, actor_id: ctx.auth.id, ...await legacyRealtimeContext(query.table, row) });
  }
  return { data: applyCardinality(updated.map((row) => projectColumns(row, query.columns)), query.cardinality) };
}

export async function executeDataQuery(query: SerializedQuery, ctx: RequestContext): Promise<{ data: unknown; count?: number }> {
  if (query.table === "user_roles") {
    if (query.operation !== "select") throw new ApiError(403, "write_not_allowed", "Use role-management RPCs to change roles");
    const users = await prisma.user.findMany({ where: isAdmin(ctx) ? {} : { id: ctx.auth.id }, select: { id: true, role: true }, take: 1000 });
    const virtual = deriveVirtualUserRoles(users);
    const filtered = applyLegacyQuery(virtual, { ...query, range: undefined, limit: 1000 });
    const from = query.range?.from ?? 0;
    const take = query.range ? query.range.to - from + 1 : query.limit ?? 100;
    const rows = filtered.slice(from, from + Math.min(take, 500)).map((row) => projectColumns(row, query.columns));
    return { data: applyCardinality(rows, query.cardinality), ...(query.options?.count ? { count: filtered.length } : {}) };
  }
  if (policies[query.table]) return executeCore(query, ctx);
  if (legacyTables.has(query.table)) return executeLegacy(query, ctx);
  throw new ApiError(400, "table_not_allowed", `Table ${query.table} is not available through the compatibility API`);
}
