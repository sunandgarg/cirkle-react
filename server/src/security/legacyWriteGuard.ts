import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

type Row = Record<string, unknown>;
type Operation = "insert" | "update" | "upsert" | "delete" | "select";

const id = z.string().trim().min(1).max(100);
const shortText = z.string().max(500);
const text = z.string().max(10_000);
const date = z.string().max(64);
const nullableDate = date.nullable();
const nullableShortText = shortText.nullable();
const forumScopeType = z.string().regex(/^[A-Z][A-Z_]{0,39}$/);
const common = {
  id: id.optional(),
  created_at: date.optional(),
  updated_at: date.optional(),
};

const boundedJson: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(2_000),
  z.array(boundedJson).max(50),
  z.record(boundedJson).refine((value) => Object.keys(value).length <= 50, "JSON object has too many fields"),
]));

const schemas: Record<string, z.AnyZodObject> = {
  blog_bookmarks: z.object({ ...common, blog_id: id, user_id: id.optional() }).strict(),
  blog_comments: z.object({ ...common, blog_id: id, parent_id: id.nullable().optional(), author_id: id.optional(), content: z.string().trim().min(1).max(5_000), is_hidden: z.boolean().optional() }).strict(),
  blog_likes: z.object({ ...common, blog_id: id, user_id: id.optional() }).strict(),
  call_participants: z.object({ ...common, session_id: id.optional(), user_id: id.optional(), lease_refreshed_at: date.optional(), left_at: nullableDate.optional() }).strict(),
  call_sessions: z.object({ ended_at: nullableDate.optional(), failure_reason: nullableShortText.optional() }).strict(),
  course_verification_requests: z.object({ ...common, user_id: id.optional(), course_name: z.string().trim().min(2).max(100), iit_name: z.string().trim().min(2).max(160), applicant_name: nullableShortText.optional() }).strict(),
  document_verifications: z.object({ ...common, user_id: id.optional(), iit_name: z.string().trim().min(2).max(160), student_status: z.enum(["current_student", "alumni"]), document_type: z.string().trim().min(1).max(80), document_path: z.string().trim().min(1).max(500), original_filename: z.string().trim().min(1).max(255), mime_type: z.string().trim().min(1).max(120), file_size: z.number().int().positive().max(512 * 1024) }).strict(),
  education: z.object({ ...common, user_id: id.optional(), institution: z.string().trim().min(1).max(160), degree: nullableShortText.optional(), branch_area: nullableShortText.optional(), passing_year: nullableShortText.optional(), location: nullableShortText.optional(), is_other_institution: z.boolean().optional(), is_other_branch: z.boolean().optional(), institution_option_id: id.nullable().optional(), branch_option_id: id.nullable().optional(), location_option_id: id.nullable().optional(), is_verified: z.boolean().optional() }).strict(),
  forum_deleted_for_user: z.object({ ...common, post_id: id, user_id: id.optional(), deleted_at: date.optional() }).strict(),
  forum_room_state: z.object({ user_id: id.optional(), scope_type: forumScopeType, scope_key: z.string().trim().min(1).max(500), draft: text.optional(), last_opened_at: date.optional(), last_read_at: date.optional(), muted_until: nullableDate.optional(), notification_level: z.enum(["all", "mentions", "none"]).optional(), scroll_offset: z.number().finite().min(0).max(100_000_000).optional(), updated_at: date.optional() }).strict(),
  messages: z.object({ ...common, room_id: id, sender_id: id.optional(), client_id: id.optional(), content: text.optional(), message_type: z.enum(["text", "image", "voice"]).optional(), media_url: z.string().max(2_048).nullable().optional(), media_path: z.string().max(500).nullable().optional(), media_bucket: z.string().max(80).nullable().optional(), voice_duration: z.number().int().min(1).max(3_600).nullable().optional(), reply_to_message_id: id.nullable().optional(), status: z.enum(["sent", "delivered", "read"]).optional(), read_by: z.array(id).max(2).optional(), edited_at: nullableDate.optional(), deleted_at: nullableDate.optional(), is_deleted_for_everyone: z.boolean().optional(), deleted_for_everyone: z.boolean().optional() }).strict(),
  notifications: z.object({ is_read: z.boolean() }).strict(),
  onboarding_progress: z.object({ user_id: id.optional(), flow_step: z.string().max(80), progress_data: z.object({ selectedIit: shortText.optional(), studentStatus: z.enum(["current_student", "alumni", ""]).optional(), iitEmail: z.string().email().max(254).optional(), accountName: shortText.optional(), phoneCountryCode: z.string().max(8).optional(), phone: z.string().max(24).optional(), name: shortText.optional(), degree: shortText.optional(), otherCourse: shortText.optional(), specialisation: shortText.optional(), year: z.string().max(16).optional(), location: shortText.optional(), linkedin: z.string().max(2_048).optional(), company: shortText.optional(), companyLogoUrl: z.string().max(2_048).optional(), acceptedTerms: z.boolean().optional() }).strict(), updated_at: date.optional() }).strict(),
  poll_votes: z.object({ ...common, poll_id: id, user_id: id.optional(), option_index: z.number().int().min(0).max(20) }).strict(),
  polls: z.object({ ...common, post_id: id, question: z.string().trim().min(1).max(500), options: z.array(z.string().trim().min(1).max(200)).min(2).max(10) }).strict(),
  professional_experience: z.object({ ...common, user_id: id.optional(), company_name: z.string().trim().min(1).max(160), job_title: nullableShortText.optional(), start_date: nullableDate.optional(), end_date: nullableDate.optional(), is_current: z.boolean().optional(), location: nullableShortText.optional(), is_other_company: z.boolean().optional(), company_option_id: id.nullable().optional(), location_option_id: id.nullable().optional(), logo_url: z.string().max(2_048).nullable().optional() }).strict(),
  saved_views: z.object({ ...common, user_id: id.optional(), name: z.string().trim().min(1).max(120), scope_type: z.string().trim().min(1).max(40), scope_key: z.string().trim().min(1).max(500), sort: z.string().max(80).nullable().optional(), pinned: z.boolean().optional(), filters_json: z.record(boundedJson).nullable().optional() }).strict(),
  stories: z.object({ ...common, user_id: id.optional(), author_id: id.optional(), content: z.string().max(5_000).nullable().optional(), image_url: z.string().max(2_048).nullable().optional(), image_path: z.string().max(500).nullable().optional(), expires_at: date.optional(), deleted_at: nullableDate.optional() }).strict(),
  user_pinned_messages: z.object({ ...common, user_id: id.optional(), message_id: id, forum_scope_type: forumScopeType.optional(), forum_scope_key: z.string().max(500).optional(), pinned_at: date.optional() }).strict(),
};

const rowLimits: Record<string, number> = {
  blog_bookmarks: 10_000,
  blog_comments: 5_000,
  blog_likes: 10_000,
  call_participants: 5_000,
  course_verification_requests: 20,
  document_verifications: 20,
  education: 50,
  forum_deleted_for_user: 5_000,
  forum_room_state: 250,
  messages: 100_000,
  onboarding_progress: 1,
  poll_votes: 10_000,
  polls: 1_000,
  professional_experience: 100,
  saved_views: 100,
  stories: 500,
  user_pinned_messages: 1_000,
};

export const MAX_LEGACY_ROW_BYTES = 32 * 1024;
export const MAX_LEGACY_OWNER_BYTES = 32 * 1024 * 1024;
export const MAX_LEGACY_MUTATION_ROWS = 25;

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

export function assertBoundedJson(value: unknown, maxBytes = 4 * 1024, label = "metadata"): unknown {
  const parsed = boundedJson.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_metadata", `${label} must contain bounded JSON values`, parsed.error.flatten());
  if (jsonBytes(parsed.data) > maxBytes) throw new ApiError(413, "metadata_too_large", `${label} is too large`);
  return parsed.data;
}

const reject = (status: 400 | 403 | 413 | 429, code: string, message: string, table: string): never => {
  logger.warn({ security_event: "legacy_write_rejected", reason: code, table }, message);
  throw new ApiError(status, code, message);
};

export function assertLegacyMutationInput(table: string, operation: Operation, values: unknown, admin: boolean): void {
  if (operation === "select" || operation === "delete") return;
  if (!admin && table === "call_sessions" && operation !== "update") {
    return reject(403, "rpc_required", "Call sessions can only be created through the authorized call workflow", table);
  }
  if (!admin && table === "notifications" && operation !== "update") {
    return reject(403, "rpc_required", "Notifications can only be created by an authorized server workflow", table);
  }
  const rows = Array.isArray(values) ? values : [values];
  if (!rows.length || rows.length > MAX_LEGACY_MUTATION_ROWS) {
    reject(413, "mutation_batch_too_large", `A mutation may contain at most ${MAX_LEGACY_MUTATION_ROWS} rows`, table);
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) reject(400, "invalid_values", "Mutation values must be objects", table);
    if (jsonBytes(row) > (admin ? 64 * 1024 : MAX_LEGACY_ROW_BYTES)) {
      reject(413, "record_too_large", "This record is too large", table);
    }
    if (admin) continue;
    const schema = schemas[table];
    if (!schema) return reject(403, "rpc_required", `${table} does not support direct member writes`, table);
    const parsed = (operation === "update" ? schema.partial() : schema).safeParse(row);
    if (!parsed.success) throw new ApiError(400, "invalid_record", `Invalid ${table} record`, parsed.error.flatten());
  }
}

export function assertLegacyStoredPayload(table: string, row: Row, admin: boolean): number {
  const bytes = jsonBytes(row);
  if (bytes > (admin ? 64 * 1024 : MAX_LEGACY_ROW_BYTES)) reject(413, "record_too_large", "This record is too large", table);
  return bytes;
}

type QuotaClient = {
  legacyRecord: { count(args: unknown): Promise<number> };
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

export async function assertLegacyOwnerQuota(
  client: QuotaClient,
  table: string,
  ownerId: string,
  additionalBytes: number,
  additionalRows: number,
): Promise<void> {
  const tableLimit = rowLimits[table];
  if (!tableLimit) return reject(403, "rpc_required", `${table} does not support direct member writes`, table);
  const tableRows = await client.legacyRecord.count({ where: { table_name: table, owner_id: ownerId } });
  if (additionalRows > 0 && tableRows + additionalRows > tableLimit) reject(429, "record_quota_exceeded", `You have reached the ${table} record limit`, table);

  // Chat is latency-sensitive and already has a strict field schema, a 10 KiB
  // content limit, per-user write throttling, and a row cap. Avoid an O(n)
  // owner-wide JSON SUM for every message send.
  if (table === "messages" || additionalBytes <= 0) return;
  const usage = await client.$queryRaw<Array<{ bytes_used: bigint | number | string }>>(Prisma.sql`
      SELECT COALESCE(SUM(OCTET_LENGTH(CAST(data AS CHAR))), 0) AS bytes_used
      FROM legacy_records
      WHERE owner_id = ${ownerId}
        AND table_name <> 'messages'
    `);
  const used = Number(usage[0]?.bytes_used ?? 0);
  if (!Number.isFinite(used) || used + additionalBytes > MAX_LEGACY_OWNER_BYTES) {
    reject(413, "storage_quota_exceeded", "Your saved application data has reached its storage limit", table);
  }
}
