import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import type { RequestContext } from "../types.js";
import { keyedHash, newId } from "../security/crypto.js";
import { emitDbChange } from "../realtime/events.js";
import { writeAudit } from "./audit.js";
import { allowedForumScopes, canUseForumScope, forumSegment } from "../security/forumScope.js";
import { enrichForumPosts, forumPostMediaHandles, hiddenForumPostIds, redactAnonymousPostForViewer } from "./forum.js";
import { contentTombstone } from "../security/tombstone.js";
import { normalizeHttpUrl, normalizeSocialLinks, serializeProfile } from "./profile.js";
import { instituteDomains } from "./functions.js";
import { assertOwnedReadyObject } from "./storage.js";
import { applyProfileEntryModeration, moderationReferenceDefinitions, type CatalogOption, type ModeratedProfileTable } from "./moderation.js";
import { forumAppSyncChannels, isCanonicalRealtimeRecordId } from "../realtime/appsyncChannels.js";
import { createForumPostsWithSlowMode } from "./forumSlowMode.js";
import { activeDailyRoomNamesForUser, closeDailySessionsForRooms, revokeDailyUserRooms, type ClosedDailySessions } from "./daily.js";

type Args = Record<string, unknown>;
type Row = Record<string, unknown>;
const nowIso = (): string => new Date().toISOString();
const isAdmin = (ctx: RequestContext): boolean => ctx.auth.role === "admin" || ctx.auth.role === "owner";

function emitClosedDailySessions(closed: ClosedDailySessions, actorId: string): void {
  for (const row of closed.participants) {
    emitDbChange({ table: "call_participants", event: "UPDATE", row, actor_id: actorId, room: `room-${String(row.room_id ?? "")}` });
  }
  for (const row of closed.sessions) {
    emitDbChange({ table: "call_sessions", event: "UPDATE", row, actor_id: actorId, room: `room-${String(row.room_id ?? "")}` });
  }
}

interface VerifiedAffiliationInput {
  userId: string;
  iitName: string;
  studentStatus: string;
  source: "email" | "document";
  sourceSubmissionId?: string;
  education?: { id: string; degree: string; specialisation: string; passingYear: string };
}

export function buildVerifiedAffiliation(base: Row | undefined, input: VerifiedAffiliationInput): Row {
  const now = nowIso();
  return {
    ...(base ?? {}),
    id: typeof base?.id === "string" ? base.id : newId(),
    user_id: input.userId,
    network_id: "IIT",
    institute_id: forumSegment(input.iitName),
    institute_name: input.iitName,
    student_status: input.studentStatus,
    member_status: input.studentStatus,
    verification_status: "VERIFIED",
    verification_source: input.source,
    source_submission_id: input.sourceSubmissionId ?? base?.source_submission_id ?? null,
    ...(input.education ? {
      degree_id: forumSegment(input.education.degree),
      degree_name: input.education.degree,
      specialisation_id: forumSegment(input.education.specialisation),
      specialisation_name: input.education.specialisation,
      graduation_year: Number(input.education.passingYear),
      source_education_id: input.education.id,
    } : {}),
    verified_at: base?.verified_at ?? now,
    updated_at: now,
    created_at: base?.created_at ?? now,
  };
}

function text(args: Args, key: string, options: { required?: boolean; max?: number } = {}): string {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (options.required && !value) throw new ApiError(400, "invalid_argument", `${key} is required`);
  if (options.max && value.length > options.max) throw new ApiError(400, "invalid_argument", `${key} is too long`);
  return value;
}

function integer(args: Args, key: string, fallback: number, max = 500): number {
  const value = Number(args[key] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new ApiError(400, "invalid_argument", `${key} must be a non-negative integer`);
  return Math.min(value, max);
}

async function legacyRows(table: string, limit = 2000): Promise<Array<Row & { __legacy_id: string }>> {
  const records = await prisma.legacyRecord.findMany({ where: { table_name: table }, orderBy: { created_at: "desc" }, take: limit });
  return records.map((record) => ({ ...(record.data as Row), __legacy_id: record.id }));
}

async function legacyRowsForUser(table: string, userId: string): Promise<Array<Row & { __legacy_id: string }>> {
  const records = await prisma.legacyRecord.findMany({
    where: {
      table_name: table,
      OR: [
        { owner_id: userId },
        { data: { path: "$.user_id", equals: userId } },
      ],
    },
    orderBy: { created_at: "desc" },
  });
  return records.map((record) => ({ ...(record.data as Row), __legacy_id: record.id }));
}

async function legacyRowsByJsonValues(table: string, column: string, values: string[]): Promise<Array<Row & { __legacy_id: string }>> {
  const unique = [...new Set(values.filter(Boolean))];
  if (!unique.length) return [];
  const output: Array<Row & { __legacy_id: string }> = [];
  for (let offset = 0; offset < unique.length; offset += 250) {
    const chunk = unique.slice(offset, offset + 250);
    const records = await prisma.legacyRecord.findMany({ where: {
      table_name: table,
      OR: chunk.map((value) => ({ data: { path: `$.${column}`, equals: value } })),
    }, orderBy: { created_at: "desc" } });
    output.push(...records.map((record) => ({ ...(record.data as Row), __legacy_id: record.id })));
  }
  return output;
}

async function createLegacy(table: string, data: Row, owner_id?: string, community_id?: string, recordKey?: string): Promise<Row> {
  const row: Row = { ...data, id: typeof data.id === "string" ? data.id : newId(), created_at: data.created_at ?? nowIso(), updated_at: data.updated_at ?? nowIso() };
  await prisma.legacyRecord.create({ data: { table_name: table, record_id: recordKey ?? String(row.id), owner_id, community_id, data: row as Prisma.InputJsonValue } });
  const eventRow = table === "messages" ? contentTombstone(row) : row;
  emitDbChange({ table, event: "INSERT", row: eventRow, actor_id: owner_id, room: typeof row.room_id === "string" ? row.room_id : undefined });
  return row;
}

async function replaceLegacy(table: string, legacyId: string, row: Row, actorId?: string): Promise<Row> {
  const { __legacy_id: _ignored, ...clean } = row;
  clean.updated_at = nowIso();
  await prisma.legacyRecord.update({ where: { id: legacyId }, data: { data: clean as Prisma.InputJsonValue } });
  const output = table === "messages" ? contentTombstone(clean) : clean;
  emitDbChange({ table, event: "UPDATE", row: output, actor_id: actorId, room: typeof clean.room_id === "string" ? clean.room_id : undefined });
  return output;
}

function notificationRecord(userId: string, title: string, message: string, type: string, link?: string, extra: Row = {}) {
  const row: Row = {
    id: newId(), user_id: userId, title, message, type, link: link ?? null, is_read: false,
    ...extra, created_at: nowIso(), updated_at: nowIso(),
  };
  return {
    row,
    data: {
      table_name: "notifications", record_id: String(row.id), owner_id: userId,
      data: row as Prisma.InputJsonValue,
    },
  };
}

function emitNotification(row: Row, actorId?: string): void {
  emitDbChange({ table: "notifications", event: "INSERT", row, actor_id: actorId, audience_ids: [String(row.user_id)] });
}

async function notify(userId: string, title: string, message: string, type: string, link?: string, extra: Row = {}): Promise<void> {
  const notification = notificationRecord(userId, title, message, type, link, extra);
  await prisma.legacyRecord.create({ data: notification.data });
  emitNotification(notification.row);
}

async function profileFor(userId: string) {
  return prisma.profile.findUnique({ where: { user_id: userId } });
}

async function requireVerified(ctx: RequestContext): Promise<void> {
  if (!ctx.auth.is_verified && !isAdmin(ctx)) throw new ApiError(403, "verification_required", "Verified membership is required");
}

async function canAccessScope(ctx: RequestContext, scopeType: string, scopeKey: string): Promise<boolean> {
  return canUseForumScope(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role, scopeType, scopeKey);
}

async function profileState(ctx: RequestContext): Promise<Row | null> {
  return serializeProfile(await profileFor(ctx.auth.id) as unknown as Row | null);
}

async function academicIdentity(ctx: RequestContext): Promise<Row | null> {
  const affiliations = await legacyRowsForUser("verified_academic_affiliations", ctx.auth.id);
  return affiliations.find((row) => row.user_id === ctx.auth.id && row.verification_status === "VERIFIED") ?? null;
}

async function saveAccountDetails(args: Args, ctx: RequestContext): Promise<null> {
  const name = text(args, "p_name", { required: true, max: 160 });
  if (name.length < 2) throw new ApiError(400, "invalid_name", "A valid full name is required");
  const country = text(args, "p_phone_country_code", { max: 8 });
  const phoneDigits = text(args, "p_phone", { max: 24 }).replace(/\D/g, "");
  if (phoneDigits.length !== 10) throw new ApiError(400, "invalid_phone", "A valid 10-digit phone number is required");
  if (!/^\+[0-9]{1,4}$/.test(country)) throw new ApiError(400, "invalid_country_code", "Choose a valid country code");
  const phone = `${country}${phoneDigits}`;
  try {
    await prisma.$transaction([
      prisma.profile.upsert({ where: { user_id: ctx.auth.id }, create: { user_id: ctx.auth.id, name, phone_country_code: country, phone_number: phoneDigits, phone_full: phone, community_id: ctx.auth.community_id }, update: { name, phone_country_code: country, phone_number: phoneDigits, phone_full: phone } }),
      prisma.user.update({ where: { id: ctx.auth.id }, data: { phone } }),
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new ApiError(409, "phone_in_use", "This phone number is already linked to another account");
    throw error;
  }
  return null;
}

async function completeOnboarding(args: Args, ctx: RequestContext): Promise<string> {
  const name = text(args, "p_name", { required: true, max: 160 });
  const iit = text(args, "p_iit_name", { required: true, max: 160 });
  const degree = text(args, "p_degree", { required: true, max: 160 });
  const specialisation = text(args, "p_specialisation", { required: true, max: 160 });
  const year = text(args, "p_passing_year", { required: true, max: 4 });
  if (name.length < 2 || degree.length < 2 || specialisation.length < 2) throw new ApiError(400, "invalid_onboarding_details", "Name, course, and specialisation are required");
  if (!/^\d{4}$/.test(year)) throw new ApiError(400, "invalid_year", "Passing year must be four digits");
  const suppliedPhone = text(args, "p_phone", { max: 24 }).replace(/\D/g, "");
  const suppliedCountry = text(args, "p_phone_country_code", { max: 8 });
  if (suppliedPhone && suppliedPhone.length !== 10) throw new ApiError(400, "invalid_phone", "Enter a valid 10-digit phone number");
  if (suppliedPhone && !/^\+[0-9]{1,4}$/.test(suppliedCountry)) throw new ApiError(400, "invalid_country_code", "Choose a valid country code");
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${ctx.auth.id} LIMIT 1 FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT user_id FROM profiles WHERE user_id = ${ctx.auth.id} LIMIT 1 FOR UPDATE`);
      const profile = await tx.profile.findUnique({ where: { user_id: ctx.auth.id } });
      if (!profile?.is_verified || profile.iit_name?.trim().toLowerCase() !== iit.toLowerCase()
        || !new Set(["current_student", "alumni"]).has(profile.student_status ?? "")) {
        throw new ApiError(403, "verified_identity_required", "Verified institute identity required");
      }
      if (profile.verification_revoked_at) {
        throw new ApiError(403, "verification_revoked", "Your institute verification was revoked by an administrator");
      }
      if (profile.onboarding_completed) {
        throw new ApiError(409, "onboarding_already_completed", "Verified academic onboarding can only be completed once");
      }
      const phoneDigits = suppliedPhone || profile.phone_number || "";
      const country = suppliedCountry || profile.phone_country_code || "";
      if (phoneDigits.length !== 10 || !/^\+[0-9]{1,4}$/.test(country)) throw new ApiError(400, "verified_phone_required", "A valid phone number is required before completing your profile");
      const phone = `${country}${phoneDigits}`;

      const educationRecords = await tx.legacyRecord.findMany({ where: { table_name: "education", owner_id: ctx.auth.id }, orderBy: { created_at: "desc" }, take: 100 });
      const trustedEducation = educationRecords.map((record) => record.data as Row).find((row) => row.is_verified === true
        && (row.approval_status === "approved" || row.approval_status == null));
      if (trustedEducation) {
        const matchesTrusted = String(trustedEducation.institution ?? "").trim().toLowerCase() === iit.toLowerCase()
          && String(trustedEducation.degree ?? "").trim().toLowerCase() === degree.toLowerCase()
          && String(trustedEducation.branch_area ?? "").trim().toLowerCase() === specialisation.toLowerCase()
          && String(trustedEducation.passing_year ?? "").trim() === year;
        if (!matchesTrusted) {
          throw new ApiError(409, "verified_academic_identity_conflict", "Existing verified academic details require administrator review before they can be changed");
        }
      }
      const existingEducation = educationRecords.find((record) => String((record.data as Row).institution ?? "").trim().toLowerCase() === iit.toLowerCase());
      const educationId = existingEducation ? String((existingEducation.data as Row).id) : newId();
      const education: Row = {
        ...(existingEducation?.data as Row | undefined ?? {}), id: educationId, user_id: ctx.auth.id, institution: iit,
        degree, branch_area: specialisation, passing_year: year, is_verified: true, approval_status: "approved", updated_at: nowIso(),
        created_at: (existingEducation?.data as Row | undefined)?.created_at ?? nowIso(),
      };
      if (existingEducation) await tx.legacyRecord.update({ where: { id: existingEducation.id }, data: { data: education as Prisma.InputJsonValue } });
      else await tx.legacyRecord.create({ data: { table_name: "education", record_id: educationId, owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: education as Prisma.InputJsonValue } });

      const social = profile.social_links && typeof profile.social_links === "object" && !Array.isArray(profile.social_links) ? profile.social_links as Row : {};
      const linkedin = text(args, "p_linkedin", { max: 1000 });
      const location = text(args, "p_location", { max: 255 });
      await tx.profile.update({ where: { user_id: ctx.auth.id }, data: {
        name, location: location || null, phone_country_code: country, phone_number: phoneDigits, phone_full: phone,
        social_links: normalizeSocialLinks({ ...social, ...(linkedin ? { linkedin: normalizeHttpUrl(linkedin, "LinkedIn URL") } : {}) }) as Prisma.InputJsonValue,
        primary_education_id: educationId, onboarding_completed: true,
      } });
      await tx.user.update({ where: { id: ctx.auth.id }, data: { phone } });

      const affiliationRecord = await tx.legacyRecord.findUnique({
        where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: ctx.auth.id } },
      });
      const affiliation = buildVerifiedAffiliation(affiliationRecord?.data as Row | undefined, {
        userId: ctx.auth.id,
        iitName: iit,
        studentStatus: profile.student_status!,
        source: (affiliationRecord?.data as Row | undefined)?.verification_source === "document" ? "document" : "email",
        education: { id: educationId, degree, specialisation, passingYear: year },
      });
      await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: ctx.auth.id } },
        create: { table_name: "verified_academic_affiliations", record_id: ctx.auth.id, owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: affiliation as Prisma.InputJsonValue },
        update: { owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: affiliation as Prisma.InputJsonValue },
      });

      const company = text(args, "p_company", { max: 255 });
      if (company) {
        const experience = await tx.legacyRecord.findMany({ where: { table_name: "professional_experience", owner_id: ctx.auth.id }, take: 100 });
        const duplicate = experience.some((record) => {
          const row = record.data as Row;
          return row.is_current === true && String(row.company_name ?? "").trim().toLowerCase() === company.toLowerCase();
        });
        if (!duplicate) {
          const id = newId();
          await tx.legacyRecord.create({ data: { table_name: "professional_experience", record_id: id, owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: { id, user_id: ctx.auth.id, company_name: company, is_current: true, created_at: nowIso(), updated_at: nowIso() } } });
        }
      }
      await tx.legacyRecord.deleteMany({ where: { table_name: "onboarding_progress", owner_id: ctx.auth.id } });
      return educationId;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new ApiError(409, "phone_in_use", "This phone number is already linked to another account");
    throw error;
  }
}

const pairKey = (a: string, b: string): string => [a, b].sort().join(":");

export const CONNECTION_WEEKLY_LIMIT = 50;
export const CONNECTION_PENDING_LIMIT = 100;
export const CONNECTION_RETRY_COOLDOWN_MS = 21 * 24 * 60 * 60_000;

export function assertConnectionRequestPolicy(input: {
  recentInvitationCount: number;
  pendingInvitationCount: number;
  existing?: { status: string; created_at: Date } | null;
  now?: Date;
}): void {
  if (input.recentInvitationCount >= CONNECTION_WEEKLY_LIMIT) {
    throw new ApiError(429, "connection_weekly_limit", "Weekly invitation limit reached. Try again later");
  }
  if (input.pendingInvitationCount >= CONNECTION_PENDING_LIMIT) {
    throw new ApiError(429, "connection_pending_limit", "Resolve outstanding invitations before sending more");
  }
  if (input.existing?.status === "accepted") throw new ApiError(409, "connection_exists", "You are already connected");
  if (input.existing?.status === "pending") throw new ApiError(409, "connection_exists", "A connection request is already pending");
  if (input.existing) {
    const now = input.now ?? new Date();
    const retryAt = new Date(input.existing.created_at.getTime() + CONNECTION_RETRY_COOLDOWN_MS);
    if (retryAt > now) {
      throw new ApiError(429, "connection_retry_cooldown", "Wait 21 days before inviting this member again", {
        retry_after_seconds: Math.ceil((retryAt.getTime() - now.getTime()) / 1000),
        retry_after_at: retryAt.toISOString(),
      });
    }
  }
}

async function sendConnection(args: Args, ctx: RequestContext) {
  await requireVerified(ctx);
  const peerId = text(args, "p_receiver_id", { required: true });
  if (peerId === ctx.auth.id) throw new ApiError(400, "self_connection", "You cannot connect with yourself");
  const peer = await prisma.profile.findUnique({ where: { user_id: peerId } });
  if (!peer?.is_verified || peer.community_id !== ctx.auth.community_id) throw new ApiError(404, "member_not_found", "The member is unavailable");
  const key = pairKey(ctx.auth.id, peerId);
  const note = text(args, "p_note", { max: 200 }) || null;
  const sender = await profileFor(ctx.auth.id);
  const result = await prisma.$transaction(async (tx) => {
    const [firstUserId, secondUserId] = [ctx.auth.id, peerId].sort();
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${firstUserId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${secondUserId} FOR UPDATE`);
    const now = new Date();
    const [recentInvitationCount, pendingInvitationCount, existing] = await Promise.all([
      tx.connection.count({ where: { requester_id: ctx.auth.id, created_at: { gt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) } } }),
      tx.connection.count({ where: { requester_id: ctx.auth.id, status: "pending" } }),
      tx.connection.findUnique({ where: { pair_key: key } }),
    ]);
    assertConnectionRequestPolicy({ recentInvitationCount, pendingInvitationCount, existing, now });
    const connection = existing
      ? await tx.connection.update({ where: { id: existing.id }, data: {
        requester_id: ctx.auth.id, receiver_id: peerId, status: "pending", note, responded_at: null, created_at: now,
      } })
      : await tx.connection.create({ data: { requester_id: ctx.auth.id, receiver_id: peerId, pair_key: key, note, created_at: now } });
    const notification = notificationRecord(
      peerId,
      "New connection request",
      `${sender?.name?.trim() || "A Cirkle member"} would like to connect with you.`,
      "connection_request",
      "/network?tab=pending",
      { entity_id: connection.id },
    );
    await tx.legacyRecord.create({ data: notification.data });
    return { connection, notification: notification.row, event: existing ? "UPDATE" as const : "INSERT" as const };
  });
  emitNotification(result.notification, ctx.auth.id);
  emitDbChange({ table: "connections", event: result.event, row: result.connection as unknown as Row, actor_id: ctx.auth.id });
  return result.connection;
}

async function respondConnection(args: Args, ctx: RequestContext) {
  await requireVerified(ctx);
  const id = text(args, "p_connection_id") || text(args, "p_request_id", { required: true });
  const action = args.p_accept === true ? "accept" : args.p_accept === false ? "decline" : text(args, "p_action", { required: true }).toLowerCase();
  const status = action === "accept" || action === "accepted" ? "accepted" : action === "decline" || action === "declined" || action === "reject" ? "declined" : "";
  if (!status) throw new ApiError(400, "invalid_connection_action", "Action must be accept or decline");
  const receiver = await profileFor(ctx.auth.id);
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.connection.updateMany({
      where: { id, receiver_id: ctx.auth.id, status: "pending" },
      data: { status, responded_at: new Date() },
    });
    if (changed.count !== 1) throw new ApiError(404, "connection_not_pending", "Pending connection not found");
    const updated = await tx.connection.findUnique({ where: { id } });
    if (!updated) throw new ApiError(404, "connection_not_pending", "Pending connection not found");
    const accepted = status === "accepted";
    const notification = notificationRecord(
      updated.requester_id,
      accepted ? "Connection request accepted" : "Connection request declined",
      `${receiver?.name?.trim() || "A Cirkle member"} ${accepted ? "accepted" : "declined"} your connection request.`,
      "connection_response",
      accepted ? "/network?tab=connected" : "/network?tab=pending",
      { entity_id: updated.id, connection_status: status },
    );
    await tx.legacyRecord.create({ data: notification.data });
    return { updated, notification: notification.row };
  });
  emitNotification(result.notification, ctx.auth.id);
  emitDbChange({ table: "connections", event: "UPDATE", row: result.updated as unknown as Row, actor_id: ctx.auth.id });
  return result.updated;
}

async function withdrawConnection(args: Args, ctx: RequestContext) {
  await requireVerified(ctx);
  const id = text(args, "p_connection_id") || text(args, "p_request_id", { required: true });
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.connection.updateMany({
      where: { id, requester_id: ctx.auth.id, status: "pending" },
      data: { status: "withdrawn", responded_at: new Date() },
    });
    if (changed.count !== 1) throw new ApiError(404, "connection_not_pending", "Pending connection not found");
    const updated = await tx.connection.findUnique({ where: { id } });
    if (!updated) throw new ApiError(404, "connection_not_pending", "Pending connection not found");
    const candidates = await tx.legacyRecord.findMany({ where: {
      table_name: "notifications", owner_id: updated.receiver_id,
      data: { path: "$.entity_id", equals: id },
    } });
    const removed = candidates.filter((record) => {
      const row = record.data as Row;
      return row.type === "connection_request" && row.is_read !== true;
    });
    if (removed.length) await tx.legacyRecord.deleteMany({ where: { id: { in: removed.map((record) => record.id) } } });
    return { updated, removed: removed.map((record) => record.data as Row) };
  });
  for (const notification of result.removed) {
    emitDbChange({ table: "notifications", event: "DELETE", row: notification, actor_id: ctx.auth.id, audience_ids: [String(notification.user_id)] });
  }
  emitDbChange({ table: "connections", event: "UPDATE", row: result.updated as unknown as Row, actor_id: ctx.auth.id });
  return result.updated;
}

async function searchConnections(args: Args, ctx: RequestContext): Promise<Row[]> {
  await requireVerified(ctx);
  const query = text(args, "p_query", { max: 160 }).toLowerCase();
  const limit = integer(args, "p_limit", 20, 50);
  const connections = await prisma.connection.findMany({ where: { status: "accepted", OR: [{ requester_id: ctx.auth.id }, { receiver_id: ctx.auth.id }] }, take: 500 });
  const peerIds = connections.map((row) => row.requester_id === ctx.auth.id ? row.receiver_id : row.requester_id);
  const profiles = await prisma.profile.findMany({
    where: { user_id: { in: peerIds }, ...(query ? { OR: [{ name: { contains: query } }, { headline: { contains: query } }] } : {}) },
    select: { user_id: true, name: true, slug: true, avatar_url: true, headline: true, location: true, iit_name: true },
    take: limit,
  });
  return profiles.map((profile) => ({
    user_id: profile.user_id,
    peer_id: profile.user_id,
    name: profile.name,
    slug: profile.slug,
    avatar_url: profile.avatar_url,
    headline: profile.headline,
    location: profile.location,
    iit_name: profile.iit_name,
    connection_id: connections.find((row) => row.requester_id === profile.user_id || row.receiver_id === profile.user_id)?.id,
  }));
}

async function createForumPost(args: Args, ctx: RequestContext) {
  await requireVerified(ctx);
  const scopeType = text(args, "p_scope_type", { required: true, max: 40 }).toUpperCase();
  const scopeKey = text(args, "p_scope_key", { max: 255 }) || text(args, "p_scope_id", { required: true, max: 255 });
  if (!(await canAccessScope(ctx, scopeType, scopeKey))) throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
  const content = text(args, "p_content", { max: 20_000 });
  const requestedIdInput = text(args, "p_id");
  if (requestedIdInput && !isCanonicalRealtimeRecordId(requestedIdInput.toLowerCase())) {
    throw new ApiError(400, "invalid_post_id", "Forum post IDs must use canonical UUID format");
  }
  const requestedId = requestedIdInput ? requestedIdInput.toLowerCase() : "";
  const clientId = text(args, "p_client_id", { max: 100 }) || requestedId || undefined;
  if (clientId || requestedId) {
    const existing = requestedId ? await prisma.post.findUnique({ where: { id: requestedId } }) : await prisma.post.findFirst({ where: { author_id: ctx.auth.id, client_id: clientId } });
    if (existing && existing.author_id !== ctx.auth.id) throw new ApiError(409, "post_id_conflict", "Post ID is already in use");
    if (existing) return (await enrichForumPosts([existing], ctx))[0];
  }
  const ownedPath = async (key: string, bucket: string): Promise<string | null> => {
    const value = text(args, key);
    if (!value) return null;
    if (!value.startsWith(`${ctx.auth.id}/`) || value.includes("..") || value.includes("\\")) throw new ApiError(400, "invalid_media_path", `${key} must be an uploaded object owned by the current user`);
    return assertOwnedReadyObject(bucket, value, ctx.auth.id);
  };
  const [imagePath, mediaPath, filePath, voicePath] = await Promise.all([
    ownedPath("p_image_path", "post-images"),
    ownedPath("p_media_path", "post-images"),
    ownedPath("p_file_path", "forum-files"),
    ownedPath("p_voice_path", "voice-notes"),
  ]);
  const mediaUrlInput = text(args, "p_media_url");
  const fileUrlInput = text(args, "p_file_url");
  const voiceUrlInput = text(args, "p_voice_url");
  const mediaUrl = mediaUrlInput ? normalizeHttpUrl(mediaUrlInput, "Forum media URL") : null;
  const fileUrl = fileUrlInput ? normalizeHttpUrl(fileUrlInput, "Forum file URL") : null;
  const voiceUrl = voiceUrlInput ? normalizeHttpUrl(voiceUrlInput, "Forum voice URL") : null;
  if (!content && !imagePath && !mediaPath && !filePath && !voicePath && !mediaUrl) throw new ApiError(400, "post_content_required", "Message content or media is required");
  const replyToId = text(args, "p_reply_to_id") || null;
  if (replyToId) {
    const [parent, hidden] = await Promise.all([
      prisma.post.findUnique({ where: { id: replyToId }, select: { scope_type: true, scope_key: true, reply_to_id: true, deleted_at: true, is_deleted_for_everyone: true } }),
      hiddenForumPostIds(ctx.auth.id),
    ]);
    if (!parent || parent.deleted_at || parent.is_deleted_for_everyone || hidden.includes(replyToId) || parent.reply_to_id || parent.scope_type !== scopeType || parent.scope_key !== scopeKey) {
      throw new ApiError(400, "invalid_reply_target", "Reply target must be a visible top-level post in the same forum scope");
    }
  }
  const postData: Prisma.PostUncheckedCreateInput = {
    ...(requestedId ? { id: requestedId } : {}), author_id: ctx.auth.id, content, community_id: ctx.auth.community_id, scope_type: scopeType, scope_key: scopeKey,
    channel: text(args, "p_channel", { max: 40 }) || null, is_anonymous: args.p_is_anonymous === true,
    reply_to_id: replyToId, client_id: clientId,
    media_url: mediaUrl, media_type: text(args, "p_media_type", { max: 80 }) || null,
    media_path: mediaPath, media_metadata: (args.p_media_metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    image_path: imagePath,
    file_url: fileUrl, file_path: filePath, file_name: text(args, "p_file_name", { max: 255 }) || null,
    file_size: args.p_file_size == null ? null : BigInt(integer(args, "p_file_size", 0, 20 * 1024 * 1024)),
    file_type: text(args, "p_file_type", { max: 160 }) || null, voice_url: voiceUrl,
    voice_path: voicePath, voice_duration: args.p_voice_duration == null ? null : integer(args, "p_voice_duration", 0, 60 * 60),
  };
  const [post] = await createForumPostsWithSlowMode([postData], ctx.auth);
  if (!post) throw new ApiError(500, "post_create_failed", "The forum post could not be created");
  const output = (await enrichForumPosts([post], ctx))[0]!;
  const realtime = redactAnonymousPostForViewer(output, "", "member", await forumPostMediaHandles([post]));
  emitDbChange({ table: "posts", event: "INSERT", row: realtime, actor_id: ctx.auth.id, room: `forum:${scopeType}:${scopeKey}` });
  return output;
}

async function forumPostById(args: Args, ctx: RequestContext): Promise<Row> {
  await requireVerified(ctx);
  const postId = text(args, "p_post_id", { required: true, max: 100 });
  const [post, hidden] = await Promise.all([
    prisma.post.findUnique({ where: { id: postId } }),
    hiddenForumPostIds(ctx.auth.id),
  ]);
  if (!post || post.deleted_at || hidden.includes(post.id)
    || !(await canAccessScope(ctx, post.scope_type, post.scope_key))) {
    throw new ApiError(404, "post_not_found", "The forum post is unavailable");
  }
  const [enriched] = await enrichForumPosts([post], ctx);
  if (!enriched) throw new ApiError(404, "post_not_found", "The forum post is unavailable");
  return enriched;
}

function forumCursor(args: Args, direction: "before" | "after"): Prisma.PostWhereInput | undefined {
  const dateValue = text(args, direction === "before" ? "p_before_created_at" : "p_after_created_at");
  if (!dateValue) return undefined;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, "invalid_forum_cursor", "The forum cursor timestamp is invalid");
  const id = text(args, direction === "before" ? "p_before_id" : "p_after_id");
  if (direction === "before") {
    return id ? { OR: [{ created_at: { lt: date } }, { created_at: date, id: { lt: id } }] } : { created_at: { lt: date } };
  }
  return id ? { OR: [{ created_at: { gt: date } }, { created_at: date, id: { gt: id } }] } : { created_at: { gt: date } };
}

async function forumPage(args: Args, ctx: RequestContext, thread = false, direction: "before" | "after" = "before"): Promise<Row[]> {
  await requireVerified(ctx);
  const limit = integer(args, "p_limit", 50, 100);
  const scopeType = text(args, "p_scope_type", { max: 40 }).toUpperCase();
  const scopeKey = text(args, "p_scope_key", { max: 255 }) || text(args, "p_scope_id", { max: 255 });
  if (!thread && (!(scopeType && scopeKey) || !(await canAccessScope(ctx, scopeType, scopeKey)))) throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
  const parentId = text(args, "p_parent_id") || text(args, "p_post_id");
  const hidden = await hiddenForumPostIds(ctx.auth.id);
  if (thread) {
    if (!parentId) throw new ApiError(400, "parent_post_required", "A parent post is required");
    const parent = await prisma.post.findUnique({ where: { id: parentId }, select: { author_id: true, scope_type: true, scope_key: true, deleted_at: true, is_deleted_for_everyone: true } });
    if (!parent || parent.deleted_at || parent.is_deleted_for_everyone || hidden.includes(parentId) || (parent.author_id !== ctx.auth.id && !(await canAccessScope(ctx, parent.scope_type, parent.scope_key)))) {
      throw new ApiError(404, "post_not_found", "The forum thread is unavailable");
    }
  }
  const cursor = forumCursor(args, direction);
  const rows = await prisma.post.findMany({
    where: {
      deleted_at: null,
      ...(thread ? { reply_to_id: parentId } : { scope_type: scopeType, scope_key: scopeKey, reply_to_id: null }),
      ...(hidden.length ? { id: { notIn: hidden } } : {}),
      ...(cursor ? { AND: [cursor] } : {}),
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }], take: limit,
  });
  return enrichForumPosts(rows, ctx);
}

async function searchForum(args: Args, ctx: RequestContext): Promise<Row[]> {
  await requireVerified(ctx);
  const query = text(args, "p_query", { max: 200 });
  const kind = text(args, "p_kind", { max: 20 }) || "messages";
  if (!["messages", "media", "links", "pins"].includes(kind)) throw new ApiError(400, "invalid_search_kind", "Unsupported forum search kind");
  const scopeType = text(args, "p_scope_type", { max: 40 }).toUpperCase();
  const scopeKey = text(args, "p_scope_key", { max: 255 }) || text(args, "p_scope_id", { max: 255 });
  if ((scopeType || scopeKey) && (!(scopeType && scopeKey) || !(await canAccessScope(ctx, scopeType, scopeKey)))) throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
  const scopes = scopeType && scopeKey ? [{ scope_type: scopeType, scope_key: scopeKey }] : await allowedForumScopes(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role);
  const access: Prisma.PostWhereInput = scopeType && scopeKey
    ? { scope_type: scopeType, scope_key: scopeKey }
    : { OR: [...scopes, { author_id: ctx.auth.id }] };
  const hidden = await hiddenForumPostIds(ctx.auth.id);
  const cursor = forumCursor(args, "before");
  const pinnedIds = kind === "pins" ? (await legacyRowsForUser("user_pinned_messages", ctx.auth.id)).flatMap((row) => row.user_id === ctx.auth.id && typeof row.message_id === "string" ? [row.message_id] : []) : [];
  const kindFilter: Prisma.PostWhereInput = kind === "media"
    ? { OR: [{ image_path: { not: null } }, { image_url: { not: null } }, { voice_path: { not: null } }, { voice_url: { not: null } }] }
    : kind === "links" ? { OR: [{ content: { contains: "http://" } }, { content: { contains: "https://" } }] }
      : kind === "pins" ? { OR: [{ pinned_at: { not: null } }, ...(pinnedIds.length ? [{ id: { in: pinnedIds } }] : [])] }
        : {};
  const textFilter: Prisma.PostWhereInput = query ? {
    OR: [{ content: { contains: query } }, { is_anonymous: false, author: { profile: { is: { name: { contains: query } } } } }],
  } : {};
  const rows = await prisma.post.findMany({ where: {
    deleted_at: null,
    is_deleted_for_everyone: false,
    ...(hidden.length ? { id: { notIn: hidden } } : {}),
    AND: [
      access,
      textFilter,
      kindFilter,
      ...(cursor ? [cursor] : []),
    ],
  }, orderBy: [{ created_at: "desc" }, { id: "desc" }], take: integer(args, "p_limit", 50, 100) });
  return enrichForumPosts(rows, ctx);
}

async function getRoomState(args: Args, ctx: RequestContext): Promise<Row[]> {
  const type = text(args, "p_scope_type", { required: true });
  const key = text(args, "p_scope_key", { required: true });
  if (!(await canAccessScope(ctx, type, key))) throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
  const rows = await legacyRowsForUser("forum_room_state", ctx.auth.id);
  const row = rows.find((item) => item.user_id === ctx.auth.id && item.scope_type === type && item.scope_key === key);
  return row ? [{ draft: row.draft ?? "", scroll_offset: row.scroll_offset ?? 0, last_read_at: row.last_read_at ?? null, notification_level: row.notification_level ?? "all" }] : [];
}

async function saveRoomState(args: Args, ctx: RequestContext, markRead = false): Promise<null> {
  const type = text(args, "p_scope_type", { required: true });
  const key = text(args, "p_scope_key", { required: true });
  if (!(await canAccessScope(ctx, type, key))) throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
  const rows = await legacyRowsForUser("forum_room_state", ctx.auth.id);
  const existing = rows.find((item) => item.user_id === ctx.auth.id && item.scope_type === type && item.scope_key === key);
  const next: Row = {
    ...(existing ?? {}), user_id: ctx.auth.id, scope_type: type, scope_key: key,
    draft: markRead ? existing?.draft ?? "" : text(args, "p_draft", { max: 4000 }),
    scroll_offset: markRead ? existing?.scroll_offset ?? 0 : integer(args, "p_scroll_offset", 0, 10_000_000),
    last_read_at: markRead ? nowIso() : existing?.last_read_at ?? null,
    notification_level: existing?.notification_level ?? "all",
  };
  if (existing) await replaceLegacy("forum_room_state", String(existing.__legacy_id), next, ctx.auth.id);
  else await createLegacy("forum_room_state", next, ctx.auth.id, ctx.auth.community_id, `${ctx.auth.id}:${type}:${key}`);
  return null;
}

async function forumUnread(ctx: RequestContext): Promise<Row[]> {
  await requireVerified(ctx);
  const states = await legacyRowsForUser("forum_room_state", ctx.auth.id);
  const scopes = await allowedForumScopes(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role);
  const output: Row[] = [];
  for (const scope of scopes) {
    const state = states.find((row) => row.scope_type === scope.scope_type && row.scope_key === scope.scope_key);
    const count = await prisma.post.count({ where: { scope_type: scope.scope_type, scope_key: scope.scope_key, deleted_at: null, author_id: { not: ctx.auth.id }, ...(state?.last_read_at ? { created_at: { gt: new Date(String(state.last_read_at)) } } : {}) } });
    output.push({ ...scope, has_unread: count > 0 });
  }
  return output;
}

async function directChat(args: Args, ctx: RequestContext): Promise<string> {
  await requireVerified(ctx);
  const peerId = text(args, "p_peer_id", { required: true });
  const connection = await prisma.connection.findUnique({ where: { pair_key: pairKey(ctx.auth.id, peerId) } });
  if (!connection || connection.status !== "accepted") throw new ApiError(403, "connection_required", "An accepted connection is required for direct chat");
  const key = `direct:${pairKey(ctx.auth.id, peerId)}`;
  const existing = await prisma.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "chat_rooms", record_id: key } } });
  if (existing) return String((existing.data as Row).id);
  const roomId = newId();
  try {
    await prisma.$transaction([
      prisma.legacyRecord.create({ data: { table_name: "chat_rooms", record_id: key, community_id: ctx.auth.community_id, data: { id: roomId, name: null, is_group: false, direct_key: pairKey(ctx.auth.id, peerId), created_by: ctx.auth.id, created_at: nowIso(), updated_at: nowIso() } } }),
      prisma.legacyRecord.create({ data: { table_name: "chat_members", record_id: `${roomId}:${ctx.auth.id}`, owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: { id: newId(), room_id: roomId, user_id: ctx.auth.id, joined_at: nowIso(), last_read_at: nowIso() } } }),
      prisma.legacyRecord.create({ data: { table_name: "chat_members", record_id: `${roomId}:${peerId}`, owner_id: peerId, community_id: ctx.auth.community_id, data: { id: newId(), room_id: roomId, user_id: peerId, joined_at: nowIso(), last_read_at: null } } }),
    ]);
    return roomId;
  } catch (error) {
    const raced = await prisma.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "chat_rooms", record_id: key } } });
    if (raced) return String((raced.data as Row).id);
    throw error;
  }
}

async function chatMembership(userId: string): Promise<Row[]> {
  const records = await prisma.legacyRecord.findMany({ where: { table_name: "chat_members", owner_id: userId } });
  return records.map((record) => ({ ...(record.data as Row), __legacy_id: record.id }));
}

type LatestMessageKey = { id: string; room_id: string };
type UnreadRoomCount = { room_id: string; unread_count: bigint | number | string };

async function chatInboxMessageSummary(roomIds: string[], userId: string): Promise<{
  latestByRoom: Map<string, Row>;
  unreadByRoom: Map<string, number>;
}> {
  const latestByRoom = new Map<string, Row>();
  const unreadByRoom = new Map<string, number>();
  for (let offset = 0; offset < roomIds.length; offset += 1000) {
    const chunk = roomIds.slice(offset, offset + 1000);
    if (!chunk.length) continue;
    const [latestKeys, unreadCounts] = await Promise.all([
      prisma.$queryRaw<LatestMessageKey[]>(Prisma.sql`
        SELECT ranked.id, ranked.room_id
        FROM (
          SELECT id,
            JSON_UNQUOTE(JSON_EXTRACT(data, '$.room_id')) AS room_id,
            ROW_NUMBER() OVER (
              PARTITION BY JSON_UNQUOTE(JSON_EXTRACT(data, '$.room_id'))
              ORDER BY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.created_at')), CAST(created_at AS CHAR)) DESC,
                COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.id')), id) DESC
            ) AS row_rank
          FROM legacy_records
          WHERE table_name = 'messages'
            AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.room_id')) IN (${Prisma.join(chunk)})
            AND COALESCE(JSON_CONTAINS(JSON_EXTRACT(data, '$.deleted_for_users'), JSON_QUOTE(${userId})), 0) = 0
        ) AS ranked
        WHERE ranked.row_rank = 1
      `),
      prisma.$queryRaw<UnreadRoomCount[]>(Prisma.sql`
        SELECT JSON_UNQUOTE(JSON_EXTRACT(messages.data, '$.room_id')) AS room_id,
          COUNT(*) AS unread_count
        FROM legacy_records AS messages
        INNER JOIN legacy_records AS membership
          ON membership.table_name = 'chat_members'
          AND membership.owner_id = ${userId}
          AND JSON_UNQUOTE(JSON_EXTRACT(membership.data, '$.room_id')) = JSON_UNQUOTE(JSON_EXTRACT(messages.data, '$.room_id'))
        WHERE messages.table_name = 'messages'
          AND JSON_UNQUOTE(JSON_EXTRACT(messages.data, '$.room_id')) IN (${Prisma.join(chunk)})
          AND JSON_UNQUOTE(JSON_EXTRACT(messages.data, '$.sender_id')) <> ${userId}
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(messages.data, '$.created_at')), '')
            > COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(membership.data, '$.last_read_at')), 'null'), '')
          AND COALESCE(JSON_CONTAINS(JSON_EXTRACT(messages.data, '$.deleted_for_users'), JSON_QUOTE(${userId})), 0) = 0
        GROUP BY JSON_UNQUOTE(JSON_EXTRACT(messages.data, '$.room_id'))
      `),
    ]);
    const records = latestKeys.length ? await prisma.legacyRecord.findMany({ where: { id: { in: latestKeys.map((item) => item.id) } } }) : [];
    const recordById = new Map(records.map((record) => [record.id, contentTombstone(record.data as Row)]));
    for (const key of latestKeys) {
      const row = recordById.get(key.id);
      if (row) latestByRoom.set(key.room_id, row);
    }
    for (const item of unreadCounts) unreadByRoom.set(item.room_id, Math.max(0, Number(item.unread_count) || 0));
  }
  return { latestByRoom, unreadByRoom };
}

async function chatInbox(ctx: RequestContext): Promise<Row[]> {
  await requireVerified(ctx);
  const memberships = await chatMembership(ctx.auth.id);
  const roomIds = memberships.flatMap((membership) => typeof membership.room_id === "string" ? [membership.room_id] : []);
  const [rooms, summary] = await Promise.all([
    legacyRowsByJsonValues("chat_rooms", "id", roomIds),
    chatInboxMessageSummary(roomIds, ctx.auth.id),
  ]);
  const roomById = new Map(rooms.map((room) => [String(room.id), room]));
  return memberships.map((membership) => {
    const roomId = String(membership.room_id);
    return { ...(roomById.get(roomId) ?? { id: roomId }), room_id: roomId,
      last_message: summary.latestByRoom.get(roomId) ?? null,
      unread_count: summary.unreadByRoom.get(roomId) ?? 0 };
  });
}

async function directSidebar(ctx: RequestContext): Promise<Row[]> {
  const inbox = await chatInbox(ctx);
  const connections = await prisma.connection.findMany({ where: { status: "accepted", OR: [{ requester_id: ctx.auth.id }, { receiver_id: ctx.auth.id }] } });
  const profiles = await prisma.profile.findMany({ where: { user_id: { in: connections.map((row) => row.requester_id === ctx.auth.id ? row.receiver_id : row.requester_id) } } });
  return connections.flatMap((connection) => {
    const peerId = connection.requester_id === ctx.auth.id ? connection.receiver_id : connection.requester_id;
    const profile = profiles.find((row) => row.user_id === peerId);
    const key = pairKey(ctx.auth.id, peerId);
    const room = inbox.find((row) => row.direct_key === key);
    if (!room?.room_id || !room.last_message) return [];
    return [{ connection_id: connection.id, peer_id: peerId, room_id: room.room_id, display_name: profile?.name ?? "Member", display_avatar: profile?.avatar_url ?? null, last_message: room.last_message, unread_count: room.unread_count ?? 0 }];
  });
}

async function markChatRead(args: Args, ctx: RequestContext): Promise<null> {
  await requireVerified(ctx);
  const roomId = text(args, "p_room_id", { required: true });
  const membershipRecord = await prisma.legacyRecord.findFirst({ where: {
    table_name: "chat_members", owner_id: ctx.auth.id,
    data: { path: "$.room_id", equals: roomId },
  } });
  const membership = membershipRecord?.data as Row | undefined;
  if (!membershipRecord || !membership) throw new ApiError(403, "chat_membership_required", "Chat membership is required");
  const readAt = nowIso();
  const updatedMembership = { ...membership, last_read_at: readAt, updated_at: readAt };
  await prisma.legacyRecord.update({ where: { id: membershipRecord.id }, data: { data: updatedMembership as Prisma.InputJsonValue } });
  emitDbChange({ table: "chat_members", event: "UPDATE", row: updatedMembership, actor_id: ctx.auth.id, room: roomId });

  // Read state is persisted once on the membership cursor. Emit bounded,
  // derived message updates so currently connected senders still see receipts
  // without rewriting every historical message or racing content edits.
  const recentInbound = await prisma.legacyRecord.findMany({ where: {
    table_name: "messages",
    NOT: { owner_id: ctx.auth.id },
    data: { path: "$.room_id", equals: roomId },
  }, orderBy: { created_at: "desc" }, take: 100 });
  for (const record of recentInbound) {
    const message = contentTombstone(record.data as Row);
    if (Array.isArray(message.deleted_for_users) && message.deleted_for_users.includes(ctx.auth.id)) continue;
    const readBy = new Set(Array.isArray(message.read_by) ? message.read_by as string[] : []);
    readBy.add(ctx.auth.id);
    emitDbChange({ table: "messages", event: "UPDATE", row: { ...message, read_by: [...readBy], read_at: message.read_at ?? readAt },
      actor_id: ctx.auth.id, room: roomId });
  }
  return null;
}

async function getAdminUsers(args: Args, ctx: RequestContext): Promise<Row[]> {
  if (!isAdmin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required");
  const users = await prisma.user.findMany({ include: { profile: true }, orderBy: { created_at: "desc" }, take: integer(args, "p_limit", 500, 1000) });
  return users.map((user) => ({ user_id: user.id, name: user.profile?.name, login_email: user.email, phone_full: user.phone, iit_email: user.profile?.iit_email, iit_name: user.profile?.iit_name, student_status: user.profile?.student_status, is_verified: user.profile?.is_verified, onboarding_completed: user.profile?.onboarding_completed, role: user.role, location: user.profile?.location, headline: user.profile?.headline, avatar_url: user.profile?.avatar_url, created_at: user.created_at, last_sign_in_at: user.last_login_at }));
}

const indiaDay = (value: Date | string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const daySeries = (days: number): string[] => Array.from({ length: days }, (_, index) => indiaDay(new Date(Date.now() - (days - index - 1) * 86_400_000)));

async function adminAnalytics(args: Args, ctx: RequestContext): Promise<Row> {
  if (ctx.auth.role !== "owner") throw new ApiError(403, "owner_required", "Platform owner access is required");
  const days = Math.max(7, integer(args, "p_days", 30, 90));
  const since7 = new Date(Date.now() - 7 * 86_400_000);
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const today = indiaDay(new Date());
  const [users, profiles, posts, applications, jobs, events, connections, reports, messages, activity, documents, courses, consultations, rsvps] = await Promise.all([
    prisma.user.findMany({ select: { id: true, created_at: true } }),
    prisma.profile.findMany({ select: { user_id: true, is_verified: true, onboarding_completed: true, is_mentor: true, iit_name: true, student_status: true } }),
    prisma.post.findMany({ select: { created_at: true } }),
    prisma.application.findMany({ select: { created_at: true } }),
    prisma.job.findMany({ select: { status: true, expires_at: true } }),
    prisma.event.findMany({ select: { status: true, start_time: true } }),
    prisma.connection.findMany({ select: { status: true } }),
    prisma.report.findMany({ select: { status: true } }),
    legacyRows("messages", 50_000), legacyRows("user_activity_daily", 50_000),
    legacyRows("document_verifications", 10_000), legacyRows("course_verification_requests", 10_000),
    legacyRows("consultations", 10_000), prisma.rsvp.findMany({ select: { created_at: true } }),
  ]);
  const asDate = (value: unknown): Date => new Date(String(value));
  const recent = (value: unknown, since: Date): boolean => asDate(value).getTime() >= since.getTime();
  const countBy = (values: Array<string | null>, fallback: string, limit?: number): Row[] => {
    const counts = new Map<string, number>();
    for (const value of values) { const label = value?.trim() || fallback; counts.set(label, (counts.get(label) ?? 0) + 1); }
    return [...counts].map(([label, value]) => ({ label, value })).sort((a, b) => Number(b.value) - Number(a.value) || String(a.label).localeCompare(String(b.label))).slice(0, limit);
  };
  const daily = daySeries(days).map((day) => {
    const dayActivity = activity.filter((row) => row.activity_date === day);
    const forum = posts.filter((row) => indiaDay(row.created_at) === day).length;
    const direct = messages.filter((row) => indiaDay(String(row.created_at)) === day).length;
    return {
      day,
      registrations: users.filter((row) => indiaDay(row.created_at) === day).length,
      active_users: new Set(dayActivity.map((row) => row.user_id)).size,
      sessions: dayActivity.reduce((total, row) => total + Number(row.session_count ?? 0), 0),
      forum_messages: forum, direct_messages: direct, messages: forum + direct,
      applications: applications.filter((row) => indiaDay(row.created_at) === day).length,
    };
  });
  const offsets = [1, 2, 3, 7, 14, 30];
  const activeKeys = new Set(activity.map((row) => `${row.user_id}:${row.activity_date}`));
  const retention = offsets.map((day) => {
    const eligibleUsers = users.filter((user) => Math.floor((Date.now() - user.created_at.getTime()) / 86_400_000) >= day);
    const returned = eligibleUsers.filter((user) => activeKeys.has(`${user.id}:${indiaDay(new Date(user.created_at.getTime() + day * 86_400_000))}`)).length;
    return { day, eligible: eligibleUsers.length, returned, rate: eligibleUsers.length ? Math.round(returned / eligibleUsers.length * 1000) / 10 : 0 };
  });
  const forumToday = posts.filter((row) => indiaDay(row.created_at) === today).length;
  const directToday = messages.filter((row) => indiaDay(String(row.created_at)) === today).length;
  const summary = {
    total_users: users.length,
    registrations_today: users.filter((row) => indiaDay(row.created_at) === today).length,
    registrations_7d: users.filter((row) => row.created_at >= since7).length,
    registrations_30d: users.filter((row) => row.created_at >= since30).length,
    verified_users: profiles.filter((row) => row.is_verified).length,
    onboarding_completed: profiles.filter((row) => row.onboarding_completed).length,
    mentors: profiles.filter((row) => row.is_mentor).length,
    active_users_today: new Set(activity.filter((row) => row.activity_date === today).map((row) => row.user_id)).size,
    active_users_7d: new Set(activity.filter((row) => String(row.activity_date) >= indiaDay(since7)).map((row) => row.user_id)).size,
    active_users_30d: new Set(activity.filter((row) => String(row.activity_date) >= indiaDay(since30)).map((row) => row.user_id)).size,
    sessions_today: activity.filter((row) => row.activity_date === today).reduce((total, row) => total + Number(row.session_count ?? 0), 0),
    page_views_today: activity.filter((row) => row.activity_date === today).reduce((total, row) => total + Number(row.page_view_count ?? 0), 0),
    forum_messages_today: forumToday, direct_messages_today: directToday,
    forum_messages_7d: posts.filter((row) => row.created_at >= since7).length,
    direct_messages_7d: messages.filter((row) => recent(row.created_at, since7)).length,
    messages_7d: posts.filter((row) => row.created_at >= since7).length + messages.filter((row) => recent(row.created_at, since7)).length,
    messages_30d: posts.filter((row) => row.created_at >= since30).length + messages.filter((row) => recent(row.created_at, since30)).length,
    messages_total: posts.length + messages.length,
    pending_connections: connections.filter((row) => row.status === "pending").length,
    accepted_connections: connections.filter((row) => row.status === "accepted").length,
    open_reports: reports.filter((row) => row.status === "open").length,
    pending_documents: documents.filter((row) => row.status === "pending").length,
    pending_courses: courses.filter((row) => row.status === "pending").length,
    published_jobs: jobs.filter((row) => row.status === "published" && (!row.expires_at || row.expires_at > new Date())).length,
    applications_today: applications.filter((row) => indiaDay(row.created_at) === today).length,
    applications_7d: applications.filter((row) => row.created_at >= since7).length,
    upcoming_events: events.filter((row) => row.status === "published" && row.start_time >= new Date()).length,
    rsvps_30d: rsvps.filter((row) => row.created_at >= since30).length,
    pending_consultations: consultations.filter((row) => row.status === "pending").length,
    completed_consultations: consultations.filter((row) => row.status === "completed").length,
    consultation_revenue: consultations.filter((row) => row.status === "completed").reduce((total, row) => total + Number(row.amount ?? 0), 0),
  };
  return { generated_at: nowIso(), timezone: "Asia/Kolkata", summary, daily, retention, top_iits: countBy(profiles.map((row) => row.iit_name), "Not specified", 8), member_status: countBy(profiles.map((row) => row.student_status), "not specified") };
}

async function logClientError(args: Args, ctx: RequestContext): Promise<string> {
  const id = text(args, "p_event_id") || newId();
  const redact = (value: string): string => value.replace(/Bearer\s+[\w.-]+/gi, "Bearer [REDACTED]").replace(/(token|password|secret)=\S+/gi, "$1=[REDACTED]");
  await createLegacy("client_error_logs", {
    id, user_id: ctx.auth.id, flow: text(args, "p_flow", { max: 80 }), action: text(args, "p_action", { max: 120 }),
    severity: text(args, "p_severity", { max: 20 }) || "error", message: redact(text(args, "p_message", { max: 2000 })),
    error_code: text(args, "p_error_code", { max: 120 }) || null, stack: redact(text(args, "p_stack", { max: 8000 })),
    route: text(args, "p_route", { max: 500 }) || null, metadata: args.p_metadata ?? {}, client_timestamp: args.p_client_timestamp ?? null,
  }, ctx.auth.id, ctx.auth.community_id);
  return id;
}

async function recordActivity(args: Args, ctx: RequestContext): Promise<null> {
  const sessionId = text(args, "p_session_id", { required: true, max: 100 });
  if (sessionId.length < 8) throw new ApiError(400, "invalid_activity_session", "Activity session must contain at least 8 characters");
  const path = text(args, "p_path", { max: 500 }) || text(args, "p_route", { max: 500 }) || null;
  const now = nowIso();
  const day = indiaDay(new Date());
  const sessionKey = `${ctx.auth.id}:${sessionId}`;
  const dailyKey = `${ctx.auth.id}:${day}`;
  await prisma.$transaction(async (tx) => {
    const session = await tx.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "user_activity_sessions", record_id: sessionKey } } });
    const isNew = !session;
    if (session) {
      const current = session.data as Row;
      await tx.legacyRecord.update({ where: { id: session.id }, data: { data: { ...current, last_seen_at: now, last_path: path } as Prisma.InputJsonValue } });
    } else {
      await tx.legacyRecord.create({ data: { table_name: "user_activity_sessions", record_id: sessionKey, owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: { user_id: ctx.auth.id, session_id: sessionId, started_at: now, last_seen_at: now, last_path: path } } });
    }
    const daily = await tx.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "user_activity_daily", record_id: dailyKey } } });
    if (daily) {
      const current = daily.data as Row;
      await tx.legacyRecord.update({ where: { id: daily.id }, data: { data: { ...current, last_seen_at: now, session_count: Number(current.session_count ?? 0) + (isNew ? 1 : 0), page_view_count: Number(current.page_view_count ?? 0) + 1 } as Prisma.InputJsonValue } });
    } else {
      await tx.legacyRecord.create({ data: { table_name: "user_activity_daily", record_id: dailyKey, owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: { user_id: ctx.auth.id, activity_date: day, first_seen_at: now, last_seen_at: now, session_count: 1, page_view_count: 1 } } });
    }
  });
  return null;
}

async function recordJobEngagement(args: Args, ctx: RequestContext): Promise<null> {
  const rawEvent = text(args, "p_event_name", { max: 40 }) || text(args, "p_event_type", { required: true, max: 40 });
  const aliases: Record<string, string> = { view: "job_view_click", open: "job_view_click", apply: "job_easy_apply_click", save: "job_save", filter: "job_filter" };
  const eventName = aliases[rawEvent] ?? rawEvent;
  if (!new Set(["jobs_page_view", "job_view_click", "job_easy_apply_click", "job_save", "job_unsave", "job_filter"]).has(eventName)) throw new ApiError(400, "invalid_event_type", "Unsupported job engagement type");
  const sessionId = text(args, "p_session_id", { required: true, max: 100 });
  if (sessionId.length < 8) throw new ApiError(400, "invalid_analytics_session", "Job analytics session must contain at least 8 characters");
  const jobId = text(args, "p_job_id") || null;
  if (jobId && !(await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } }))) throw new ApiError(400, "unknown_job", "Unknown job");
  await createLegacy("job_engagement_events", { user_id: ctx.auth.id, job_id: jobId, event_name: eventName, session_id: sessionId, metadata: args.p_metadata ?? {} }, ctx.auth.id, ctx.auth.community_id);
  return null;
}

async function adminJobAnalytics(args: Args, ctx: RequestContext): Promise<Row> {
  if (ctx.auth.role !== "owner") throw new ApiError(403, "owner_required", "Platform owner access is required");
  const days = Math.max(1, integer(args, "p_days", 30, 90));
  const since = new Date(Date.now() - days * 86_400_000);
  const events = (await legacyRows("job_engagement_events", 50_000)).filter((row) => new Date(String(row.created_at)).getTime() >= since.getTime());
  const eventName = (row: Row): string => String(row.event_name ?? row.event_type ?? "");
  const count = (name: string): number => events.filter((row) => eventName(row) === name).length;
  const pageViews = events.filter((row) => eventName(row) === "jobs_page_view");
  const jobIds = [...new Set(events.flatMap((row) => typeof row.job_id === "string" ? [row.job_id] : []))];
  const jobs = await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true, company: true } });
  const byJob = jobs.map((job) => {
    const related = events.filter((row) => row.job_id === job.id);
    return {
      ...job,
      view_job_clicks: related.filter((row) => eventName(row) === "job_view_click").length,
      easy_apply_clicks: related.filter((row) => eventName(row) === "job_easy_apply_click").length,
      saves: related.filter((row) => eventName(row) === "job_save").length,
    };
  }).sort((a, b) => (b.view_job_clicks + b.easy_apply_clicks) - (a.view_job_clicks + a.easy_apply_clicks) || b.saves - a.saves).slice(0, 10);
  const companyCounts = new Map<string, number>();
  for (const job of jobs) {
    const value = events.filter((row) => row.job_id === job.id && ["job_view_click", "job_easy_apply_click"].includes(eventName(row))).length;
    if (value) companyCounts.set(job.company, (companyCounts.get(job.company) ?? 0) + value);
  }
  const dailyGroups = new Map<string, Row[]>();
  for (const event of events) { const day = indiaDay(String(event.created_at)); dailyGroups.set(day, [...dailyGroups.get(day) ?? [], event]); }
  const daily = [...dailyGroups].filter(([day]) => day).sort(([a], [b]) => a.localeCompare(b)).map(([day, rows]) => ({
    day,
    page_views: rows.filter((row) => eventName(row) === "jobs_page_view").length,
    unique_visitors: new Set(rows.filter((row) => eventName(row) === "jobs_page_view").map((row) => row.user_id)).size,
    view_job_clicks: rows.filter((row) => eventName(row) === "job_view_click").length,
    easy_apply_clicks: rows.filter((row) => eventName(row) === "job_easy_apply_click").length,
    saves: rows.filter((row) => eventName(row) === "job_save").length,
  }));
  return {
    generated_at: nowIso(), days,
    summary: {
      page_views: pageViews.length,
      unique_visitors: new Set(pageViews.map((row) => row.user_id)).size,
      unique_sessions: new Set(pageViews.map((row) => row.session_id)).size,
      view_job_clicks: count("job_view_click"), easy_apply_clicks: count("job_easy_apply_click"),
      saves: count("job_save"), unsaves: count("job_unsave"), filter_uses: count("job_filter"),
    },
    daily,
    top_jobs: byJob,
    top_companies: [...companyCounts].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 10),
  };
}

export const customOptionCategories = new Set(["institution", "degree", "branch", "company", "location", "mentor_category"]);

async function customOption(args: Args, ctx: RequestContext, fieldMode = false): Promise<Row[]> {
  const category = fieldMode ? text(args, "p_field", { required: true }) : text(args, "p_category", { required: true });
  if (!(fieldMode ? new Set(["location", "mentor_category"]) : customOptionCategories).has(category)) throw new ApiError(400, "invalid_category", "Unsupported option category");
  const value = text(args, "p_value", { required: true, max: 120 });
  if (value.length < 2) throw new ApiError(400, "invalid_option", "Value must contain at least two characters");
  const options = await legacyRows("custom_options");
  let option: Row | undefined = options.find((row) => row.category === category && String(row.value).toLowerCase() === value.toLowerCase());
  const logoInput = text(args, "p_logo_url");
  const logoUrl = logoInput ? normalizeHttpUrl(logoInput, "Option logo URL") : null;
  if (option && option.status === "rejected" && (option.created_by === ctx.auth.id || option.submitted_by === ctx.auth.id)) {
    option = await replaceLegacy("custom_options", String(option.__legacy_id), {
      ...option, status: "pending", logo_url: logoUrl ?? option.logo_url ?? null,
      reviewed_by: null, reviewed_at: null,
    }, ctx.auth.id);
  }
  if (!option) option = await createLegacy("custom_options", { category, value, logo_url: logoUrl, status: "pending", created_by: ctx.auth.id, submitted_by: ctx.auth.id }, ctx.auth.id, ctx.auth.community_id);
  if (!option) throw new ApiError(500, "option_create_failed", "Could not create the option");
  if (fieldMode) {
    const pending = (await legacyRowsForUser("pending_profile_options", ctx.auth.id)).find((row) => row.user_id === ctx.auth.id && (row.field === category || row.field_name === category));
    const pendingRow = { ...(pending ?? {}), user_id: ctx.auth.id, field: category, option_id: option.id, value, status: option.status };
    if (pending) await replaceLegacy("pending_profile_options", String(pending.__legacy_id), pendingRow, ctx.auth.id);
    else await createLegacy("pending_profile_options", pendingRow, ctx.auth.id, ctx.auth.community_id, `${ctx.auth.id}:${category}`);
  }
  return [{ option_id: option.id, option_status: option.status, option_value: option.value, option_logo_url: option.logo_url ?? null }];
}

async function reviewCustomOption(args: Args, ctx: RequestContext, optionRow: Row): Promise<Row> {
  const legacyId = String(optionRow.__legacy_id);
  const decision = text(args, "p_decision") || text(args, "p_status");
  if (!new Set(["approved", "rejected"]).has(decision)) throw new ApiError(400, "invalid_decision", "Decision must be approved or rejected");
  const value = text(args, "p_value", { max: 120 }) || String(optionRow.value ?? "");
  if (value.length < 2) throw new ApiError(400, "invalid_option", "Value must contain at least two characters");
  const requestedLogo = text(args, "p_logo_url");
  const logoUrl = requestedLogo ? normalizeHttpUrl(requestedLogo, "Option logo URL") : optionRow.logo_url ?? null;
  const now = nowIso();
  const { __legacy_id: _legacyId, ...storedOption } = optionRow;
  const updatedOption: Row = {
    ...storedOption, value, logo_url: logoUrl, status: decision,
    reviewed_by: ctx.auth.id, reviewed_at: now, updated_at: now,
  };
  const changedEntries: Array<{ table: string; row: Row }> = [];

  await prisma.$transaction(async (tx) => {
    await tx.legacyRecord.update({ where: { id: legacyId }, data: { data: updatedOption as Prisma.InputJsonValue } });
    const optionRecords = await tx.legacyRecord.findMany({ where: { table_name: "custom_options" }, take: 5000 });
    const catalog: CatalogOption[] = optionRecords.flatMap((record) => {
      const row = record.id === legacyId ? updatedOption : record.data as Row;
      return typeof row.id === "string" && typeof row.category === "string" && typeof row.value === "string"
        && new Set(["pending", "approved", "rejected"]).has(String(row.status))
        ? [{ id: row.id, category: row.category, value: row.value, status: row.status as CatalogOption["status"], owner_id: record.owner_id }]
        : [];
    });

    for (const table of ["education", "professional_experience"] as ModeratedProfileTable[]) {
      const records = await tx.legacyRecord.findMany({ where: { table_name: table }, take: 5000 });
      for (const record of records) {
        const current = record.data as Row;
        const matching = moderationReferenceDefinitions(table).filter((reference) => current[reference.option] === updatedOption.id);
        if (!matching.length) continue;
        const canonical = { ...current };
        for (const reference of matching) canonical[reference.value] = value;
        if (table === "professional_experience" && matching.some((reference) => reference.category === "company") && logoUrl) canonical.logo_url = logoUrl;
        const next = { ...applyProfileEntryModeration(table, canonical, catalog, record.owner_id ?? ""), updated_at: now };
        await tx.legacyRecord.update({ where: { id: record.id }, data: { data: next as Prisma.InputJsonValue } });
        changedEntries.push({ table, row: next });
      }
    }

    const pending = await tx.legacyRecord.findMany({ where: { table_name: "pending_profile_options" }, take: 5000 });
    for (const record of pending) {
      const row = record.data as Row;
      if (row.option_id !== updatedOption.id) continue;
      const field = row.field === "location" || row.field === "mentor_category" ? row.field : undefined;
      const pendingUserId = record.owner_id ?? (typeof row.user_id === "string" ? row.user_id : undefined);
      if (decision === "approved" && field && pendingUserId) {
        await tx.profile.updateMany({ where: { user_id: pendingUserId }, data: { [field]: value } });
        await tx.legacyRecord.delete({ where: { id: record.id } });
      } else {
        await tx.legacyRecord.update({ where: { id: record.id }, data: { data: { ...row, value, status: decision, updated_at: now } as Prisma.InputJsonValue } });
      }
    }
    await tx.auditLog.create({ data: {
      actor_id: ctx.auth.id, action: `catalog.option_${decision}`, resource_type: "custom_option",
      resource_id: String(updatedOption.id), ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined,
      metadata: { category: String(updatedOption.category ?? ""), value },
    } });
  });

  emitDbChange({ table: "custom_options", event: "UPDATE", row: updatedOption, actor_id: ctx.auth.id });
  for (const changed of changedEntries) emitDbChange({ table: changed.table, event: "UPDATE", row: changed.row, actor_id: ctx.auth.id });
  return updatedOption;
}

async function reviewCourseVerification(args: Args, ctx: RequestContext, requestRow: Row): Promise<Row> {
  const decision = text(args, "p_decision") || text(args, "p_status");
  const notes = text(args, "p_notes", { max: 2000 }) || null;
  if (!new Set(["approved", "rejected"]).has(decision)) throw new ApiError(400, "invalid_decision", "Decision must be approved or rejected");
  if (decision === "rejected" && !notes) throw new ApiError(400, "rejection_reason_required", "A rejection reason is required");
  if (requestRow.status !== "pending") throw new ApiError(409, "submission_already_reviewed", "This course request is no longer pending");
  const legacyId = String(requestRow.__legacy_id);
  const { __legacy_id: _legacyId, ...stored } = requestRow;
  const updated: Row = { ...stored, status: decision, review_notes: notes, reviewed_by: ctx.auth.id, reviewed_at: nowIso(), updated_at: nowIso() };
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.legacyRecord.updateMany({
      where: { id: legacyId, data: { path: "$.status", equals: "pending" } },
      data: { data: updated as Prisma.InputJsonValue },
    });
    if (claimed.count !== 1) throw new ApiError(409, "submission_already_reviewed", "This course request was already reviewed");
    await tx.auditLog.create({ data: {
      actor_id: ctx.auth.id, action: `verification.course_${decision}`, resource_type: "course_verification",
      resource_id: String(updated.id ?? ""), ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined,
    } });
  });
  emitDbChange({ table: "course_verification_requests", event: "UPDATE", row: updated, actor_id: ctx.auth.id,
    audience_ids: typeof updated.user_id === "string" ? [updated.user_id] : undefined });
  return updated;
}

async function requestConsultation(args: Args, ctx: RequestContext): Promise<Row> {
  await requireVerified(ctx);
  const consultantId = text(args, "p_consultant_id", { required: true });
  if (consultantId === ctx.auth.id) throw new ApiError(400, "self_consultation", "You cannot book yourself");
  const consultant = await profileFor(consultantId);
  if (!consultant?.is_verified || !consultant.is_mentor) throw new ApiError(404, "consultant_not_found", "Consultant is unavailable");
  const type = text(args, "p_consultation_type", { required: true });
  if (!new Set(["chat", "audio", "video"]).has(type)) throw new ApiError(400, "invalid_consultation_type", "Unsupported consultation type");
  const duration = integer(args, "p_duration_minutes", 30, 60);
  if (![15, 30, 45, 60].includes(duration)) throw new ApiError(400, "invalid_duration", "Duration must be 15, 30, 45, or 60 minutes");
  const price = type === "chat" ? consultant.mentor_price_chat : type === "audio" ? consultant.mentor_price_audio : consultant.mentor_price_video;
  const row = await createLegacy("consultations", { client_id: ctx.auth.id, consultant_id: consultantId, consultation_type: type, status: "pending", amount: price?.toString() ?? "0", duration_minutes: duration, scheduled_at: args.p_scheduled_at ?? null, notes: text(args, "p_notes", { max: 2000 }) || null, chat_room_id: null }, ctx.auth.id, ctx.auth.community_id);
  await notify(consultantId, "New consultation request", "You received a consultation request.", "consultation", "/consult");
  return row;
}

export function assertConsultationTransition(
  current: unknown,
  next: unknown,
  actor: { isConsultant: boolean; isAdmin: boolean },
): asserts next is "confirmed" | "completed" | "cancelled" {
  if (!new Set(["confirmed", "completed", "cancelled"]).has(String(next))) {
    throw new ApiError(400, "invalid_status", "Unsupported consultation status");
  }
  if (!new Set(["pending", "confirmed", "completed", "cancelled"]).has(String(current))) {
    throw new ApiError(409, "invalid_consultation_state", "Consultation is in an invalid state");
  }
  if (current === "completed" || current === "cancelled") {
    throw new ApiError(409, "consultation_terminal", "Completed and cancelled consultations cannot be changed");
  }
  if (next === "confirmed" || next === "completed") {
    if (!actor.isConsultant && !actor.isAdmin) {
      throw new ApiError(403, "consultant_required", `Only the consultant can ${next === "confirmed" ? "confirm" : "complete"} this request`);
    }
    if (next === "confirmed" && current !== "pending") {
      throw new ApiError(409, "invalid_consultation_transition", "Only a pending consultation can be confirmed");
    }
    if (next === "completed" && current !== "confirmed") {
      throw new ApiError(409, "invalid_consultation_transition", "Only a confirmed consultation can be completed");
    }
  }
}

async function changeConsultation(args: Args, ctx: RequestContext): Promise<Row> {
  await requireVerified(ctx);
  const id = text(args, "p_consultation_id", { required: true });
  const status = text(args, "p_status", { required: true });
  const updated = await prisma.$transaction(async (tx) => {
    const matches = await tx.$queryRaw<Array<{ id: string; data: Prisma.JsonValue }>>(Prisma.sql`
      SELECT id, data
      FROM legacy_records
      WHERE table_name = 'consultations' AND record_id = ${id}
      LIMIT 1
      FOR UPDATE
    `);
    const record = matches[0];
    const row = record?.data as Row | undefined;
    if (!record || !row || row.id !== id || (row.client_id !== ctx.auth.id && row.consultant_id !== ctx.auth.id && !isAdmin(ctx))) {
      throw new ApiError(404, "consultation_not_found", "Consultation not found");
    }
    assertConsultationTransition(row.status, status, { isConsultant: row.consultant_id === ctx.auth.id, isAdmin: isAdmin(ctx) });
    const next: Row = { ...row, status, updated_at: nowIso() };
    await tx.legacyRecord.update({ where: { id: record.id }, data: { data: next as Prisma.InputJsonValue } });
    return next;
  });
  emitDbChange({ table: "consultations", event: "UPDATE", row: updated, actor_id: ctx.auth.id,
    audience_ids: [String(updated.client_id), String(updated.consultant_id)] });
  const recipient = updated.client_id === ctx.auth.id ? String(updated.consultant_id) : String(updated.client_id);
  await notify(recipient, "Consultation updated", `Consultation status changed to ${status}.`, "consultation", "/consult");
  return updated;
}

async function reviewDocumentVerification(args: Args, ctx: RequestContext): Promise<Row> {
  if (!isAdmin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required");
  const submissionId = text(args, "p_submission_id", { required: true });
  const decision = text(args, "p_decision") || text(args, "p_status");
  const notes = text(args, "p_notes", { max: 2000 }) || null;
  if (!new Set(["approved", "rejected"]).has(decision)) throw new ApiError(400, "invalid_decision", "Decision must be approved or rejected");
  if (decision === "rejected" && !notes) throw new ApiError(400, "rejection_reason_required", "A rejection reason is required");

  const record = await prisma.legacyRecord.findFirst({ where: {
    table_name: "document_verifications",
    data: { path: "$.id", equals: submissionId },
  } });
  const row = record?.data as Row | undefined;
  if (!record || !row || row.status !== "pending") throw new ApiError(404, "submission_not_pending", "Pending submission not found");
  const userId = typeof row.user_id === "string" ? row.user_id : "";
  const iitName = typeof row.iit_name === "string" ? row.iit_name.trim() : "";
  const studentStatus = typeof row.student_status === "string" ? row.student_status : "";
  if (!userId || !instituteDomains[iitName] || !new Set(["current_student", "alumni"]).has(studentStatus)) {
    throw new ApiError(409, "invalid_verification_submission", "The submission has invalid institute identity data");
  }
  const reviewedAt = nowIso();
  const updated: Row = { ...row, status: decision, reviewed_by: ctx.auth.id, reviewed_at: reviewedAt, review_notes: notes, updated_at: reviewedAt };

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new ApiError(409, "invalid_verification_submission", "The submission member no longer exists");
    const claimed = await tx.legacyRecord.updateMany({
      where: { id: record.id, data: { path: "$.status", equals: "pending" } },
      data: { data: updated as Prisma.InputJsonValue },
    });
    if (claimed.count !== 1) throw new ApiError(409, "submission_already_reviewed", "This submission was already reviewed");
    if (decision === "approved") {
      await tx.profile.upsert({
        where: { user_id: userId },
        create: { user_id: userId, iit_name: iitName, student_status: studentStatus, is_verified: true, community_id: config.DEFAULT_COMMUNITY_ID },
        update: { iit_name: iitName, student_status: studentStatus, is_verified: true, verification_revoked_at: null, community_id: config.DEFAULT_COMMUNITY_ID },
      });
      const affiliationRecord = await tx.legacyRecord.findUnique({
        where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: userId } },
      });
      const affiliation = buildVerifiedAffiliation(affiliationRecord?.data as Row | undefined, {
        userId, iitName, studentStatus, source: "document", sourceSubmissionId: submissionId,
      });
      await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: userId } },
        create: { table_name: "verified_academic_affiliations", record_id: userId, owner_id: userId, community_id: config.DEFAULT_COMMUNITY_ID, data: affiliation as Prisma.InputJsonValue },
        update: { owner_id: userId, community_id: config.DEFAULT_COMMUNITY_ID, data: affiliation as Prisma.InputJsonValue },
      });
    }
    await tx.auditLog.create({ data: {
      actor_id: ctx.auth.id,
      action: `verification.document_${decision}`,
      resource_type: "document_verification",
      resource_id: submissionId,
      ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined,
      metadata: { user_id: userId, iit_name: iitName },
    } });
  });
  emitDbChange({ table: "document_verifications", event: "UPDATE", row: updated, actor_id: ctx.auth.id, audience_ids: [userId] });
  if (decision === "approved") {
    emitDbChange({
      table: "profiles", event: "UPDATE",
      row: { user_id: userId, iit_name: iitName, student_status: studentStatus, is_verified: true, force_reauthenticate: true },
      actor_id: ctx.auth.id, audience_ids: [userId],
    });
  }
  return updated;
}

async function reviewLegacy(name: string, args: Args, ctx: RequestContext): Promise<Row> {
  if (!isAdmin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required");
  const mapping: Record<string, { table: string; id: string }> = {
    review_course_verification: { table: "course_verification_requests", id: "p_request_id" },
    review_custom_option: { table: "custom_options", id: "p_option_id" },
  };
  const target = mapping[name]!;
  const id = text(args, target.id, { required: true });
  const record = await prisma.legacyRecord.findFirst({ where: {
    table_name: target.table,
    data: { path: "$.id", equals: id },
  } });
  const row = record ? { ...(record.data as Row), __legacy_id: record.id } : undefined;
  if (!row) throw new ApiError(404, "submission_not_found", "Submission not found");
  if (target.table === "custom_options") return reviewCustomOption(args, ctx, row);
  return reviewCourseVerification(args, ctx, row);
}

async function withdrawVerification(table: "document_verifications" | "course_verification_requests", id: string, ctx: RequestContext): Promise<Row> {
  const record = await prisma.legacyRecord.findFirst({ where: {
    table_name: table,
    owner_id: ctx.auth.id,
    data: { path: "$.id", equals: id },
  } });
  const row = record?.data as Row | undefined;
  if (!record || !row || row.user_id !== ctx.auth.id || row.status !== "pending") {
    throw new ApiError(404, "submission_not_found", "Pending submission not found");
  }
  const withdrawn = { ...row, status: "withdrawn", updated_at: nowIso() };
  const claimed = await prisma.legacyRecord.updateMany({
    where: { id: record.id, owner_id: ctx.auth.id, data: { path: "$.status", equals: "pending" } },
    data: { data: withdrawn as Prisma.InputJsonValue },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, "submission_already_reviewed", "This submission was reviewed before it could be withdrawn");
  }
  emitDbChange({ table, event: "UPDATE", row: withdrawn, actor_id: ctx.auth.id, audience_ids: [ctx.auth.id] });
  return withdrawn;
}

export async function callRpc(name: string, args: Args, ctx: RequestContext): Promise<unknown> {
  switch (name) {
    case "get_my_profile_state": return profileState(ctx);
    case "get_my_academic_identity": return academicIdentity(ctx);
    case "save_account_details": return saveAccountDetails(args, ctx);
    case "complete_member_onboarding": return completeOnboarding(args, ctx);
    case "send_connection_request": return sendConnection(args, ctx);
    case "respond_connection_request": return respondConnection(args, ctx);
    case "withdraw_connection_request": return withdrawConnection(args, ctx);
    case "search_my_connections": return searchConnections(args, ctx);
    case "create_forum_post": return createForumPost(args, ctx);
    case "get_forum_posts":
    case "get_forum_posts_page": return forumPage(args, ctx);
    case "get_forum_posts_after": return forumPage(args, ctx, false, "after");
    case "get_forum_thread_page": return forumPage(args, ctx, true);
    case "get_forum_post": return forumPostById(args, ctx);
    case "search_forum_posts": return searchForum(args, ctx);
    case "get_forum_room_state": return getRoomState(args, ctx);
    case "save_forum_room_state": return saveRoomState(args, ctx);
    case "mark_forum_scope_read": return saveRoomState(args, ctx, true);
    case "get_last_forum_room": return (await legacyRowsForUser("forum_room_state", ctx.auth.id)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null;
    case "get_my_forum_unread": return forumUnread(ctx);
    case "mark_forum_post_seen": return createLegacy("pinned_messages", { user_id: ctx.auth.id, message_id: text(args, "p_post_id", { required: true }), kind: "seen" }, ctx.auth.id, ctx.auth.community_id, `seen:${ctx.auth.id}:${text(args, "p_post_id")}`);
    case "get_or_create_direct_chat": return directChat(args, ctx);
    case "get_chat_inbox": return chatInbox(ctx);
    case "get_direct_message_sidebar": return directSidebar(ctx);
    case "mark_chat_read": return markChatRead(args, ctx);
    case "chat_broadcast_ready":
    case "forum_broadcast_ready": return true;
    case "get_appsync_forum_channels": {
      await requireVerified(ctx);
      const scopeType = text(args, "p_scope_type", { required: true, max: 40 }).toUpperCase();
      const scopeKey = text(args, "p_scope_key", { required: true, max: 255 });
      if (!(await canAccessScope(ctx, scopeType, scopeKey))) throw new ApiError(403, "forum_scope_denied", "Forum community access denied");
      return forumAppSyncChannels(scopeType, scopeKey);
    }
    case "is_platform_owner": return ctx.auth.role === "owner";
    case "get_admin_users_detailed": return getAdminUsers(args, ctx);
    case "get_admin_analytics": return adminAnalytics(args, ctx);
    case "get_admin_job_analytics": return adminJobAnalytics(args, ctx);
    case "grant_admin_role":
    case "revoke_admin_role": {
      if (ctx.auth.role !== "owner") throw new ApiError(403, "owner_required", "Platform owner access is required");
      const userId = text(args, "p_target_user_id", { required: true });
      if (userId === ctx.auth.id) throw new ApiError(400, "owner_role_immutable", "The owner role cannot be changed here");
      const role = name === "grant_admin_role" ? "admin" : "member";
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`);
        const [target, targetProfile] = await Promise.all([
          tx.user.findUnique({ where: { id: userId }, select: { role: true } }),
          tx.profile.findUnique({ where: { user_id: userId }, select: { is_verified: true } }),
        ]);
        if (!target) throw new ApiError(404, "member_not_found", "Member not found");
        if (target.role === "owner") throw new ApiError(400, "owner_role_immutable", "An owner role cannot be changed here");
        if (name === "revoke_admin_role" && target.role !== "admin") throw new ApiError(409, "role_changed", "The member is no longer an administrator");
        await tx.user.update({ where: { id: userId }, data: { role } });
        const profile = await tx.profile.updateMany({ where: { user_id: userId }, data: { role } });
        if (profile.count !== 1) throw new ApiError(409, "profile_missing", "The member profile is unavailable");
        const activeDailyRooms = name === "revoke_admin_role" && !targetProfile?.is_verified
          ? await activeDailyRoomNamesForUser(tx, userId)
          : [];
        const closedDaily = await closeDailySessionsForRooms(tx, activeDailyRooms, "admin_role_revoked");
        return { closedDaily };
      }, { timeout: 60_000 });
      emitDbChange({
        table: "profiles", event: "UPDATE",
        row: { user_id: userId, role, force_reauthenticate: true },
        actor_id: ctx.auth.id, audience_ids: [userId],
      });
      emitClosedDailySessions(result.closedDaily, ctx.auth.id);
      const dailyRevocation = await revokeDailyUserRooms(result.closedDaily.roomNames, userId, config.DAILY_API_KEY ?? "");
      await writeAudit({
        actor_id: ctx.auth.id, action: `admin.${name}`, resource_type: "user", resource_id: userId, ip: ctx.ip,
        metadata: { daily_revocation_failures: dailyRevocation.failed },
      });
      return {
        updated: true,
        daily_ejection_pending: dailyRevocation.failed > 0,
        daily_ejection_failures: dailyRevocation.failed,
        daily_revocation_pending: dailyRevocation.failed > 0,
        daily_revocation_failures: dailyRevocation.failed,
      };
    }
    case "set_member_verification": {
      if (!isAdmin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required");
      const userId = text(args, "p_target_user_id") || text(args, "p_user_id", { required: true });
      const value = args.p_verified === true || args.p_is_verified === true;
      const changedAt = new Date();
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE`);
        const target = await tx.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
        if (!target) throw new ApiError(404, "member_not_found", "Member not found");
        const profile = await tx.profile.update({
          where: { user_id: userId },
          data: { is_verified: value, verification_revoked_at: value ? null : changedAt },
        });
        const record = await tx.legacyRecord.findUnique({
          where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: userId } },
        });
        if (record) {
          const affiliation = record.data as Row;
          await tx.legacyRecord.update({ where: { id: record.id }, data: { data: {
            ...affiliation,
            verification_status: value ? "VERIFIED" : "REVOKED",
            ...(value ? { verified_at: changedAt.toISOString(), revoked_at: null, revoked_by: null }
              : { revoked_at: changedAt.toISOString(), revoked_by: ctx.auth.id }),
            updated_at: changedAt.toISOString(),
          } as Prisma.InputJsonValue } });
        }
        const remainsCallEligible = target.status === "active"
          && (value || target.role === "admin" || target.role === "owner");
        const activeDailyRooms = remainsCallEligible ? [] : await activeDailyRoomNamesForUser(tx, userId);
        const closedDaily = await closeDailySessionsForRooms(tx, activeDailyRooms, "verification_revoked");
        return { profile, closedDaily };
      }, { timeout: 60_000 });
      emitDbChange({
        table: "profiles", event: "UPDATE",
        row: { ...serializeProfile(result.profile as unknown as Row), force_reauthenticate: true },
        actor_id: ctx.auth.id, audience_ids: [userId],
      });
      emitClosedDailySessions(result.closedDaily, ctx.auth.id);
      const dailyRevocation = await revokeDailyUserRooms(result.closedDaily.roomNames, userId, config.DAILY_API_KEY ?? "");
      await writeAudit({
        actor_id: ctx.auth.id, action: "admin.set_member_verification", resource_type: "user", resource_id: userId, ip: ctx.ip,
        metadata: { is_verified: value, daily_revocation_failures: dailyRevocation.failed },
      });
      return {
        updated: true,
        daily_ejection_pending: dailyRevocation.failed > 0,
        daily_ejection_failures: dailyRevocation.failed,
        daily_revocation_pending: dailyRevocation.failed > 0,
        daily_revocation_failures: dailyRevocation.failed,
      };
    }
    case "log_client_error": return logClientError(args, ctx);
    case "record_user_activity": return recordActivity(args, ctx);
    case "record_job_engagement": return recordJobEngagement(args, ctx);
    case "submit_custom_option": return customOption(args, ctx);
    case "submit_profile_custom_value": return customOption(args, ctx, true);
    case "review_document_verification": return reviewDocumentVerification(args, ctx);
    case "review_course_verification":
    case "review_custom_option": return reviewLegacy(name, args, ctx);
    case "withdraw_document_verification":
    case "withdraw_course_verification": {
      const table = name.includes("document") ? "document_verifications" : "course_verification_requests";
      const id = text(args, name.includes("document") ? "p_submission_id" : "p_request_id", { required: true });
      return withdrawVerification(table, id, ctx);
    }
    case "request_consultation": return requestConsultation(args, ctx);
    case "change_consultation_status": return changeConsultation(args, ctx);
    case "prepare_profile_entry": return serializeProfile(await prisma.profile.upsert({ where: { user_id: ctx.auth.id }, create: { user_id: ctx.auth.id, community_id: ctx.auth.community_id }, update: {} }) as unknown as Row);
    default: throw new ApiError(501, "rpc_not_implemented", `RPC ${name} is not implemented by this backend`);
  }
}
