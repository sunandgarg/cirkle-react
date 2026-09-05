import path from "node:path";
import { Prisma, type LegacyRecord } from "@prisma/client";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { hashOtp, hashPassword, keyedHash, newId, randomOtp } from "../security/crypto.js";
import type { RequestContext } from "../types.js";
import { issueEmailOtp, normalizeEmail, requestPasswordReset, verifyAndReserveEmailOtpAttempt, verifyEmailOtp, type SessionMeta, type SessionResult } from "./auth.js";
import { scanWithAi } from "./ai.js";
import { sendInstituteCode, sendVerificationDecision } from "./mail.js";
import { writeAudit } from "./audit.js";
import { emitDbChange } from "../realtime/events.js";
import {
  DailyRoomProvisionError,
  activeDailyRoomNamesForUser,
  closeDailySessionsForRooms,
  dailyMeetingTokenPayload,
  dailyParticipantLeaseIsFresh,
  dailyRoomNameForSession,
  dailySessionCanBeReused,
  provisionPrivateDailyRoom,
  revokeDailyUserRooms,
} from "./daily.js";
import { forumSegment } from "../security/forumScope.js";
import { publicStorageObjectUrl } from "./storage.js";
import { AppSyncFixedWindowRateLimiter } from "../realtime/appsyncRateLimit.js";
import { deleteObjectBytes } from "./objectStore.js";

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;

export const MANAGED_MEMBER_PASSWORD_MIN_LENGTH = 10;
const MANAGED_MEMBER_PASSWORD_MAX_LENGTH = 128;
const MEMBER_DELETE_BATCH_SIZE = 100;
const klipyRateLimiter = new AppSyncFixedWindowRateLimiter(60_000, 60);

export const instituteDomains: Record<string, readonly [student: string, alumni: string]> = {
  "IIT Delhi": ["iitd.ac.in", "alumni.iitd.ac.in"], "IIT Bombay": ["iitb.ac.in", "alumni.iitb.ac.in"],
  "IIT Madras": ["iitm.ac.in", "alumni.iitm.ac.in"], "IIT Kanpur": ["iitk.ac.in", "alumni.iitk.ac.in"],
  "IIT Kharagpur": ["iitkgp.ac.in", "alumni.iitkgp.ac.in"], "IIT Roorkee": ["iitr.ac.in", "alumni.iitr.ac.in"],
  "IIT Guwahati": ["iitg.ac.in", "alumni.iitg.ac.in"], "IIT Hyderabad": ["iith.ac.in", "alumni.iith.ac.in"],
  "IIT BHU": ["iitbhu.ac.in", "alumni.iitbhu.ac.in"], "IIT Indore": ["iiti.ac.in", "alumni.iiti.ac.in"],
  "IIT Ropar": ["iitrpr.ac.in", "alumni.iitrpr.ac.in"], "IIT Patna": ["iitp.ac.in", "alumni.iitp.ac.in"],
  "IIT Bhubaneswar": ["iitbbs.ac.in", "alumni.iitbbs.ac.in"], "IIT Gandhinagar": ["iitgn.ac.in", "alumni.iitgn.ac.in"],
  "IIT Jodhpur": ["iitj.ac.in", "alumni.iitj.ac.in"], "IIT Mandi": ["iitmandi.ac.in", "alumni.iitmandi.ac.in"],
  "IIT Tirupati": ["iittp.ac.in", "alumni.iittp.ac.in"], "IIT Palakkad": ["iitpkd.ac.in", "alumni.iitpkd.ac.in"],
  "IIT Dharwad": ["iitdh.ac.in", "alumni.iitdh.ac.in"], "IIT Bhilai": ["iitbhilai.ac.in", "alumni.iitbhilai.ac.in"],
  "IIT Goa": ["iitgoa.ac.in", "alumni.iitgoa.ac.in"], "IIT Jammu": ["iitjammu.ac.in", "alumni.iitjammu.ac.in"],
  "IIT Dhanbad (ISM)": ["iitism.ac.in", "alumni.iitism.ac.in"],
};

const string = (body: Body, key: string, required = false): string => {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (required && !value) throw new ApiError(400, "invalid_request", `${key} is required`);
  return value;
};
const admin = (ctx: RequestContext | undefined): RequestContext => {
  if (!ctx || (ctx.auth.role !== "admin" && ctx.auth.role !== "owner")) throw new ApiError(403, "admin_required", "Administrator access is required");
  return ctx;
};
const authenticated = (ctx: RequestContext | undefined): RequestContext => {
  if (!ctx) throw new ApiError(401, "authentication_required", "Authentication is required");
  return ctx;
};

async function issueInstituteOtp(body: Body, ctx: RequestContext): Promise<Row> {
  const email = normalizeEmail(string(body, "email", true));
  const iit = string(body, "iit_name", true);
  const status = string(body, "student_status", true);
  if (!new Set(["current_student", "alumni"]).has(status)) throw new ApiError(400, "invalid_student_status", "Member type is invalid");
  const domain = email.split("@")[1] ?? "";
  const allowed = instituteDomains[iit] ?? [];
  const expected = status === "alumni" ? allowed[1] : allowed[0];
  if (!expected || domain !== expected) throw new ApiError(400, "invalid_institute_email", `Use the official ${iit} ${status === "alumni" ? "alumni" : "student"} email domain`);
  const duplicate = await prisma.profile.findFirst({ where: { iit_email: email, user_id: { not: ctx.auth.id } } });
  if (duplicate) throw new ApiError(409, "EMAIL_ALREADY_LINKED", "This institute email is linked to another account");
  const own = await prisma.profile.findUnique({ where: { user_id: ctx.auth.id } });
  if (own?.verification_revoked_at) {
    throw new ApiError(403, "verification_revoked", "Your institute verification was revoked by an administrator. Contact support for review");
  }
  if (own?.iit_email === email && own.is_verified) return { already_verified: true };
  const recent = await prisma.emailOtp.count({ where: { destination_hash: keyedHash(email), purpose: "institute", created_at: { gte: new Date(Date.now() - 15 * 60_000) } } });
  if (recent >= 5) throw new ApiError(429, "otp_rate_limited", "Too many code requests. Try again later");
  const code = randomOtp();
  const challenge = await prisma.emailOtp.create({ data: { user_id: ctx.auth.id, email, destination_hash: keyedHash(email), code_hash: await hashOtp(code), purpose: "institute", expires_at: new Date(Date.now() + 10 * 60_000), ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined } });
  try {
    await sendInstituteCode(email, code);
  } catch (error) {
    await prisma.emailOtp.updateMany({ where: { id: challenge.id, consumed_at: null }, data: { consumed_at: new Date() } }).catch(() => undefined);
    throw error;
  }
  return config.NODE_ENV === "production" ? { sent: true } : { sent: true, debug_code: code };
}

export async function verifyInstitute(body: Body, ctx: RequestContext): Promise<Row> {
  const email = normalizeEmail(string(body, "email", true));
  const iit = string(body, "iit_name", true);
  const status = string(body, "student_status", true);
  const code = string(body, "code", true);
  if (!new Set(["current_student", "alumni"]).has(status)) throw new ApiError(400, "invalid_student_status", "Member type is invalid");
  const domains = instituteDomains[iit];
  const expected = status === "alumni" ? domains?.[1] : domains?.[0];
  if (!expected || email.split("@")[1] !== expected) throw new ApiError(400, "invalid_institute_email", `Use the official ${iit} email domain`);
  const challenge = await verifyAndReserveEmailOtpAttempt({
    destinationHash: keyedHash(email), purpose: "institute", code, userId: ctx.auth.id,
  });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${ctx.auth.id} LIMIT 1 FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT user_id FROM profiles WHERE user_id = ${ctx.auth.id} LIMIT 1 FOR UPDATE`);
    const profile = await tx.profile.findUnique({ where: { user_id: ctx.auth.id }, select: { verification_revoked_at: true } });
    if (profile?.verification_revoked_at) {
      throw new ApiError(403, "verification_revoked", "Your institute verification was revoked by an administrator. Contact support for review");
    }
    const now = new Date();
    const claimed = await tx.emailOtp.updateMany({
      where: { id: challenge.id, consumed_at: null, expires_at: { gt: now } },
      data: { consumed_at: now },
    });
    if (claimed.count !== 1) throw new ApiError(400, "invalid_otp", "The code is invalid or expired");
    await tx.profile.upsert({ where: { user_id: ctx.auth.id }, create: { user_id: ctx.auth.id, iit_email: email, iit_name: iit, student_status: status, is_verified: true, community_id: config.DEFAULT_COMMUNITY_ID }, update: { iit_email: email, iit_name: iit, student_status: status, is_verified: true, verification_revoked_at: null } });
    const affiliationId = newId();
    await tx.legacyRecord.upsert({ where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: ctx.auth.id } }, create: { table_name: "verified_academic_affiliations", record_id: ctx.auth.id, owner_id: ctx.auth.id, community_id: config.DEFAULT_COMMUNITY_ID, data: { id: affiliationId, user_id: ctx.auth.id, institute_name: iit, institute_email: email, verification_status: "VERIFIED", student_status: status, verified_at: new Date().toISOString() } }, update: { data: { id: affiliationId, user_id: ctx.auth.id, institute_name: iit, institute_email: email, verification_status: "VERIFIED", student_status: status, verified_at: new Date().toISOString() } } });
  });
  emitDbChange({
    table: "profiles", event: "UPDATE",
    row: { user_id: ctx.auth.id, iit_name: iit, student_status: status, is_verified: true, force_reauthenticate: true },
    actor_id: ctx.auth.id, audience_ids: [ctx.auth.id],
  });
  return { verified: true, email, iit_name: iit };
}

export interface ManagedMemberAcademicInput {
  email: string;
  password: string;
  name: string;
  institute: string;
  degree: string;
  specialisation: string;
  graduationYear: number;
  studentStatus: "current_student" | "alumni";
}

function boundedMemberField(body: Body, key: string, max: number): string {
  const value = string(body, key, true);
  if (value.length > max) throw new ApiError(400, "invalid_request", `${key} is too long`);
  return value;
}

export function managedMemberAcademicInput(body: Body): ManagedMemberAcademicInput {
  const email = normalizeEmail(boundedMemberField(body, "email", 320));
  const password = typeof body.password === "string" ? body.password : "";
  const name = boundedMemberField(body, "name", 160);
  const institute = boundedMemberField(body, "iit_name", 160);
  const degree = boundedMemberField(body, "degree", 160);
  const specialisation = boundedMemberField(body, "specialisation", 160);
  const graduationYear = Number(body.graduation_year);
  const studentStatus = string(body, "student_status") || "current_student";
  const latestReasonableYear = new Date().getUTCFullYear() + 10;

  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(400, "invalid_email", "Enter a valid email address");
  if (password.length < MANAGED_MEMBER_PASSWORD_MIN_LENGTH || password.length > MANAGED_MEMBER_PASSWORD_MAX_LENGTH) {
    throw new ApiError(400, "weak_password", `Password must contain between ${MANAGED_MEMBER_PASSWORD_MIN_LENGTH} and ${MANAGED_MEMBER_PASSWORD_MAX_LENGTH} characters`);
  }
  if (!Object.prototype.hasOwnProperty.call(instituteDomains, institute)) {
    throw new ApiError(400, "invalid_institute", "Select a supported IIT");
  }
  if (!Number.isInteger(graduationYear) || graduationYear < 1900 || graduationYear > latestReasonableYear) {
    throw new ApiError(400, "invalid_graduation_year", "Enter a valid graduation year");
  }
  if (studentStatus !== "current_student" && studentStatus !== "alumni") {
    throw new ApiError(400, "invalid_student_status", "Member type is invalid");
  }
  return { email, password, name, institute, degree, specialisation, graduationYear, studentStatus };
}

export function resolveMemberFileDiskPath(storageRoot: string, objectKey: string): string {
  if (!objectKey || objectKey.includes("\0") || objectKey.includes("\\") || path.isAbsolute(objectKey)) {
    throw new ApiError(500, "invalid_stored_object_path", "A stored upload path is invalid");
  }
  const root = path.resolve(storageRoot);
  const target = path.resolve(root, objectKey);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(500, "invalid_stored_object_path", "A stored upload path is outside the storage root");
  }
  return target;
}

function chunks<T>(values: T[], size = MEMBER_DELETE_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

async function legacyRecordsByJsonValues(
  tx: Prisma.TransactionClient,
  table: string,
  field: string,
  values: string[],
) {
  const records = [];
  for (const batch of chunks(values)) {
    if (!batch.length) continue;
    records.push(...await tx.legacyRecord.findMany({ where: {
      table_name: table,
      OR: batch.map((value) => ({ data: { path: `$.${field}`, equals: value } })),
    } }));
  }
  return records;
}

async function deleteLegacyByJsonValues(
  tx: Prisma.TransactionClient,
  tables: string[],
  fields: string[],
  values: string[],
): Promise<void> {
  for (const batch of chunks(values)) {
    if (!batch.length) continue;
    await tx.legacyRecord.deleteMany({ where: {
      table_name: { in: tables },
      OR: batch.flatMap((value) => fields.map((field) => ({ data: { path: `$.${field}`, equals: value } }))),
    } });
  }
}

function rowString(row: Row, key: string): string {
  return typeof row[key] === "string" ? row[key] : "";
}

async function cleanupMemberFileBytes(files: Array<{ id: string; object_key: string }>): Promise<{ removedIds: string[]; failedIds: string[] }> {
  const removedIds: string[] = [];
  const failedIds: string[] = [];
  for (const batch of chunks(files, 25)) {
    const outcomes = await Promise.all(batch.map(async (file) => {
      try {
        await deleteObjectBytes(file.object_key);
        return { id: file.id, removed: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { name?: string }).name === "NoSuchKey") return { id: file.id, removed: true };
        return { id: file.id, removed: false };
      }
    }));
    for (const outcome of outcomes) (outcome.removed ? removedIds : failedIds).push(outcome.id);
  }
  return { removedIds, failedIds };
}

async function createManagedMember(body: Body, ctx: RequestContext): Promise<Row> {
  const input = managedMemberAcademicInput(body);
  const now = new Date();
  const educationId = newId();
  const affiliationId = newId();
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: {
        email: input.email,
        password_hash: passwordHash,
        status: "active",
        email_verified_at: now,
        profile: { create: {
          name: input.name,
          iit_name: input.institute,
          student_status: input.studentStatus,
          headline: `${input.degree} · ${input.specialisation} · ${input.institute} · Class of ${input.graduationYear}`,
          is_verified: true,
          onboarding_completed: true,
          community_id: config.DEFAULT_COMMUNITY_ID,
          primary_education_id: educationId,
        } },
      } });
      await tx.legacyRecord.create({ data: {
        table_name: "education",
        record_id: `admin-education:${created.id}`,
        owner_id: created.id,
        community_id: config.DEFAULT_COMMUNITY_ID,
        data: {
          id: educationId,
          user_id: created.id,
          institution: input.institute,
          degree: input.degree,
          branch_area: input.specialisation,
          passing_year: String(input.graduationYear),
          is_verified: true,
          approval_status: "approved",
          verification_source: "admin",
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
      } });
      await tx.legacyRecord.create({ data: {
        table_name: "verified_academic_affiliations",
        record_id: created.id,
        owner_id: created.id,
        community_id: config.DEFAULT_COMMUNITY_ID,
        data: {
          id: affiliationId,
          user_id: created.id,
          network_id: "IIT",
          institute_id: forumSegment(input.institute),
          institute_name: input.institute,
          degree_id: forumSegment(input.degree),
          degree_name: input.degree,
          specialisation_id: forumSegment(input.specialisation),
          specialisation_name: input.specialisation,
          graduation_year: input.graduationYear,
          member_status: input.studentStatus,
          student_status: input.studentStatus,
          verification_status: "VERIFIED",
          source_education_id: educationId,
          verification_source: "admin",
          verified_at: now.toISOString(),
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
      } });
      await tx.auditLog.create({ data: {
        actor_id: ctx.auth.id,
        action: "admin.create_member",
        resource_type: "user",
        resource_id: created.id,
        ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined,
        metadata: { institute: input.institute, degree: input.degree, specialisation: input.specialisation, graduation_year: input.graduationYear },
      } });
      return created;
    });
    return { user_id: user.id, education_id: educationId, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new ApiError(409, "email_in_use", "An account already exists for this email");
    throw error;
  }
}

async function deleteManagedMember(body: Body, ctx: RequestContext): Promise<Row> {
  const userId = string(body, "user_id", true);
  const confirmation = string(body, "confirmation", true);
  const deletion = await prisma.$transaction(async (tx) => {
    // This is the first database operation in the deletion transaction. Any
    // in-flight/new typed or LegacyRecord write owned by this user must acquire
    // a shared FK lock on the same parent row, so it either commits before our
    // snapshots or waits until deletion and then fails its FK check.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM users WHERE id = ${userId} LIMIT 1 FOR UPDATE
    `);
    if (locked.length !== 1) throw new ApiError(404, "member_not_found", "Member not found");
    const user = await tx.user.findUnique({ where: { id: userId }, include: { profile: true } });
    assertDeletableMember(ctx.auth.id, user);
    if (confirmation !== (user!.profile?.name ?? "Unnamed member")) {
      throw new ApiError(400, "confirmation_mismatch", "The confirmation does not match the member name");
    }

    const [ownedFiles, memberships, createdRooms, posts, ownedCatalogOptions, catalogReferences, activeDailyRooms] = await Promise.all([
      tx.fileObject.findMany({ where: { uploaded_by: userId }, select: { id: true, object_key: true, bucket: true } }),
      tx.legacyRecord.findMany({ where: {
        table_name: "chat_members",
        OR: [{ owner_id: userId }, { data: { path: "$.user_id", equals: userId } }],
      } }),
      tx.legacyRecord.findMany({ where: {
        table_name: "chat_rooms",
        data: { path: "$.created_by", equals: userId },
      } }),
      tx.post.findMany({ where: { author_id: userId }, select: { id: true } }),
      tx.legacyRecord.findMany({ where: { table_name: "custom_options", owner_id: userId } }),
      tx.legacyRecord.findMany({ where: { table_name: { in: ["custom_options", "professional_experience"] } }, select: { table_name: true, owner_id: true, data: true } }),
      activeDailyRoomNamesForUser(tx, userId),
    ]);
    const closedDaily = await closeDailySessionsForRooms(tx, activeDailyRooms, "member_deleted");
    const approvedCatalogOptions = ownedCatalogOptions.filter((record) => String((record.data as Row).status ?? "").toLowerCase() === "approved");
    for (const record of approvedCatalogOptions) {
      const row = record.data as Row;
      await tx.legacyRecord.update({ where: { id: record.id }, data: {
        owner_id: null,
        data: {
          ...row,
          created_by: null,
          submitted_by: null,
          submitter_deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      } });
    }
    const preservedLogoUrls = new Set(catalogReferences.flatMap((record) => {
      const row = record.data as Row;
      const logo = typeof row.logo_url === "string" ? row.logo_url : "";
      if (!logo) return [];
      if (record.table_name === "custom_options") {
        return String(row.status ?? "pending").toLowerCase() === "approved" ? [logo] : [];
      }
      const visible = !new Set(["rejected", "deleted"]).has(String(row.approval_status ?? "approved").toLowerCase()) && row.deleted_at == null;
      return visible && record.owner_id !== userId ? [logo] : [];
    }));
    const files = ownedFiles.filter((file) => {
      if (file.bucket !== "entity-logos" || !file.object_key.startsWith("entity-logos/")) return true;
      const objectPath = file.object_key.slice("entity-logos/".length);
      return !preservedLogoUrls.has(publicStorageObjectUrl("entity-logos", objectPath));
    });
    const membershipRoomIds = memberships.flatMap((record) => {
      const roomId = rowString(record.data as Row, "room_id");
      return roomId ? [roomId] : [];
    });
    const roomRecords = [...createdRooms];
    for (const record of await legacyRecordsByJsonValues(tx, "chat_rooms", "id", [...new Set(membershipRoomIds)])) {
      if (!roomRecords.some((current) => current.id === record.id)) roomRecords.push(record);
    }
    const directRooms = roomRecords.filter((record) => (record.data as Row).is_group === false);
    const directRoomIds = [...new Set(directRooms.flatMap((record) => {
      const roomId = rowString(record.data as Row, "id");
      return roomId ? [roomId] : [];
    }))];

    await deleteLegacyByJsonValues(
      tx,
      ["messages", "chat_members", "call_sessions", "call_participants", "consultations", "notifications"],
      ["room_id", "chat_room_id"],
      directRoomIds,
    );
    if (directRooms.length) await tx.legacyRecord.deleteMany({ where: { id: { in: directRooms.map((record) => record.id) } } });

    for (const record of roomRecords.filter((room) => (room.data as Row).is_group === true && (room.data as Row).created_by === userId)) {
      await tx.legacyRecord.update({ where: { id: record.id }, data: {
        owner_id: null,
        data: { ...(record.data as Row), created_by: null, updated_at: new Date().toISOString() } as Prisma.InputJsonValue,
      } });
    }

    const postIds = posts.map((post) => post.id);
    const polls = await legacyRecordsByJsonValues(tx, "polls", "post_id", postIds);
    const pollIds = polls.flatMap((record) => {
      const pollId = rowString(record.data as Row, "id");
      return pollId ? [pollId] : [];
    });
    await deleteLegacyByJsonValues(tx, ["poll_votes"], ["poll_id"], pollIds);
    await deleteLegacyByJsonValues(tx, ["pinned_messages", "user_pinned_messages", "forum_deleted_for_user", "polls"], ["post_id", "message_id"], postIds);
    for (const batch of chunks(postIds)) {
      await tx.reaction.deleteMany({ where: { entity_id: { in: batch } } });
      await tx.report.deleteMany({ where: { entity_id: { in: batch } } });
    }
    await tx.post.updateMany({ where: { author_id: userId }, data: {
      author_id: null,
      content: "", tags: Prisma.DbNull, campus_filter: null, degree_filter: null, branch_filter: null,
      batch_filter: null, cohort_filter: null, student_status_filter: null,
      image_url: null, image_path: null, media_url: null, media_type: null, media_path: null,
      media_metadata: Prisma.DbNull, file_url: null, file_path: null, file_name: null, file_type: null,
      file_size: null, voice_url: null, voice_path: null, voice_duration: null,
      is_deleted_for_everyone: true, deleted_by_user_id: null, deleted_at: new Date(),
    } });
    await tx.comment.updateMany({ where: { author_id: userId }, data: {
      author_id: null, content: "", edited_at: new Date(),
    } });
    await tx.job.deleteMany({ where: { created_by: userId } });
    await tx.event.deleteMany({ where: { created_by: userId } });

    await tx.legacyRecord.deleteMany({ where: {
      OR: [
        { owner_id: userId },
        { table_name: "chat_members", data: { path: "$.user_id", equals: userId } },
        { table_name: "messages", data: { path: "$.sender_id", equals: userId } },
        { table_name: "stories", data: { path: "$.user_id", equals: userId } },
        { table_name: "stories", data: { path: "$.author_id", equals: userId } },
        { table_name: "consultations", data: { path: "$.client_id", equals: userId } },
        { table_name: "consultations", data: { path: "$.consultant_id", equals: userId } },
      ],
    } });
    if (files.length) await tx.fileObject.updateMany({ where: { id: { in: files.map((file) => file.id) } }, data: { status: "deleting", deleted_at: new Date() } });
    await tx.auditLog.create({ data: {
      actor_id: ctx.auth.id,
      action: "admin.delete_member",
      resource_type: "user",
      resource_id: userId,
      ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined,
      metadata: {
        email_hash: keyedHash(user!.email),
        files_scheduled: files.length,
        direct_rooms_deleted: directRoomIds.length,
        authored_posts_tombstoned: postIds.length,
        approved_catalog_options_preserved: approvedCatalogOptions.length,
      },
    } });
    const deletedUser = await tx.user.deleteMany({ where: { id: userId, role: { notIn: ["admin", "owner"] } } });
    if (deletedUser.count !== 1) {
      throw new ApiError(409, "member_role_changed", "The member role changed during deletion; review the account and try again");
    }
    return { files, directRoomsDeleted: directRoomIds.length, postsDeleted: postIds.length, closedDaily };
  }, { timeout: 60_000 });

  // Revoke every cached realtime authorization immediately after the database
  // deletion commits. File-byte cleanup can be slow or partially fail, but a
  // deleted member must never keep receiving private events during that work.
  emitDbChange({
    table: "profiles", event: "UPDATE",
    row: { user_id: userId, is_verified: false, account_deleted: true, force_reauthenticate: true },
    actor_id: ctx.auth.id, audience_ids: [userId],
  });
  for (const row of deletion.closedDaily?.participants ?? []) {
    emitDbChange({ table: "call_participants", event: "UPDATE", row, actor_id: ctx.auth.id, room: `room-${String(row.room_id ?? "")}` });
  }
  for (const row of deletion.closedDaily?.sessions ?? []) {
    emitDbChange({ table: "call_sessions", event: "UPDATE", row, actor_id: ctx.auth.id, room: `room-${String(row.room_id ?? "")}` });
  }

  const dailyRevocation = await revokeDailyUserRooms(deletion.closedDaily?.roomNames, userId, config.DAILY_API_KEY ?? "");
  if (dailyRevocation.failed > 0) {
    try {
      await writeAudit({
        actor_id: ctx.auth.id,
        action: "admin.delete_member.daily_revocation_pending",
        resource_type: "user",
        resource_id: userId,
        ip: ctx.ip,
        metadata: { failed_rooms: dailyRevocation.failed },
      });
    } catch (error) {
      logger.error({ err: error, failed_room_count: dailyRevocation.failed }, "Deleted-member Daily room revocation audit could not be written");
    }
  }

  const cleanup = await cleanupMemberFileBytes(deletion.files);
  let cleanupMetadataPending = false;
  try {
    if (cleanup.removedIds.length) await prisma.fileObject.deleteMany({ where: { id: { in: cleanup.removedIds }, status: "deleting" } });
    if (cleanup.failedIds.length) await prisma.fileObject.updateMany({ where: { id: { in: cleanup.failedIds } }, data: { status: "cleanup_failed" } });
  } catch (error) {
    cleanupMetadataPending = true;
    logger.error({ err: error, file_count: deletion.files.length }, "Deleted-member storage metadata cleanup remains pending");
  }
  const cleanupPending = cleanup.failedIds.length > 0 || cleanupMetadataPending;
  if (cleanupPending) {
    try {
      await writeAudit({
        actor_id: ctx.auth.id,
        action: "admin.delete_member.storage_cleanup_pending",
        resource_type: "user",
        resource_id: userId,
        ip: ctx.ip,
        metadata: { failed_files: cleanup.failedIds.length, metadata_finalization_pending: cleanupMetadataPending },
      });
    } catch (error) {
      // The API result below remains fail-visible even if the follow-up audit
      // store is temporarily unavailable. The original deletion audit is
      // committed in the same transaction as the account deletion.
      logger.error({ err: error, failed_file_count: cleanup.failedIds.length }, "Deleted-member storage cleanup audit could not be written");
    }
  }
  return {
    user_id: userId,
    deleted: true,
    direct_rooms_deleted: deletion.directRoomsDeleted,
    posts_deleted: deletion.postsDeleted,
    files_removed: cleanup.removedIds.length,
    storage_cleanup_pending: cleanupPending,
    storage_cleanup_failures: cleanup.failedIds.length,
    daily_ejection_pending: dailyRevocation.failed > 0,
    daily_ejection_failures: dailyRevocation.failed,
    daily_revocation_pending: dailyRevocation.failed > 0,
    daily_revocation_failures: dailyRevocation.failed,
  };
}

async function manageUsers(body: Body, ctx: RequestContext): Promise<Row> {
  admin(ctx);
  const action = string(body, "action", true);
  if (action === "create_member") return createManagedMember(body, ctx);
  if (action === "delete_member") return deleteManagedMember(body, ctx);
  throw new ApiError(400, "unsupported_action", "Unsupported manage-users action");
}

export function assertDeletableMember(
  actorId: string,
  user: { id: string; role: string; profile?: { role?: string | null } | null } | null,
): void {
  if (!user) throw new ApiError(404, "user_not_found", "Member not found");
  if (user.id === actorId) throw new ApiError(400, "cannot_delete_self", "You cannot delete your own account here");
  if ([user.role, user.profile?.role].some((role) => role === "admin" || role === "owner")) {
    throw new ApiError(403, "privileged_account_protected", "Administrator and owner accounts must be demoted before deletion");
  }
}

const TEST_SEED_VERSION = "2026-09-04-mba-delhi-v2";
const TEST_SEED_EMAIL_SUFFIX = "@loadtest.cirkle.invalid";
const TEST_SEED_NAMES = [
  "Aarav Mehta", "Aditi Rao", "Arjun Kapoor", "Ananya Singh", "Dev Malhotra", "Diya Sharma",
  "Ishaan Gupta", "Ishita Nair", "Kabir Khanna", "Kavya Iyer", "Krish Verma", "Meera Joshi",
  "Neil Bhatia", "Nisha Reddy", "Pranav Sethi", "Priya Menon", "Rahul Jain", "Rhea Arora",
  "Rohan Das", "Saanvi Shah", "Siddharth Bose", "Sneha Pillai", "Vihaan Chopra", "Zoya Mirza",
] as const;
const TEST_SEED_SCOPE = {
  scope_type: "COHORT",
  scope_key: "IIT_DELHI|MBA|GENERAL|2026",
  channel: "cohort",
} as const;

export function buildTestSeedPosts(userIds: string[], asOf = new Date()): Prisma.PostCreateManyInput[] {
  if (userIds.length !== TEST_SEED_NAMES.length) throw new Error("Test seed requires exactly 24 member IDs");
  const topics = [
    "placement updates", "case interview practice", "product strategy", "finance electives", "consulting prep",
    "alumni meetup", "startup ideas", "marketing analytics", "operations project", "campus memories",
  ];
  const parentIds = Array.from({ length: 1_200 }, () => newId());
  const parents = parentIds.map((id, index) => ({
    id,
    ...TEST_SEED_SCOPE,
    community_id: config.DEFAULT_COMMUNITY_ID,
    author_id: userIds[index % userIds.length],
    content: `${TEST_SEED_NAMES[index % TEST_SEED_NAMES.length]}: MBA General 2026 load conversation #${index + 1} - ${topics[index % topics.length]}.`,
    is_anonymous: index % 37 === 0,
    client_id: `cirkle-seed-v2:parent:${index + 1}`,
    created_at: new Date(asOf.getTime() - (1_500 - index) * 900),
  } satisfies Prisma.PostCreateManyInput));
  const replies = Array.from({ length: 300 }, (_, index) => ({
    id: newId(),
    ...TEST_SEED_SCOPE,
    community_id: config.DEFAULT_COMMUNITY_ID,
    author_id: userIds[(index + 3) % userIds.length],
    reply_to_id: parentIds[(index * 4) % parentIds.length],
    content: `Thread reply #${index + 1}: adding a cohort perspective to this discussion.`,
    is_anonymous: index % 41 === 0,
    client_id: `cirkle-seed-v2:reply:${index + 1}`,
    created_at: new Date(asOf.getTime() - (300 - index) * 850),
  } satisfies Prisma.PostCreateManyInput));
  return [...parents, ...replies];
}

export function trackedTestSeedUserIds(settingRecords: Array<{ data: Prisma.JsonValue }>): string[] {
  const tracked = new Set<string>();
  for (const record of settingRecords) {
    const row = record.data as Row;
    if (row.key !== "test_seed_user_ids") continue;
    let value: unknown = row.value;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { continue; }
    }
    if (!Array.isArray(value)) continue;
    for (const id of value) {
      if (typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) tracked.add(id);
    }
  }
  return [...tracked].slice(0, 1_000);
}

async function seedData(body: Body, ctx: RequestContext): Promise<Row> {
  admin(ctx);
  if (config.NODE_ENV === "production" || !config.ENABLE_SEED_DATA) throw new ApiError(403, "seed_data_disabled", "Test data operations are disabled");
  const action = string(body, "action", true);
  const settingRecords = await prisma.legacyRecord.findMany({ where: { table_name: "app_settings" } });
  const seedSettingIds = settingRecords.filter((record) => {
    const key = (record.data as Row).key;
    return key === "test_seed_user_ids" || key === "test_seed_version" || key === "test_seed_summary";
  }).map((record) => record.id);
  if (action === "purge") {
    const trackedIds = trackedTestSeedUserIds(settingRecords);
    const testUsers = trackedIds.length ? await prisma.user.findMany({ where: {
      id: { in: trackedIds },
      email: { endsWith: TEST_SEED_EMAIL_SUFFIX },
    } }) : [];
    const userIds = testUsers.map((user) => user.id);
    const result = await prisma.$transaction(async (tx) => {
      const deletedPosts = await tx.post.deleteMany({ where: { OR: [
        { author_id: { in: userIds } },
        { client_id: { startsWith: "cirkle-seed-v2:" } },
      ] } });
      if (userIds.length) await tx.legacyRecord.deleteMany({ where: { owner_id: { in: userIds } } });
      const deletedUsers = await tx.user.deleteMany({ where: { id: { in: userIds } } });
      if (seedSettingIds.length) await tx.legacyRecord.deleteMany({ where: { id: { in: seedSettingIds } } });
      return { deletedUsers: deletedUsers.count, deletedPosts: deletedPosts.count };
    }, { timeout: 60_000 });
    return { success: true, ...result };
  }
  if (action !== "seed") throw new ApiError(400, "unsupported_action", "Action must be seed or purge");
  const asOf = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const userIds: string[] = [];
    for (let index = 0; index < TEST_SEED_NAMES.length; index += 1) {
      const email = `mba-delhi-2026-${String(index + 1).padStart(2, "0")}${TEST_SEED_EMAIL_SUFFIX}`;
      const user = await tx.user.upsert({
        where: { email },
        create: { email, status: "active", email_verified_at: asOf },
        update: { status: "active", email_verified_at: asOf },
      });
      userIds.push(user.id);
      const educationId = newId();
      await tx.profile.upsert({
        where: { user_id: user.id },
        create: {
          user_id: user.id, name: TEST_SEED_NAMES[index], iit_name: "IIT Delhi", student_status: "alumni",
          headline: "MBA · General · IIT Delhi · Class of 2026", location: "New Delhi", is_verified: true,
          onboarding_completed: true, community_id: config.DEFAULT_COMMUNITY_ID, primary_education_id: educationId,
        },
        update: {
          name: TEST_SEED_NAMES[index], iit_name: "IIT Delhi", student_status: "alumni",
          headline: "MBA · General · IIT Delhi · Class of 2026", location: "New Delhi", is_verified: true,
          onboarding_completed: true, community_id: config.DEFAULT_COMMUNITY_ID, primary_education_id: educationId,
        },
      });
      await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: "education", record_id: `seed-education:${user.id}` } },
        create: {
          table_name: "education", record_id: `seed-education:${user.id}`, owner_id: user.id,
          community_id: config.DEFAULT_COMMUNITY_ID, data: {
            id: educationId, user_id: user.id, institution: "IIT Delhi", degree: "MBA", branch_area: "General",
            passing_year: "2026", is_verified: true, approval_status: "approved", created_at: asOf.toISOString(),
          },
        },
        update: { owner_id: user.id, data: {
          id: educationId, user_id: user.id, institution: "IIT Delhi", degree: "MBA", branch_area: "General",
          passing_year: "2026", is_verified: true, approval_status: "approved", updated_at: asOf.toISOString(),
        } },
      });
      await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: user.id } },
        create: {
          table_name: "verified_academic_affiliations", record_id: user.id, owner_id: user.id,
          community_id: config.DEFAULT_COMMUNITY_ID, data: {
            id: newId(), user_id: user.id, network_id: "IIT", institute_id: "IIT_DELHI", institute_name: "IIT Delhi",
            degree_id: "MBA", degree_name: "MBA", specialisation_id: "GENERAL", specialisation_name: "General",
            graduation_year: 2026, member_status: "alumni", student_status: "alumni", verification_status: "VERIFIED",
            source_education_id: educationId, verification_source: "test_seed", verified_at: asOf.toISOString(),
          },
        },
        update: { owner_id: user.id, data: {
          id: newId(), user_id: user.id, network_id: "IIT", institute_id: "IIT_DELHI", institute_name: "IIT Delhi",
          degree_id: "MBA", degree_name: "MBA", specialisation_id: "GENERAL", specialisation_name: "General",
          graduation_year: 2026, member_status: "alumni", student_status: "alumni", verification_status: "VERIFIED",
          source_education_id: educationId, verification_source: "test_seed", verified_at: asOf.toISOString(),
        } },
      });
    }

    await tx.post.deleteMany({ where: { OR: [
      { author_id: { in: userIds } },
      { client_id: { startsWith: "cirkle-seed-v2:" } },
    ] } });
    const posts = buildTestSeedPosts(userIds, asOf);
    const created = await tx.post.createMany({ data: posts });

    const settings: Array<[string, string]> = [
      ["test_seed_user_ids", JSON.stringify(userIds)],
      ["test_seed_version", TEST_SEED_VERSION],
      ["test_seed_summary", JSON.stringify({ users: userIds.length, messages: created.count, scope: TEST_SEED_SCOPE })],
    ];
    for (const [key, value] of settings) {
      const existing = settingRecords.find((record) => (record.data as Row).key === key);
      const data = { ...(existing?.data as Row | undefined), id: (existing?.data as Row | undefined)?.id ?? newId(), key, value, updated_by: ctx.auth.id, updated_at: asOf.toISOString() };
      if (existing) await tx.legacyRecord.update({ where: { id: existing.id }, data: { data: data as Prisma.InputJsonValue } });
      else await tx.legacyRecord.create({ data: { table_name: "app_settings", record_id: `seed-setting:${key}`, community_id: config.DEFAULT_COMMUNITY_ID, data: data as Prisma.InputJsonValue } });
    }
    return { userIds, messagesCreated: created.count };
  }, { timeout: 60_000 });
  return { success: true, seedVersion: TEST_SEED_VERSION, usersCreated: result.userIds.length, messagesCreated: result.messagesCreated, scope: TEST_SEED_SCOPE };
}

export function resolveVerificationDecision(body: Body, submission?: Row): { decision: "approved" | "rejected"; reason: string } {
  const explicit = typeof body.approved === "boolean" ? (body.approved ? "approved" : "rejected")
    : body.decision === "approved" || body.status === "approved" ? "approved"
      : body.decision === "rejected" || body.status === "rejected" ? "rejected" : undefined;
  const stored = submission?.status === "approved" || submission?.status === "rejected" ? submission.status : undefined;
  if (submission && !stored) throw new ApiError(409, "verification_not_reviewed", "The verification submission has not been reviewed");
  if (stored && explicit && stored !== explicit) throw new ApiError(409, "verification_decision_mismatch", "The requested decision does not match the reviewed submission");
  const decision = stored ?? explicit;
  if (!decision) throw new ApiError(400, "verification_decision_required", "An approved or rejected decision is required");
  const reason = typeof submission?.review_notes === "string" && submission.review_notes.trim()
    ? submission.review_notes.trim()
    : string(body, "reason") || string(body, "review_notes");
  return { decision, reason };
}

async function notifyDecision(body: Body, ctx: RequestContext): Promise<Row> {
  admin(ctx);
  let userId = string(body, "user_id") || string(body, "target_user_id");
  const submissionId = string(body, "submission_id");
  let submission: Row | undefined;
  if (submissionId) {
    const record = await prisma.legacyRecord.findFirst({ where: {
      table_name: "document_verifications",
      data: { path: "$.id", equals: submissionId },
    } });
    if (!record) throw new ApiError(404, "submission_not_found", "Verification submission not found");
    submission = record.data as Row;
    const submissionUserId = typeof submission.user_id === "string" ? submission.user_id : "";
    if (!submissionUserId) throw new ApiError(409, "invalid_verification_submission", "The verification submission has no valid member");
    if (userId && userId !== submissionUserId) throw new ApiError(409, "verification_user_mismatch", "The requested member does not match the verification submission");
    userId = submissionUserId;
  }
  if (!userId) throw new ApiError(400, "invalid_request", "user_id or submission_id is required");
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
  if (!user) throw new ApiError(404, "user_not_found", "User not found");
  const resolved = resolveVerificationDecision(body, submission);
  await sendVerificationDecision(user.email, resolved.decision === "approved", resolved.reason);
  return { sent: true, decision: resolved.decision, submission_id: submissionId || null };
}

async function createConsultChat(body: Body, ctx: RequestContext): Promise<Row> {
  if (!ctx.auth.is_verified && ctx.auth.role !== "admin" && ctx.auth.role !== "owner") {
    throw new ApiError(403, "verification_required", "Verified membership is required for consultations");
  }
  const id = string(body, "consultation_id", true);
  const result = await prisma.$transaction(async (tx) => {
    const matches = await tx.$queryRaw<Array<{ id: string; data: Prisma.JsonValue }>>(Prisma.sql`
      SELECT id, data
      FROM legacy_records
      WHERE table_name = 'consultations' AND record_id = ${id}
      LIMIT 1
      FOR UPDATE
    `);
    const consultation = matches[0];
    if (!consultation) throw new ApiError(404, "consultation_not_found", "Consultation not found");
    const row = consultation.data as Row;
    if (row.id !== id) throw new ApiError(409, "consultation_invalid", "The consultation record is invalid");
    if (row.client_id !== ctx.auth.id && row.consultant_id !== ctx.auth.id) throw new ApiError(403, "consultation_access_denied", "You are not part of this consultation");
    if (row.status !== "confirmed") throw new ApiError(409, "consultation_not_confirmed", "The consultation must be confirmed before creating its conversation");

    let roomId = typeof row.chat_room_id === "string" ? row.chat_room_id : "";
    if (!roomId) {
      const existingRoom = await tx.legacyRecord.findUnique({ where: { table_name_record_id: { table_name: "chat_rooms", record_id: `consult:${id}` } } });
      if (existingRoom) {
        const storedRoomId = (existingRoom.data as Row).id;
        if (typeof storedRoomId !== "string" || !storedRoomId) throw new ApiError(409, "consultation_chat_invalid", "The existing consultation conversation is invalid");
        roomId = storedRoomId;
      } else {
        roomId = newId();
        await tx.legacyRecord.create({ data: {
          table_name: "chat_rooms", record_id: `consult:${id}`, community_id: ctx.auth.community_id,
          data: { id: roomId, name: "Consultation", is_group: false, consultation_id: id, created_by: ctx.auth.id, created_at: new Date().toISOString() },
        } });
      }
    }

    for (const userId of [String(row.client_id), String(row.consultant_id)]) {
      await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: "chat_members", record_id: `${roomId}:${userId}` } },
        create: { table_name: "chat_members", record_id: `${roomId}:${userId}`, owner_id: userId, community_id: ctx.auth.community_id, data: { id: newId(), room_id: roomId, user_id: userId, joined_at: new Date().toISOString() } },
        update: { owner_id: userId },
      });
    }
    const updated: Row = { ...row, chat_room_id: roomId, updated_at: new Date().toISOString() };
    await tx.legacyRecord.update({ where: { id: consultation.id }, data: { data: updated as Prisma.InputJsonValue } });
    return { roomId, updated };
  });
  emitDbChange({ table: "consultations", event: "UPDATE", row: result.updated, actor_id: ctx.auth.id,
    audience_ids: [String(result.updated.client_id), String(result.updated.consultant_id)] });
  return { room_id: result.roomId };
}

const isKlipyUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { const host = new URL(value).hostname; return host === "klipy.com" || host.endsWith(".klipy.com") || host === "klipy.co" || host.endsWith(".klipy.co"); }
  catch { return false; }
};

type KlipyCandidate = { url: string; width?: unknown; height?: unknown; hint: string };
function klipyMedia(node: unknown, depth = 0): KlipyCandidate[] {
  if (!node || typeof node !== "object" || depth > 5) return [];
  if (Array.isArray(node)) return node.flatMap((item) => klipyMedia(item, depth + 1));
  const row = node as Row;
  const own: KlipyCandidate[] = isKlipyUrl(row.url) ? [{ url: row.url, width: row.width, height: row.height, hint: String(row.type ?? "") }] : [];
  return [...own, ...Object.entries(row).flatMap(([key, value]) => klipyMedia(value, depth + 1).map((item) => ({ ...item, hint: `${key}:${item.hint}` })))];
}

async function klipySearch(body: Body, ctx: RequestContext): Promise<Row> {
  if (!ctx.auth.is_verified && ctx.auth.role !== "admin" && ctx.auth.role !== "owner") {
    throw new ApiError(403, "verification_required", "Verified membership is required for GIF search");
  }
  if (!config.KLIPY_API_KEY) throw new ApiError(503, "klipy_not_configured", "GIF search is not configured");
  const rate = klipyRateLimiter.take(ctx.auth.id);
  if (!rate.allowed) {
    throw new ApiError(429, "klipy_rate_limited", `Too many GIF requests. Try again in ${rate.retryAfterSeconds} seconds`);
  }
  const type = body.type === "stickers" ? "stickers" : "gifs";
  if (body.action === "share") {
    const slug = string(body, "slug", true).slice(0, 160);
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new ApiError(400, "invalid_klipy_item", "Invalid KLIPY item");
    const response = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(config.KLIPY_API_KEY)}/${type}/share/${encodeURIComponent(slug)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer_id: ctx.auth.id }), signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new ApiError(502, "klipy_unavailable", "GIF sharing is temporarily unavailable");
    return { success: true };
  }
  const q = string(body, "q").slice(0, 80);
  const limit = Math.max(8, Math.min(30, Number(body.limit) || 20));
  const offset = Math.max(0, Math.min(5000, Number(body.offset) || 0));
  const params = new URLSearchParams({ page: String(Math.floor(offset / limit) + 1), per_page: String(limit), customer_id: ctx.auth.id, locale: "in", content_filter: "high" });
  if (q) params.set("q", q);
  const response = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(config.KLIPY_API_KEY)}/${type}/${q ? "search" : "trending"}?${params}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new ApiError(502, "klipy_unavailable", "GIF search is temporarily unavailable");
  const payload = await response.json() as any;
  const items: unknown[] = Array.isArray(payload?.data?.data) ? payload.data.data : Array.isArray(payload?.data) ? payload.data : [];
  const results = items.flatMap((item) => {
    if (!item || typeof item !== "object" || (item as Row).type === "ad") return [];
    const record = item as Row;
    const candidates = klipyMedia(record.file ?? record.files ?? record.media ?? record);
    if (!candidates.length) return [];
    const full = candidates.find((candidate) => /original|large|hd/i.test(candidate.hint)) ?? candidates[0]!;
    const preview = candidates.find((candidate) => /preview|small|thumbnail|sm/i.test(candidate.hint)) ?? full;
    const slug = typeof record.slug === "string" ? record.slug : String(record.id ?? "");
    return slug ? [{ id: String(record.id ?? slug), slug, title: typeof record.title === "string" ? record.title : "KLIPY GIF", url: full.url, preview: preview.url, width: Number(full.width) || 320, height: Number(full.height) || 240 }] : [];
  }).slice(0, limit);
  return { results };
}

async function dailyRoom(body: Body, ctx: RequestContext): Promise<Row> {
  if (!ctx.auth.is_verified && ctx.auth.role !== "admin" && ctx.auth.role !== "owner") {
    throw new ApiError(403, "verification_required", "Verified membership is required for calls");
  }
  if (!config.DAILY_API_KEY) throw new ApiError(503, "daily_not_configured", "Audio/video calls are not configured");
  const roomId = string(body, "roomId", true);
  const mode = string(body, "mode", true);
  if (!/^[0-9a-f-]{36}$/i.test(roomId) || !new Set(["audio", "video"]).has(mode)) throw new ApiError(400, "invalid_call_request", "A valid roomId and audio/video mode are required");
  const membership = await prisma.legacyRecord.findFirst({ where: {
    table_name: "chat_members",
    owner_id: ctx.auth.id,
    data: { path: "$.room_id", equals: roomId },
  }, select: { id: true } });
  if (!membership) throw new ApiError(403, "chat_membership_required", "Chat membership is required");
  const chatRoomRecord = await prisma.legacyRecord.findFirst({ where: {
    table_name: "chat_rooms",
    data: { path: "$.id", equals: roomId },
  }, select: { id: true } });
  if (!chatRoomRecord) throw new ApiError(404, "chat_room_not_found", "Chat room was not found");
  const requestedSessionId = string(body, "sessionId");
  let session: { record: LegacyRecord; row: Row; created: boolean } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${ctx.auth.id} LIMIT 1 FOR UPDATE`);
    const [currentUser, currentProfile, currentMembership] = await Promise.all([
      tx.user.findUnique({ where: { id: ctx.auth.id }, select: { role: true, status: true } }),
      tx.profile.findUnique({ where: { user_id: ctx.auth.id }, select: { is_verified: true } }),
      tx.legacyRecord.findFirst({ where: {
        table_name: "chat_members", owner_id: ctx.auth.id,
        data: { path: "$.room_id", equals: roomId },
      }, select: { id: true } }),
    ]);
    const privileged = currentUser?.role === "admin" || currentUser?.role === "owner";
    if (!currentUser || currentUser.status !== "active" || (!privileged && !currentProfile?.is_verified)) {
      throw new ApiError(403, "verification_required", "Verified membership is required for calls");
    }
    if (!currentMembership) throw new ApiError(403, "chat_membership_required", "Chat membership is required");
    // The chat-room row is the canonical lock for starting a call. Every
    // participant in the room therefore observes or creates the same active
    // session even when call buttons are pressed concurrently.
    const lockedRoom = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM legacy_records WHERE id = ${chatRoomRecord.id} AND table_name = 'chat_rooms' LIMIT 1 FOR UPDATE`);
    if (lockedRoom.length !== 1) throw new ApiError(404, "chat_room_not_found", "Chat room was not found");
    const sessionCandidates = await tx.legacyRecord.findMany({ where: {
      table_name: "call_sessions",
      data: { path: "$.room_id", equals: roomId },
    }, orderBy: { created_at: "desc" } });
    for (const record of [...sessionCandidates].sort((left, right) => left.id.localeCompare(right.id))) {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE id = ${record.id} AND table_name = 'call_sessions' LIMIT 1 FOR UPDATE`);
    }
    const sessions = sessionCandidates.length
      ? await tx.legacyRecord.findMany({ where: { id: { in: sessionCandidates.map((record) => record.id) } }, orderBy: { created_at: "desc" } })
      : [];
    const participants = await tx.legacyRecord.findMany({ where: {
      table_name: "call_participants",
      data: { path: "$.room_id", equals: roomId },
    }, select: { id: true, data: true } });
    const now = Date.now();
    const liveSessionIds = new Set(participants.flatMap((record) => {
      const participant = record.data as Row;
      return dailyParticipantLeaseIsFresh(participant, now) && typeof participant.session_id === "string" ? [participant.session_id] : [];
    }));
    const activeSessions: Array<{ record: LegacyRecord; row: Row; created: boolean }> = [];
    for (const record of sessions) {
      const row = record.data as Row;
      if (row.room_id !== roomId || row.ended_at) continue;
      if (dailySessionCanBeReused(row, liveSessionIds.has(String(row.id)), now)) {
        activeSessions.push({ record, row, created: false });
      } else {
        const endedAt = new Date(now).toISOString();
        await tx.legacyRecord.update({ where: { id: record.id }, data: { data: {
          ...row, ended_at: endedAt, failure_reason: "session_expired",
        } as Prisma.InputJsonValue } });
        for (const participant of participants) {
          const participantRow = participant.data as Row;
          if (participantRow.session_id === row.id && !participantRow.left_at) {
            await tx.legacyRecord.update({ where: { id: participant.id }, data: { data: {
              ...participantRow, left_at: endedAt, updated_at: endedAt,
            } as Prisma.InputJsonValue } });
          }
        }
      }
    }
    const active = requestedSessionId
      ? activeSessions.find(({ row }) => row.id === requestedSessionId)
      : activeSessions[0];
    if (requestedSessionId && !active) throw new ApiError(410, "call_invite_expired", "This call invitation has expired");
    if (active && active.row.mode !== mode) throw new ApiError(400, "call_mode_mismatch", "The active call mode does not match this request");
    if (active) return active;
    const id = newId();
    const row = { id, room_id: roomId, daily_room_name: dailyRoomNameForSession(id), started_by: ctx.auth.id, mode, started_at: new Date().toISOString(), ended_at: null };
    const record = await tx.legacyRecord.create({ data: { table_name: "call_sessions", record_id: String(row.id), owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: row } });
    return { record, row, created: true };
  });
  const roomName = typeof session.row.daily_room_name === "string" ? session.row.daily_room_name : dailyRoomNameForSession(String(session.row.id));
  const closeNewFailedSession = async (failureReason: string): Promise<void> => {
    if (!session.created) return;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE id = ${session.record.id} AND table_name = 'call_sessions' LIMIT 1 FOR UPDATE`);
      const freshRecord = await tx.legacyRecord.findUnique({ where: { id: session.record.id } });
      const fresh = freshRecord?.data as Row | undefined;
      if (!freshRecord || !fresh || fresh.ended_at || fresh.invite_sent_at) return;
      const participants = await tx.legacyRecord.findMany({ where: {
        table_name: "call_participants",
        data: { path: "$.session_id", equals: String(session.row.id) },
      }, select: { data: true } });
      if (participants.some((participant) => dailyParticipantLeaseIsFresh(participant.data as Row))) return;
      await tx.legacyRecord.update({
        where: { id: freshRecord.id },
        data: { data: { ...fresh, ended_at: new Date().toISOString(), failure_reason: failureReason } as Prisma.InputJsonValue },
      });
    });
  };
  const headers = { Authorization: `Bearer ${config.DAILY_API_KEY}`, "Content-Type": "application/json" };
  let room: Row;
  try {
    room = await provisionPrivateDailyRoom({ roomName, mode: mode as "audio" | "video", headers });
  } catch (error) {
    const failureReason = error instanceof DailyRoomProvisionError
      ? `daily_room:${error.providerStatus}`
      : "daily_room:network_error";
    await closeNewFailedSession(failureReason);
    throw new ApiError(502, "daily_room_failed", "The call room could not be created");
  }
  const profile = await prisma.profile.findUnique({ where: { user_id: ctx.auth.id } });
  let token: Row;
  try {
    const tokenResponse = await fetch("https://api.daily.co/v1/meeting-tokens", {
      method: "POST",
      headers,
      body: JSON.stringify(dailyMeetingTokenPayload(roomName, mode as "audio" | "video", {
        id: ctx.auth.id,
        name: profile?.name ?? "User",
      })),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) throw new ApiError(502, "daily_token_failed", "The call token could not be created");
    token = await tokenResponse.json() as Row;
  } catch (error) {
    await closeNewFailedSession(error instanceof ApiError ? `daily_token:${error.code}` : "daily_token:network_error");
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "daily_token_failed", "The call token could not be created");
  }
  const url = typeof room.url === "string" ? room.url : config.DAILY_DOMAIN ? `https://${config.DAILY_DOMAIN.replace(/^https?:\/\//, "")}/${roomName}` : "";
  if (!url || typeof token.token !== "string") {
    await closeNewFailedSession("daily_provider:invalid_response");
    throw new ApiError(502, "daily_invalid_response", "The call provider response was incomplete");
  }
  let invitation: { savedNotifications: Row[]; nextSession: Row; memberIds: string[]; startedBy: string } | null = null;
  try {
    invitation = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${ctx.auth.id} LIMIT 1 FOR UPDATE`);
    const [currentUser, currentProfile, currentMembership] = await Promise.all([
      tx.user.findUnique({ where: { id: ctx.auth.id }, select: { role: true, status: true } }),
      tx.profile.findUnique({ where: { user_id: ctx.auth.id }, select: { is_verified: true } }),
      tx.legacyRecord.findFirst({ where: {
        table_name: "chat_members", owner_id: ctx.auth.id,
        data: { path: "$.room_id", equals: roomId },
      }, select: { id: true } }),
    ]);
    const privileged = currentUser?.role === "admin" || currentUser?.role === "owner";
    if (!currentUser || currentUser.status !== "active" || (!privileged && !currentProfile?.is_verified)) {
      throw new ApiError(403, "verification_required", "Verified membership is required for calls");
    }
    if (!currentMembership) throw new ApiError(403, "chat_membership_required", "Chat membership is required");
    await tx.$queryRaw(Prisma.sql`SELECT id FROM legacy_records WHERE id = ${session.record.id} AND table_name = 'call_sessions' LIMIT 1 FOR UPDATE`);
    const freshRecord = await tx.legacyRecord.findUnique({ where: { id: session.record.id } });
    const freshSession = freshRecord?.data as Row | undefined;
    if (!freshRecord || !freshSession || freshSession.ended_at) throw new ApiError(410, "call_invite_expired", "This call invitation has expired");
    if (freshSession.invite_sent_at) return null;
    const allMemberships = await tx.legacyRecord.findMany({ where: {
      table_name: "chat_members",
      data: { path: "$.room_id", equals: roomId },
    } });
    const memberIds = [...new Set(allMemberships.flatMap((record) => {
      const membership = record.data as Row;
      return membership.room_id === roomId && typeof membership.user_id === "string" ? [membership.user_id] : [];
    }))];
    const startedBy = typeof freshSession.started_by === "string" ? freshSession.started_by : ctx.auth.id;
    const inviter = startedBy === ctx.auth.id ? profile : await tx.profile.findUnique({ where: { user_id: startedBy } });
    const inviteMode = freshSession.mode === "video" ? "video" : "audio";
    const expiresAt = new Date(new Date(String(freshSession.started_at)).getTime() + 5 * 60_000).toISOString();
    const notificationRows = memberIds.filter((userId) => userId !== startedBy).map((userId) => ({
      id: newId(), user_id: userId, title: `${inviter?.name || "A connection"} is calling`,
      message: `Incoming ${inviteMode} call`, type: "call_invite", is_read: false,
      room_id: roomId, call_mode: inviteMode, call_session_id: freshSession.id,
      started_by: startedBy, expires_at: expiresAt, created_at: new Date().toISOString(),
      link: `/chats/${roomId}?call=${inviteMode}&session=${encodeURIComponent(String(freshSession.id))}`,
    }));
    const savedNotifications = [];
    for (const notification of notificationRows) {
      const record = await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: "notifications", record_id: `call:${freshSession.id}:${notification.user_id}` } },
        create: { table_name: "notifications", record_id: `call:${freshSession.id}:${notification.user_id}`, owner_id: String(notification.user_id), community_id: ctx.auth.community_id, data: notification as Prisma.InputJsonValue },
        update: { data: notification as Prisma.InputJsonValue },
      });
      savedNotifications.push(record.data as Row);
    }
    const nextSession: Row = { ...freshSession, invite_sent_at: new Date().toISOString() };
    await tx.legacyRecord.update({ where: { id: freshRecord.id }, data: { data: nextSession as Prisma.InputJsonValue } });
    return { savedNotifications, nextSession, memberIds, startedBy };
    });
  } catch (error) {
    await closeNewFailedSession("call_authorization_changed");
    const authorizationChanged = error instanceof ApiError
      && new Set(["verification_required", "chat_membership_required", "call_invite_expired"]).has(error.code);
    if (session.created || authorizationChanged) {
      const cleanup = await revokeDailyUserRooms([roomName], ctx.auth.id, config.DAILY_API_KEY ?? "");
      if (cleanup.failed > 0) {
        logger.error({ room_name: roomName, session_id: session.row.id }, "Failed to remove a Daily room after final call authorization changed");
      }
    }
    throw error;
  }
  if (invitation) {
    session = { ...session, row: invitation.nextSession };
    for (const notification of invitation.savedNotifications) {
      emitDbChange({ table: "notifications", event: "INSERT", row: notification, actor_id: invitation.startedBy, audience_ids: [String(notification.user_id)] });
    }
    emitDbChange({ table: "call_sessions", event: "INSERT", row: session.row, actor_id: invitation.startedBy, room: `room-${roomId}`, audience_ids: invitation.memberIds });
  }
  return { url, token: token.token, roomName, sessionId: session.row.id };
}

export interface FunctionResult { payload: unknown; session?: SessionResult }

export async function invokeFunction(name: string, body: Body, ctx: RequestContext | undefined, meta: SessionMeta): Promise<FunctionResult> {
  switch (name) {
    case "request-login-otp": return { payload: await issueEmailOtp(string(body, "email", true), "login", meta) };
    case "verify-login-otp": {
      const session = await verifyEmailOtp(string(body, "email", true), string(body, "code", true), "login", meta);
      return { payload: { access_token: session.access_token, expires_in: session.expires_in, token_type: session.token_type, user: session.user }, session };
    }
    case "request-password-reset": return { payload: { accepted: true, ...(await requestPasswordReset(string(body, "email", true))) } };
    case "send-verification-email": return { payload: await issueInstituteOtp(body, authenticated(ctx)) };
    case "verify-iit-email": return { payload: await verifyInstitute(body, authenticated(ctx)) };
    case "notify-verification-decision": return { payload: await notifyDecision(body, admin(ctx)) };
    case "manage-users": return { payload: await manageUsers(body, admin(ctx)) };
    case "seed-data": return { payload: await seedData(body, admin(ctx)) };
    case "scan-jobs": return { payload: await scanWithAi("jobs", body, admin(ctx)) };
    case "scan-events": return { payload: await scanWithAi("events", body, admin(ctx)) };
    case "create-consult-chat": return { payload: await createConsultChat(body, authenticated(ctx)) };
    case "dispatch-realtime-outbox": return { payload: { dispatched: 0, mode: "socket.io" } };
    case "klipy-search": return { payload: await klipySearch(body, authenticated(ctx)) };
    case "daily-create-room": return { payload: await dailyRoom(body, authenticated(ctx)) };
    default: throw new ApiError(404, "function_not_found", `Function ${name} is not available`);
  }
}
