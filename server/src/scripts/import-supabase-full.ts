import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { legacyTables } from "../services/data.js";
import { putObjectNew } from "../services/objectStore.js";

type Row = Record<string, unknown>;
type Manifest = {
  users: Row[];
  tables: Record<string, Row[]>;
  buckets: Array<{ id: string; public?: boolean }>;
  storage: Record<string, Array<Row & { path: string }>>;
};

const source = process.argv.find((value) => value.startsWith("--file="))?.slice(7);
const apply = process.argv.includes("--apply");
const uploadObjects = process.argv.includes("--upload-objects");
if (!source) throw new Error("Usage: tsx server/src/scripts/import-supabase-full.ts --file=/absolute/manifest.json [--apply] [--upload-objects]");
const manifestPath = path.resolve(source);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const storageRoot = path.join(path.dirname(manifestPath), "storage");
if (!Array.isArray(manifest.users) || !manifest.tables || !manifest.storage) throw new Error("Invalid Supabase export manifest");

const date = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid exported date: ${value}`);
  return parsed;
};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const bool = (value: unknown, fallback = false): boolean => typeof value === "boolean" ? value : fallback;
const json = (value: unknown): Prisma.InputJsonValue | undefined => value === null || value === undefined ? undefined : value as Prisma.InputJsonValue;
const rows = (table: string): Row[] => manifest.tables[table] || [];
const knownUsers = new Set(manifest.users.map((user) => String(user.id)));
const ownerRole = new Map<string, string>();
for (const row of rows("user_roles")) if (knownUsers.has(String(row.user_id))) ownerRole.set(String(row.user_id), String(row.role || "member"));
for (const row of rows("platform_owners")) if (knownUsers.has(String(row.user_id))) ownerRole.set(String(row.user_id), "owner");

const typedTables = new Set(["profiles", "posts", "comments", "reactions", "reports", "connections", "jobs", "applications", "events", "rsvps", "user_roles", "platform_owners"]);
for (const table of typedTables) {
  if (!Array.isArray(manifest.tables[table] || [])) throw new Error(`Missing typed table export: ${table}`);
}

const summary = {
  users: manifest.users.length,
  profiles: rows("profiles").length,
  posts: rows("posts").length,
  connections: rows("connections").length,
  jobs: rows("jobs").length,
  events: rows("events").length,
  legacy: Object.entries(manifest.tables).filter(([table]) => legacyTables.has(table) && table !== "user_roles").reduce((sum, [, values]) => sum + values.length, 0),
  objects: Object.values(manifest.storage).reduce((sum, values) => sum + values.length, 0),
};
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: "plan", ...summary }, null, 2)}\n`);
  await prisma.$disconnect();
  process.exit(0);
}

await prisma.$transaction(async (tx) => {
  for (const sourceUser of manifest.users) {
    const id = String(sourceUser.id);
    const email = text(sourceUser.email)?.toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(id) || !email) throw new Error("Supabase auth user is missing a stable UUID/email");
    const metadata = sourceUser.user_metadata && typeof sourceUser.user_metadata === "object" ? sourceUser.user_metadata as Row : {};
    const confirmed = date(sourceUser.email_confirmed_at ?? sourceUser.confirmed_at);
    await tx.user.upsert({
      where: { id },
      create: { id, email, phone: text(sourceUser.phone), role: ownerRole.get(id) || "member", status: confirmed ? "active" : "pending", email_verified_at: confirmed, last_login_at: date(sourceUser.last_sign_in_at), created_at: date(sourceUser.created_at), updated_at: date(sourceUser.updated_at) },
      update: { email, phone: text(sourceUser.phone), role: ownerRole.get(id) || "member", status: confirmed ? "active" : "pending", email_verified_at: confirmed, last_login_at: date(sourceUser.last_sign_in_at) },
    });
    const providers = sourceUser.app_metadata && typeof sourceUser.app_metadata === "object" && Array.isArray((sourceUser.app_metadata as Row).providers)
      ? (sourceUser.app_metadata as Row).providers as unknown[] : [];
    if (providers.includes("google")) {
      const subject = text(metadata.provider_id) || text(metadata.sub);
      if (!subject) throw new Error(`Google user ${id} has no exported provider subject`);
      await tx.authIdentity.upsert({
        where: { provider_provider_subject: { provider: "google", provider_subject: subject } },
        create: { user_id: id, provider: "google", provider_subject: subject, provider_email: email },
        update: { user_id: id, provider_email: email },
      });
    }
  }

  for (const row of rows("profiles")) {
    const userId = String(row.user_id);
    if (!knownUsers.has(userId)) throw new Error(`Profile references missing user ${userId}`);
    const data = {
      name: text(row.name), slug: text(row.slug), avatar_url: text(row.avatar_url), cover_photo_url: text(row.cover_photo_url),
      headline: text(row.headline), bio: text(row.bio), location: text(row.location), date_of_birth: date(row.date_of_birth),
      phone_country_code: text(row.phone_country_code), phone_number: text(row.phone_number), phone_full: text(row.phone_full),
      iit_email: text(row.iit_email)?.toLowerCase(), iit_name: text(row.iit_name), student_status: text(row.student_status),
      community_id: text(row.community_id) || "iit-community", role: ownerRole.get(userId) || text(row.role) || "member",
      is_verified: bool(row.is_verified), onboarding_completed: bool(row.onboarding_completed), is_mentor: bool(row.is_mentor),
      mentor_category: text(row.mentor_category), mentor_price_chat: text(row.mentor_price_chat), mentor_price_audio: text(row.mentor_price_audio), mentor_price_video: text(row.mentor_price_video),
      expertise: json(row.expertise), skills: json(row.skills), experience: json(row.experience), social_links: json(row.social_links),
      primary_education_id: text(row.primary_education_id), slug_updated_at: date(row.slug_updated_at), created_at: date(row.created_at),
    };
    await tx.profile.upsert({ where: { user_id: userId }, create: { user_id: userId, ...data }, update: data });
  }

  for (const row of rows("connections")) {
    const requester = String(row.requester_id); const receiver = String(row.receiver_id);
    if (!knownUsers.has(requester) || !knownUsers.has(receiver)) throw new Error(`Connection ${row.id} references a missing user`);
    const data = { requester_id: requester, receiver_id: receiver, pair_key: [requester, receiver].sort().join(":"), status: String(row.status || "pending"), note: text(row.note), responded_at: date(row.responded_at), created_at: date(row.created_at) };
    await tx.connection.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }

  for (const row of rows("posts")) {
    const data = { author_id: text(row.author_id), content: String(row.content || ""), community_id: text(row.community_id) || "iit-community", channel: text(row.channel), scope_type: text(row.scope_type) || "GLOBAL", scope_key: text(row.scope_key) || "IIT_ALL", is_anonymous: bool(row.is_anonymous), tags: json(row.tags), campus_filter: text(row.campus_filter), degree_filter: text(row.degree_filter), branch_filter: text(row.branch_filter), batch_filter: text(row.batch_filter), cohort_filter: text(row.cohort_filter), student_status_filter: text(row.student_status_filter), image_url: text(row.image_url), image_path: text(row.image_path), file_url: text(row.file_url), file_path: text(row.file_path), file_name: text(row.file_name), file_type: text(row.file_type), file_size: row.file_size == null ? undefined : BigInt(String(row.file_size)), voice_url: text(row.voice_url), voice_path: text(row.voice_path), voice_duration: row.voice_duration == null ? undefined : Number(row.voice_duration), is_deleted_for_everyone: bool(row.is_deleted_for_everyone), deleted_by_user_id: text(row.deleted_by_user_id), deleted_for_users: json(row.deleted_for_users), seen_by: json(row.seen_by), deleted_at: date(row.deleted_at), edited_at: date(row.edited_at), pinned_at: date(row.pinned_at), created_at: date(row.created_at) };
    await tx.post.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of rows("posts")) await tx.post.update({ where: { id: String(row.id) }, data: { reply_to_id: text(row.reply_to_id), reshared_post_id: text(row.reshared_post_id) } });

  for (const row of rows("jobs")) {
    const data = { title: String(row.title || "Untitled role"), created_by: text(row.created_by), community_id: text(row.community_id) || "iit-community", company: String(row.company || "Unknown"), location: text(row.location), job_type: text(row.job_type), category: text(row.category), experience: text(row.experience), experience_level: text(row.experience_level), easy_apply: bool(row.easy_apply), description: text(row.description), application_url: text(row.application_url), apply_url: text(row.apply_url), source_url: text(row.source_url), source_type: text(row.source_type), status: text(row.status) || "published", salary_text: text(row.salary_text), skills: json(row.skills), source_fingerprint: text(row.source_fingerprint), scan_run_id: text(row.scan_run_id), expires_at: date(row.expires_at), published_at: date(row.published_at), created_at: date(row.created_at) };
    await tx.job.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of rows("events")) {
    const start = date(row.start_time); if (!start) throw new Error(`Event ${row.id} has no start_time`);
    const data = { title: String(row.title || "Untitled event"), description: text(row.description), location: text(row.location), start_time: start, end_time: date(row.end_time), registration_url: text(row.registration_url), organizer: text(row.organizer), source_iit: text(row.source_iit), audience_mode: text(row.audience_mode), target_iits: json(row.target_iits), target_courses: json(row.target_courses), target_specialisations: json(row.target_specialisations), source_url: text(row.source_url), source_fingerprint: text(row.source_fingerprint), scan_run_id: text(row.scan_run_id), source_type: text(row.source_type), status: text(row.status) || "draft", community_id: text(row.community_id) || "iit-community", created_by: text(row.created_by), published_at: date(row.published_at), created_at: date(row.created_at) };
    await tx.event.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of rows("rsvps")) {
    const data = { event_id: String(row.event_id), user_id: String(row.user_id), status: text(row.status) || "going", created_at: date(row.created_at) };
    await tx.rsvp.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }

  const ownershipFields: Record<string, string[]> = {
    messages: ["sender_id"], chat_members: ["user_id"], call_participants: ["user_id"], consultations: ["client_id"], blog_comments: ["author_id"], blog_bookmarks: ["user_id"], blog_likes: ["user_id"], course_verification_requests: ["user_id"], document_verifications: ["user_id"], education: ["user_id"], forum_room_state: ["user_id"], notifications: ["user_id"], professional_experience: ["user_id"], saved_views: ["user_id"], stories: ["user_id", "author_id"], user_pinned_messages: ["user_id"], verifications: ["user_id"], verified_academic_affiliations: ["user_id"], poll_votes: ["user_id"], polls: ["created_by"],
  };
  // The Supabase catalog key is composite. Remove only records produced by the
  // earlier lossy single-column importer; legitimate composite keys contain `:`.
  await tx.legacyRecord.deleteMany({
    where: { table_name: "academic_specialisations", NOT: { record_id: { contains: ":" } } },
  });
  for (const [table, values] of Object.entries(manifest.tables)) {
    if (!legacyTables.has(table) || table === "user_roles") continue;
    for (const row of values) {
      const recordId = table === "academic_specialisations"
        ? `${String(row.degree_id)}:${String(row.id)}`
        : text(row.id) || (table === "forum_room_state" ? `${row.user_id}:${row.scope_type}:${row.scope_key}` : table === "verified_academic_affiliations" ? String(row.user_id) : undefined);
      if (!recordId) throw new Error(`${table} row has no stable import identity`);
      const owner = (ownershipFields[table] || []).map((field) => text(row[field])).find(Boolean);
      if (owner && !knownUsers.has(owner)) throw new Error(`${table}/${recordId} references missing owner ${owner}`);
      await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: table, record_id: recordId } },
        create: { table_name: table, record_id: recordId, owner_id: owner, community_id: text(row.community_id), data: row as Prisma.InputJsonValue, created_at: date(row.created_at) },
        update: { owner_id: owner, community_id: text(row.community_id), data: row as Prisma.InputJsonValue },
      });
    }
  }
}, { timeout: 180_000 });

const publicBuckets = new Set(manifest.buckets.filter((bucket) => bucket.public).map((bucket) => bucket.id));
for (const [bucket, objects] of Object.entries(manifest.storage)) {
  for (const object of objects) {
    const objectPath = String(object.path);
    const localPath = path.join(storageRoot, bucket, ...objectPath.split("/"));
    const bytes = await readFile(localPath);
    const key = `${bucket}/${objectPath}`;
    if (uploadObjects) {
      try { await putObjectNew(key, bytes, text(object.metadata && typeof object.metadata === "object" ? (object.metadata as Row).mimetype : undefined)); }
      catch (error) { if ((error as { name?: string }).name !== "PreconditionFailed") throw error; }
    }
    const firstSegment = objectPath.split("/")[0] || "";
    const uploadedBy = knownUsers.has(firstSegment) ? firstSegment : undefined;
    const info = await stat(localPath);
    const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as Row : {};
    await prisma.fileObject.upsert({
      where: { object_key: key },
      create: { uploaded_by: uploadedBy, bucket, object_key: key, original_name: path.basename(objectPath).slice(0, 255), mime_type: text(metadata.mimetype) || "application/octet-stream", size_bytes: info.size, visibility: publicBuckets.has(bucket) ? "public" : "private", sha256: createHash("sha256").update(bytes).digest("hex") },
      update: { uploaded_by: uploadedBy, size_bytes: info.size, visibility: publicBuckets.has(bucket) ? "public" : "private", sha256: createHash("sha256").update(bytes).digest("hex"), status: "ready", deleted_at: null },
    });
  }
}

process.stdout.write(`${JSON.stringify({ mode: "applied", upload_objects: uploadObjects, ...summary }, null, 2)}\n`);
await prisma.$disconnect();
