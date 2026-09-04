import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { hashOtp, hashPassword, keyedHash, newId, randomOtp, verifyOtpHash } from "../security/crypto.js";
import type { RequestContext } from "../types.js";
import { issueEmailOtp, normalizeEmail, requestPasswordReset, verifyEmailOtp, type SessionMeta, type SessionResult } from "./auth.js";
import { scanWithAi } from "./ai.js";
import { sendInstituteCode, sendVerificationDecision } from "./mail.js";
import { writeAudit } from "./audit.js";
import { emitDbChange } from "../realtime/events.js";
import { DailyRoomProvisionError, provisionPrivateDailyRoom } from "./daily.js";

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;

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
  if (own?.iit_email === email && own.is_verified) return { already_verified: true };
  const recent = await prisma.emailOtp.count({ where: { destination_hash: keyedHash(email), purpose: "institute", created_at: { gte: new Date(Date.now() - 15 * 60_000) } } });
  if (recent >= 5) throw new ApiError(429, "otp_rate_limited", "Too many code requests. Try again later");
  const code = randomOtp();
  await prisma.emailOtp.create({ data: { user_id: ctx.auth.id, email, destination_hash: keyedHash(email), code_hash: await hashOtp(code), purpose: "institute", expires_at: new Date(Date.now() + 10 * 60_000), ip_hash: ctx.ip ? keyedHash(ctx.ip) : undefined } });
  await sendInstituteCode(email, code);
  return config.NODE_ENV === "production" ? { sent: true } : { sent: true, debug_code: code };
}

async function verifyInstitute(body: Body, ctx: RequestContext): Promise<Row> {
  const email = normalizeEmail(string(body, "email", true));
  const iit = string(body, "iit_name", true);
  const status = string(body, "student_status", true);
  const code = string(body, "code", true);
  if (!new Set(["current_student", "alumni"]).has(status)) throw new ApiError(400, "invalid_student_status", "Member type is invalid");
  const domains = instituteDomains[iit];
  const expected = status === "alumni" ? domains?.[1] : domains?.[0];
  if (!expected || email.split("@")[1] !== expected) throw new ApiError(400, "invalid_institute_email", `Use the official ${iit} email domain`);
  const challenge = await prisma.emailOtp.findFirst({ where: { user_id: ctx.auth.id, destination_hash: keyedHash(email), purpose: "institute", consumed_at: null }, orderBy: { created_at: "desc" } });
  if (!challenge || challenge.expires_at <= new Date() || challenge.attempts >= challenge.max_attempts) throw new ApiError(400, "invalid_otp", "The code is invalid or expired");
  await prisma.emailOtp.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
  if (!(await verifyOtpHash(code, challenge.code_hash))) throw new ApiError(400, "invalid_otp", "The code is invalid or expired");
  await prisma.$transaction(async (tx) => {
    await tx.emailOtp.update({ where: { id: challenge.id }, data: { consumed_at: new Date() } });
    await tx.profile.upsert({ where: { user_id: ctx.auth.id }, create: { user_id: ctx.auth.id, iit_email: email, iit_name: iit, student_status: status, is_verified: true, community_id: config.DEFAULT_COMMUNITY_ID }, update: { iit_email: email, iit_name: iit, student_status: status, is_verified: true } });
    const affiliationId = newId();
    await tx.legacyRecord.upsert({ where: { table_name_record_id: { table_name: "verified_academic_affiliations", record_id: ctx.auth.id } }, create: { table_name: "verified_academic_affiliations", record_id: ctx.auth.id, owner_id: ctx.auth.id, community_id: config.DEFAULT_COMMUNITY_ID, data: { id: affiliationId, user_id: ctx.auth.id, institute_name: iit, institute_email: email, verification_status: "VERIFIED", student_status: status, verified_at: new Date().toISOString() } }, update: { data: { id: affiliationId, user_id: ctx.auth.id, institute_name: iit, institute_email: email, verification_status: "VERIFIED", student_status: status, verified_at: new Date().toISOString() } } });
  });
  return { verified: true, email, iit_name: iit };
}

async function manageUsers(body: Body, ctx: RequestContext): Promise<Row> {
  admin(ctx);
  const action = string(body, "action", true);
  if (action === "create_member") {
    const email = normalizeEmail(string(body, "email", true));
    const password = string(body, "password", true);
    if (password.length < 10) throw new ApiError(400, "weak_password", "Password must contain at least ten characters");
    const user = await prisma.user.create({ data: { email, password_hash: await hashPassword(password), status: "active", email_verified_at: new Date(), profile: { create: { name: string(body, "name", true), iit_name: string(body, "iit_name") || "IIT Delhi", student_status: string(body, "student_status") || "current_student", is_verified: true, onboarding_completed: true, community_id: config.DEFAULT_COMMUNITY_ID } } } });
    await writeAudit({ actor_id: ctx.auth.id, action: "admin.create_member", resource_type: "user", resource_id: user.id, ip: ctx.ip });
    return { user_id: user.id, created: true };
  }
  if (action === "delete_member") {
    const userId = string(body, "user_id", true);
    if (userId === ctx.auth.id) throw new ApiError(400, "cannot_delete_self", "You cannot delete your own account here");
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
    if (!user || string(body, "confirmation", true) !== (user.profile?.name ?? "Unnamed member")) throw new ApiError(400, "confirmation_mismatch", "The confirmation does not match the member name");
    await prisma.$transaction([prisma.legacyRecord.deleteMany({ where: { owner_id: userId } }), prisma.user.delete({ where: { id: userId } })]);
    await writeAudit({ actor_id: ctx.auth.id, action: "admin.delete_member", resource_type: "user", resource_id: userId, ip: ctx.ip, metadata: { email_hash: keyedHash(user.email) } });
    return { user_id: userId, deleted: true };
  }
  throw new ApiError(400, "unsupported_action", "Unsupported manage-users action");
}

async function seedData(body: Body, ctx: RequestContext): Promise<Row> {
  admin(ctx);
  if (config.NODE_ENV === "production" || !config.ENABLE_SEED_DATA) throw new ApiError(403, "seed_data_disabled", "Test data operations are disabled");
  const action = string(body, "action", true);
  const testUsers = await prisma.user.findMany({ where: { email: { endsWith: "@cirkle.invalid" } } });
  if (action === "purge") {
    await prisma.user.deleteMany({ where: { id: { in: testUsers.map((user) => user.id) } } });
    return { deletedUsers: testUsers.length };
  }
  if (action !== "seed") throw new ApiError(400, "unsupported_action", "Action must be seed or purge");
  let messagesCreated = 0;
  for (let index = 1; index <= 5; index += 1) {
    const email = `test+${index}@cirkle.invalid`;
    const user = await prisma.user.upsert({ where: { email }, create: { email, status: "active", email_verified_at: new Date(), profile: { create: { name: `Test Member ${index}`, is_verified: true, onboarding_completed: true, community_id: config.DEFAULT_COMMUNITY_ID } } }, update: {} });
    const exists = await prisma.post.findFirst({ where: { author_id: user.id, client_id: `seed-${index}` } });
    if (!exists) { await prisma.post.create({ data: { author_id: user.id, content: `Seeded community message ${index}`, community_id: config.DEFAULT_COMMUNITY_ID, scope_type: "GLOBAL", scope_key: "IIT_ALL", client_id: `seed-${index}` } }); messagesCreated += 1; }
  }
  return { usersCreated: 5, messagesCreated };
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
  if (!config.KLIPY_API_KEY) throw new ApiError(503, "klipy_not_configured", "GIF search is not configured");
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
  const roomName = `cirkle-${roomId.replace(/-/g, "").slice(0, 24)}`;
  const sessions = await prisma.legacyRecord.findMany({ where: {
    table_name: "call_sessions",
    data: { path: "$.room_id", equals: roomId },
  }, orderBy: { created_at: "desc" } });
  const activeSessions = sessions.map((record) => ({ record, row: record.data as Row })).filter(({ row }) => row.room_id === roomId && !row.ended_at && Date.now() - new Date(String(row.started_at)).getTime() < 5 * 60_000);
  const requestedSessionId = string(body, "sessionId");
  let session = requestedSessionId
    ? activeSessions.find(({ row }) => row.id === requestedSessionId)
    : activeSessions[0];
  if (requestedSessionId && !session) throw new ApiError(410, "call_invite_expired", "This call invitation has expired");
  if (requestedSessionId && session?.row.mode !== mode) throw new ApiError(400, "call_mode_mismatch", "The call invitation mode does not match this request");
  if (!session) {
    const row = { id: newId(), room_id: roomId, daily_room_name: roomName, started_by: ctx.auth.id, mode, started_at: new Date().toISOString(), ended_at: null };
    const record = await prisma.legacyRecord.create({ data: { table_name: "call_sessions", record_id: String(row.id), owner_id: ctx.auth.id, community_id: ctx.auth.community_id, data: row } });
    session = { record, row };
  }
  const headers = { Authorization: `Bearer ${config.DAILY_API_KEY}`, "Content-Type": "application/json" };
  let room: Row;
  try {
    room = await provisionPrivateDailyRoom({ roomName, mode: mode as "audio" | "video", headers });
  } catch (error) {
    const failureReason = error instanceof DailyRoomProvisionError
      ? `daily_room:${error.providerStatus}`
      : "daily_room:network_error";
    await prisma.legacyRecord.update({ where: { id: session.record.id }, data: { data: { ...session.row, ended_at: new Date().toISOString(), failure_reason: failureReason } as Prisma.InputJsonValue } });
    throw new ApiError(502, "daily_room_failed", "The call room could not be created");
  }
  const profile = await prisma.profile.findUnique({ where: { user_id: ctx.auth.id } });
  const tokenResponse = await fetch("https://api.daily.co/v1/meeting-tokens", { method: "POST", headers, body: JSON.stringify({ properties: { room_name: roomName, user_name: profile?.name ?? "User", user_id: ctx.auth.id, exp: Math.floor(Date.now() / 1000) + 3600, start_video_off: mode === "audio" } }), signal: AbortSignal.timeout(10_000) });
  if (!tokenResponse.ok) throw new ApiError(502, "daily_token_failed", "The call token could not be created");
  const token = await tokenResponse.json() as Row;
  const url = typeof room.url === "string" ? room.url : config.DAILY_DOMAIN ? `https://${config.DAILY_DOMAIN.replace(/^https?:\/\//, "")}/${roomName}` : "";
  if (!url || typeof token.token !== "string") throw new ApiError(502, "daily_invalid_response", "The call provider response was incomplete");
  if (!session.row.invite_sent_at) {
    const allMemberships = await prisma.legacyRecord.findMany({ where: {
      table_name: "chat_members",
      data: { path: "$.room_id", equals: roomId },
    } });
    const memberIds = [...new Set(allMemberships.flatMap((record) => {
      const membership = record.data as Row;
      return membership.room_id === roomId && typeof membership.user_id === "string" ? [membership.user_id] : [];
    }))];
    const startedBy = typeof session.row.started_by === "string" ? session.row.started_by : ctx.auth.id;
    const inviter = startedBy === ctx.auth.id ? profile : await prisma.profile.findUnique({ where: { user_id: startedBy } });
    const inviteMode = session.row.mode === "video" ? "video" : "audio";
    const expiresAt = new Date(new Date(String(session.row.started_at)).getTime() + 5 * 60_000).toISOString();
    const recipientIds = memberIds.filter((userId) => userId !== startedBy);
    const notificationRows = recipientIds.map((userId) => ({
      id: newId(), user_id: userId, title: `${inviter?.name || "A connection"} is calling`,
      message: `Incoming ${inviteMode} call`, type: "call_invite", is_read: false,
      room_id: roomId, call_mode: inviteMode, call_session_id: session!.row.id,
      started_by: startedBy, expires_at: expiresAt, created_at: new Date().toISOString(),
      link: `/chats/${roomId}?call=${inviteMode}&session=${encodeURIComponent(String(session!.row.id))}`,
    }));
    const savedNotifications = await prisma.$transaction(async (tx) => {
      const saved = [];
      for (const notification of notificationRows) {
        const record = await tx.legacyRecord.upsert({
          where: { table_name_record_id: { table_name: "notifications", record_id: `call:${session!.row.id}:${notification.user_id}` } },
          create: { table_name: "notifications", record_id: `call:${session!.row.id}:${notification.user_id}`, owner_id: String(notification.user_id), community_id: ctx.auth.community_id, data: notification as Prisma.InputJsonValue },
          update: { data: notification as Prisma.InputJsonValue },
        });
        saved.push(record.data as Row);
      }
      const nextSession = { ...session!.row, invite_sent_at: new Date().toISOString() };
      await tx.legacyRecord.update({ where: { id: session!.record.id }, data: { data: nextSession as Prisma.InputJsonValue } });
      session = { record: session!.record, row: nextSession };
      return saved;
    });
    for (const notification of savedNotifications) {
      emitDbChange({ table: "notifications", event: "INSERT", row: notification, actor_id: startedBy, audience_ids: [String(notification.user_id)] });
    }
    emitDbChange({ table: "call_sessions", event: "INSERT", row: session.row, actor_id: startedBy, room: `room-${roomId}`, audience_ids: memberIds });
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
