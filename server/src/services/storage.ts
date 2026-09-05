import { createHmac, timingSafeEqual } from "node:crypto";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import type { Express } from "express";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { sha256 } from "../security/crypto.js";
import { canUseForumScope } from "../security/forumScope.js";
import type { RequestContext } from "../types.js";
import { writeAudit } from "./audit.js";
import { isDeletedForEveryone, mediaReferencesRevoked } from "../security/tombstone.js";
import { deleteObjectBytes, putObjectNew, readObjectBytes } from "./objectStore.js";

interface BucketPolicy { visibility: "public" | "private"; max: number; mime: RegExp; admin?: boolean }
const mb = 1024 * 1024;
const buckets: Record<string, BucketPolicy> = {
  avatars: { visibility: "public", max: 5 * mb, mime: /^image\/(jpeg|png|webp|gif)$/ },
  "nav-icons": { visibility: "public", max: 2 * mb, mime: /^(image\/(jpeg|png|webp|svg\+xml))$/, admin: true },
  "institute-logos": { visibility: "public", max: 2 * mb, mime: /^(image\/(jpeg|png|webp|svg\+xml))$/, admin: true },
  "entity-logos": { visibility: "public", max: 2 * mb, mime: /^image\/(jpeg|png|webp)$/ },
  stories: { visibility: "private", max: 20 * mb, mime: /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/ },
  "post-images": { visibility: "private", max: 20 * mb, mime: /^image\/(jpeg|png|webp|gif)$/ },
  "forum-files": { visibility: "private", max: 20 * mb, mime: /^(application\/(pdf|zip|vnd\.openxmlformats-officedocument\..+)|text\/plain|image\/(jpeg|png|webp))$/ },
  "voice-notes": { visibility: "private", max: 15 * mb, mime: /^audio\/(webm|ogg|mpeg|mp4|wav)$/ },
  "chat-media": { visibility: "private", max: 20 * mb, mime: /^(image\/(jpeg|png|webp|gif)|audio\/(webm|ogg|mpeg|mp4|wav)|application\/pdf)$/ },
  "verification-documents": { visibility: "private", max: 10 * mb, mime: /^(application\/pdf|image\/(jpeg|png|webp))$/ },
};

const admin = (ctx: RequestContext): boolean => ctx.auth.role === "admin" || ctx.auth.role === "owner";

export function safeObjectPath(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new ApiError(400, "invalid_object_path", "Object path is invalid"); }
  const normalized = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.length > 600 || segments.some((part) => !part || part === "." || part === ".." || part.includes("\0") || part.length > 255)) {
    throw new ApiError(400, "invalid_object_path", "Object path is invalid");
  }
  return segments.join("/");
}

function policy(bucket: string): BucketPolicy {
  const found = buckets[bucket];
  if (!found) throw new ApiError(400, "bucket_not_allowed", "Storage bucket is not allowed");
  return found;
}

function signature(bucket: string, objectPath: string, expires: number): string {
  return createHmac("sha256", config.STORAGE_SIGNING_SECRET).update(`${bucket}\n${objectPath}\n${expires}`).digest("base64url");
}

export function cloudFrontObjectUrlFor(domain: string, keyPrefix: string, bucket: string, objectPath: string): string {
  const prefix = keyPrefix ? `${keyPrefix.replace(/\/+$/, "")}/` : "";
  const key = `${prefix}${bucket}/${objectPath}`.split("/").map(encodeURIComponent).join("/");
  return `https://${domain}/${key}`;
}

function cloudFrontObjectUrl(bucket: string, objectPath: string): string | null {
  if (!config.CLOUDFRONT_DOMAIN) return null;
  return cloudFrontObjectUrlFor(config.CLOUDFRONT_DOMAIN, config.S3_KEY_PREFIX, bucket, objectPath);
}

function signedCloudFrontObjectUrl(bucket: string, objectPath: string, expires: number): string | null {
  const url = cloudFrontObjectUrl(bucket, objectPath);
  if (!url || !config.CLOUDFRONT_KEY_PAIR_ID || !config.CLOUDFRONT_PRIVATE_KEY_BASE64) return null;
  return getCloudFrontSignedUrl({
    url,
    keyPairId: config.CLOUDFRONT_KEY_PAIR_ID,
    privateKey: Buffer.from(config.CLOUDFRONT_PRIVATE_KEY_BASE64, "base64").toString("utf8"),
    dateLessThan: new Date(expires * 1000).toISOString(),
  });
}

const opaqueHandlePattern = /^opaque\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function opaqueObjectHandle(fileId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId)) {
    throw new ApiError(500, "invalid_file_identity", "Stored file identity is invalid");
  }
  return `opaque/${fileId.toLowerCase()}`;
}

export async function opaqueHandlesForObjectKeys(objectKeys: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(objectKeys)].filter(Boolean).slice(0, 2_000);
  if (!unique.length) return new Map();
  const files = await prisma.fileObject.findMany({
    where: { object_key: { in: unique }, status: "ready", deleted_at: null },
    select: { id: true, object_key: true },
  });
  return new Map(files.map((file) => [file.object_key, opaqueObjectHandle(file.id)]));
}

async function resolveObjectReference(bucket: string, value: string): Promise<{ objectPath: string; signedPath: string }> {
  const signedPath = safeObjectPath(value);
  if (!signedPath.startsWith("opaque/")) return { objectPath: signedPath, signedPath };
  const match = signedPath.match(opaqueHandlePattern);
  if (!match) throw new ApiError(404, "object_not_found", "Object not found");
  const file = await prisma.fileObject.findUnique({ where: { id: match[1]!.toLowerCase() } });
  const prefix = `${bucket}/`;
  if (!file || file.bucket !== bucket || file.deleted_at || file.status !== "ready" || !file.object_key.startsWith(prefix)) {
    throw new ApiError(404, "object_not_found", "Object not found");
  }
  return { objectPath: safeObjectPath(file.object_key.slice(prefix.length)), signedPath };
}

function ownsPath(ctx: RequestContext, bucket: string, objectPath: string): boolean {
  if (admin(ctx)) return true;
  if (["nav-icons", "institute-logos"].includes(bucket)) return false;
  return objectPath.split("/")[0] === ctx.auth.id;
}

export function isOwnedReadyFile(file: { uploaded_by: string | null; status: string; deleted_at: Date | null } | null, userId: string): boolean {
  return !!file && file.uploaded_by === userId && file.status === "ready" && file.deleted_at === null;
}

export function assertUploadOverwriteAllowed(bucket: string, upsert: boolean): void {
  if (bucket === "verification-documents" && upsert) {
    throw new ApiError(409, "verification_evidence_immutable", "Verification evidence cannot be overwritten; upload a new document instead");
  }
}

const referencedContentBuckets = new Set(["stories", "post-images", "forum-files", "voice-notes", "chat-media", "entity-logos"]);

export function verificationEvidenceIsLocked(row: Record<string, unknown>, objectPath: string): boolean {
  if (row.document_path !== objectPath) return false;
  return !new Set(["rejected", "withdrawn"]).has(String(row.status ?? "pending").toLowerCase());
}

export function publicStorageObjectUrl(bucket: string, objectPath: string): string {
  return cloudFrontObjectUrl(bucket, objectPath) || new URL(
    `/api/storage/public/${encodeURIComponent(bucket)}/${objectPath.split("/").map(encodeURIComponent).join("/")}`,
    config.APP_BASE_URL,
  ).toString();
}

export async function assertOwnedReadyObject(bucket: string, objectPathValue: unknown, userId: string, expectedMime?: RegExp): Promise<string> {
  if (typeof objectPathValue !== "string" || !objectPathValue) throw new ApiError(400, "invalid_media_path", "A valid uploaded object path is required");
  const objectPath = safeObjectPath(objectPathValue);
  policy(bucket);
  const file = await prisma.fileObject.findUnique({ where: { object_key: `${bucket}/${objectPath}` } });
  if (!isOwnedReadyFile(file, userId)) {
    throw new ApiError(400, "invalid_media_reference", "Media must reference a ready upload owned by the current user");
  }
  if (expectedMime && file && !expectedMime.test(file.mime_type)) {
    throw new ApiError(400, "invalid_media_type", "Uploaded media does not match the message type");
  }
  return objectPath;
}

export async function storeUpload(bucket: string, objectPathValue: string, file: Express.Multer.File, optionsValue: unknown, ctx: RequestContext) {
  const objectPath = safeObjectPath(objectPathValue);
  const rules = policy(bucket);
  if (new Set(["stories", "post-images", "forum-files", "voice-notes", "chat-media"]).has(bucket)
    && !ctx.auth.is_verified && !admin(ctx)) {
    throw new ApiError(403, "verification_required", "Verified membership is required to upload community content");
  }
  if (rules.admin && !admin(ctx)) throw new ApiError(403, "admin_required", "Administrator access is required for this bucket");
  if (!ownsPath(ctx, bucket, objectPath)) throw new ApiError(403, "invalid_storage_prefix", "Uploads must use your user ID as the first path segment");
  if (!rules.mime.test(file.mimetype) || file.size > Math.min(rules.max, config.MAX_UPLOAD_BYTES)) throw new ApiError(415, "file_not_allowed", "File type or size is not allowed for this bucket");
  const options = optionsValue && typeof optionsValue === "object" ? optionsValue as Record<string, unknown> : {};
  assertUploadOverwriteAllowed(bucket, options.upsert === true);
  const objectKey = `${bucket}/${objectPath}`;
  const digest = sha256(file.buffer.toString("base64"));
  if (options.upsert === true) {
    const existing = await prisma.fileObject.findUnique({ where: { object_key: objectKey } });
    // Retried outbox uploads are idempotent. Never rewrite bytes that have
    // already been attached to durable content, even when the caller owns them.
    if (existing?.status === "ready" && existing.deleted_at === null && existing.uploaded_by === ctx.auth.id && existing.sha256 === digest) {
      return { path: objectPath, fullPath: objectKey };
    }
    if (existing) throw new ApiError(409, "object_immutable", "An uploaded object cannot be replaced; upload to a new path instead");
  }
  const metadata = await prisma.$transaction(async (tx) => {
    // Hold a shared lock on the active uploader through both the byte write and
    // metadata insert. Account deletion takes the corresponding FOR UPDATE
    // lock first, so an in-flight upload is either included in its cleanup
    // snapshot or rejected before bytes are written.
    const active = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${ctx.auth.id} AND status = 'active' LIMIT 1 FOR SHARE
    `;
    if (active.length !== 1) throw new ApiError(401, "account_unavailable", "This account is unavailable");
    try { await putObjectNew(objectKey, file.buffer, file.mimetype); }
    catch (error) {
      const code = (error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } }).code;
      const name = (error as { name?: string }).name;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code === "EEXIST" || name === "PreconditionFailed" || status === 412) throw new ApiError(409, "object_exists", "An object already exists at this path");
      throw error;
    }
    try {
      return await tx.fileObject.upsert({
        where: { object_key: objectKey },
        create: { uploaded_by: ctx.auth.id, bucket, object_key: objectKey, original_name: file.originalname.slice(0, 255), mime_type: file.mimetype, size_bytes: file.size, visibility: rules.visibility, sha256: digest },
        update: { uploaded_by: ctx.auth.id, original_name: file.originalname.slice(0, 255), mime_type: file.mimetype, size_bytes: file.size, visibility: rules.visibility, sha256: digest, status: "ready", deleted_at: null },
      });
    } catch (error) {
      // A brand-new path has no prior bytes to preserve. Avoid leaving an
      // untracked object behind if metadata persistence fails.
      await deleteObjectBytes(objectKey).catch(() => undefined);
      throw error;
    }
  }, { timeout: 15_000 });
  await writeAudit({ actor_id: ctx.auth.id, action: "storage.upload", resource_type: "file", resource_id: metadata.id, ip: ctx.ip, metadata: { bucket, path: objectPath, size: file.size, mime: file.mimetype } });
  return { path: objectPath, fullPath: objectKey };
}

async function chatMember(userId: string, roomId: unknown): Promise<boolean> {
  if (typeof roomId !== "string") return false;
  const members = await prisma.legacyRecord.findMany({ where: { table_name: "chat_members", owner_id: userId }, take: 1000 });
  return members.some((record) => (record.data as Record<string, unknown>).room_id === roomId);
}

export const storyIsActive = (row: Record<string, unknown>, now = new Date()): boolean => {
  const expiry = new Date(String(row.expires_at ?? ""));
  return !Number.isNaN(expiry.getTime()) && expiry > now && row.deleted_at == null;
};

export async function canAccessStoryOwner(viewerId: string, ownerId: string): Promise<boolean> {
  if (!ownerId) return false;
  if (viewerId === ownerId) return true;
  return !!await prisma.connection.findFirst({ where: {
    status: "accepted",
    OR: [{ requester_id: viewerId, receiver_id: ownerId }, { requester_id: ownerId, receiver_id: viewerId }],
  }, select: { id: true } });
}

async function storyRecords(objectPath: string) {
  return prisma.legacyRecord.findMany({ where: {
    table_name: "stories",
    data: { path: "$.image_path", equals: objectPath },
  }, take: 20 });
}

export function messageReferencesObject(row: Record<string, unknown>, bucket: string, objectPath: string): boolean {
  if (bucket === "voice-notes") return row.voice_path === objectPath;
  if (bucket === "post-images") return row.media_path === objectPath && row.media_bucket === "post-images";
  if (bucket !== "chat-media") return false;
  return (row.media_path === objectPath && row.media_bucket !== "post-images")
    || row.file_path === objectPath
    || row.image_path === objectPath;
}

export async function objectHasActiveReference(bucket: string, objectPath: string): Promise<boolean> {
  if (!referencedContentBuckets.has(bucket)) return false;
  if (bucket === "entity-logos") {
    const logoUrl = publicStorageObjectUrl(bucket, objectPath);
    const records = await prisma.legacyRecord.findMany({
      where: {
        table_name: { in: ["custom_options", "professional_experience"] },
        data: { path: "$.logo_url", equals: logoUrl },
      },
      select: { table_name: true, data: true },
    });
    return records.some((record) => {
      const row = record.data as Record<string, unknown>;
      if (record.table_name === "custom_options") return !new Set(["rejected", "withdrawn"]).has(String(row.status ?? "pending").toLowerCase());
      return !new Set(["rejected", "deleted"]).has(String(row.approval_status ?? "approved").toLowerCase()) && row.deleted_at == null;
    });
  }
  if (bucket === "stories") {
    return (await storyRecords(objectPath)).some((record) => storyIsActive(record.data as Record<string, unknown>));
  }

  const postWhere = bucket === "post-images"
    ? { OR: [{ image_path: objectPath }, { media_path: objectPath }], deleted_at: null, is_deleted_for_everyone: false }
    : bucket === "forum-files"
      ? { file_path: objectPath, deleted_at: null, is_deleted_for_everyone: false }
      : bucket === "voice-notes"
        ? { voice_path: objectPath, deleted_at: null, is_deleted_for_everyone: false }
        : undefined;
  const messageFields = bucket === "voice-notes" ? ["voice_path"]
    : bucket === "post-images" ? ["media_path"]
      : bucket === "chat-media" ? ["media_path", "file_path", "image_path"] : [];
  const [post, messages] = await Promise.all([
    postWhere ? prisma.post.findFirst({ where: postWhere, select: { id: true } }) : Promise.resolve(null),
    messageFields.length ? prisma.legacyRecord.findMany({
      where: {
        table_name: "messages",
        OR: messageFields.map((field) => ({ data: { path: `$.${field}`, equals: objectPath } })),
      },
      select: { data: true },
    }) : Promise.resolve([]),
  ]);
  return !!post || messages.some((record) => {
    const row = record.data as Record<string, unknown>;
    return messageReferencesObject(row, bucket, objectPath) && !isDeletedForEveryone(row);
  });
}

async function canReadStoryObject(objectPath: string, ctx: RequestContext): Promise<boolean> {
  for (const record of await storyRecords(objectPath)) {
    const row = record.data as Record<string, unknown>;
    const ownerId = typeof record.owner_id === "string" ? record.owner_id
      : typeof row.user_id === "string" ? row.user_id : typeof row.author_id === "string" ? row.author_id : "";
    if (storyIsActive(row) && await canAccessStoryOwner(ctx.auth.id, ownerId)) return true;
  }
  return false;
}

async function privateObjectRevoked(bucket: string, objectPath: string): Promise<boolean> {
  if (bucket === "stories") {
    const records = await storyRecords(objectPath);
    return records.length > 0 && records.every((record) => !storyIsActive(record.data as Record<string, unknown>));
  }
  const checkPosts = ["post-images", "forum-files", "voice-notes"].includes(bucket);
  const checkMessages = ["post-images", "chat-media", "voice-notes"].includes(bucket);
  const postFields = bucket === "post-images"
    ? [{ image_path: objectPath }, { media_path: objectPath }]
    : bucket === "forum-files" ? [{ file_path: objectPath }] : [{ voice_path: objectPath }];
  const messagePathFields = bucket === "voice-notes" ? ["voice_path"] : bucket === "post-images" ? ["media_path"] : ["media_path", "file_path", "image_path"];
  const [posts, messages] = await Promise.all([
    checkPosts ? prisma.post.findMany({
      where: { OR: postFields },
      select: { deleted_at: true, is_deleted_for_everyone: true }, take: 20,
    }) : Promise.resolve([]),
    checkMessages ? prisma.legacyRecord.findMany({ where: {
      table_name: "messages",
      OR: messagePathFields.map((field) => ({ data: { path: `$.${field}`, equals: objectPath } })),
    }, take: 100 }) : Promise.resolve([]),
  ]);
  const linkedMessages = messages.map((record) => record.data as Record<string, unknown>)
    .filter((row) => messageReferencesObject(row, bucket, objectPath));
  return mediaReferencesRevoked([...posts.map((post) => post as unknown as Record<string, unknown>), ...linkedMessages]);
}

async function canReadPrivate(bucket: string, objectPath: string, ctx: RequestContext): Promise<boolean> {
  const file = await prisma.fileObject.findUnique({ where: { object_key: `${bucket}/${objectPath}` } });
  if (!file || file.deleted_at || file.status !== "ready") return false;
  if (await privateObjectRevoked(bucket, objectPath)) return false;
  if (bucket === "stories") return canReadStoryObject(objectPath, ctx);
  if (admin(ctx) || file.uploaded_by === ctx.auth.id) return true;
  if (bucket === "post-images" || bucket === "forum-files") {
    const pathFilter = bucket === "post-images" ? { OR: [{ image_path: objectPath }, { media_path: objectPath }] } : { file_path: objectPath };
    const post = await prisma.post.findFirst({ where: { ...pathFilter, deleted_at: null, is_deleted_for_everyone: false } });
    if (post && (post.author_id === ctx.auth.id || await canUseForumScope(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role, post.scope_type, post.scope_key))) return true;
    if (bucket === "post-images") {
      const messages = await prisma.legacyRecord.findMany({ where: {
        table_name: "messages",
        AND: [{ data: { path: "$.media_path", equals: objectPath } }, { data: { path: "$.media_bucket", equals: "post-images" } }],
      }, take: 20 });
      for (const record of messages) {
        const message = record.data as Record<string, unknown>;
        if (messageReferencesObject(message, bucket, objectPath) && !isDeletedForEveryone(message) && await chatMember(ctx.auth.id, message.room_id)) return true;
      }
    }
    return false;
  }
  if (bucket === "chat-media" || bucket === "voice-notes") {
    if (bucket === "voice-notes") {
      const post = await prisma.post.findFirst({ where: { voice_path: objectPath, deleted_at: null, is_deleted_for_everyone: false } });
      if (post) return post.author_id === ctx.auth.id || canUseForumScope(ctx.auth.id, ctx.auth.is_verified, ctx.auth.role, post.scope_type, post.scope_key);
    }
    const fields = bucket === "voice-notes" ? ["voice_path"] : ["media_path", "file_path", "image_path"];
    const messages = await prisma.legacyRecord.findMany({ where: {
      table_name: "messages",
      OR: fields.map((field) => ({ data: { path: `$.${field}`, equals: objectPath } })),
    }, take: 20 });
    for (const record of messages) {
      const message = record.data as Record<string, unknown>;
      if (messageReferencesObject(message, bucket, objectPath) && !isDeletedForEveryone(message) && await chatMember(ctx.auth.id, message.room_id)) return true;
    }
    return false;
  }
  return false;
}

export async function createSignedUrl(bucket: string, objectPathValue: string, expiresIn: number, ctx: RequestContext): Promise<string> {
  const rules = policy(bucket);
  const reference = await resolveObjectReference(bucket, objectPathValue);
  const objectPath = reference.objectPath;
  if (rules.visibility === "private" && bucket !== "verification-documents" && !ctx.auth.is_verified && !admin(ctx)) {
    throw new ApiError(403, "verification_required", "Verified membership is required to access community files");
  }
  if (rules.visibility === "public") return new URL(`/api/storage/public/${encodeURIComponent(bucket)}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, config.APP_BASE_URL).toString();
  if (!(await canReadPrivate(bucket, objectPath, ctx))) throw new ApiError(403, "file_access_denied", "You cannot access this file");
  const ttl = Math.max(30, Math.min(expiresIn, 3600));
  const expires = Math.floor(Date.now() / 1000) + ttl;
  // Opaque handles intentionally hide an anonymous author's user-prefixed S3
  // key. Keep those on the authorized API path until media keys themselves are
  // opaque; all ordinary private media can bypass Node through CloudFront.
  if (!reference.signedPath.startsWith("opaque/")) {
    const cloudFrontUrl = signedCloudFrontObjectUrl(bucket, objectPath, expires);
    if (cloudFrontUrl) return cloudFrontUrl;
  }
  const url = new URL(`/api/storage/private/${encodeURIComponent(bucket)}/${reference.signedPath.split("/").map(encodeURIComponent).join("/")}`, config.APP_BASE_URL);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("sig", signature(bucket, reference.signedPath, expires));
  return url.toString();
}

export async function verifySignedUrl(bucket: string, objectPathValue: string, expiresValue: unknown, signatureValue: unknown): Promise<string> {
  const signedPath = safeObjectPath(objectPathValue);
  policy(bucket);
  const expires = Number(expiresValue);
  const supplied = typeof signatureValue === "string" ? signatureValue : "";
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + 3700) throw new ApiError(403, "signed_url_expired", "Signed URL is expired or invalid");
  const expected = signature(bucket, signedPath, expires);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ApiError(403, "invalid_signature", "Signed URL is invalid");
  return (await resolveObjectReference(bucket, signedPath)).objectPath;
}

export async function loadObject(bucket: string, objectPathValue: string, requirePublic: boolean): Promise<{ bytes: Buffer; mime: string; name: string }> {
  const objectPath = safeObjectPath(objectPathValue);
  const rules = policy(bucket);
  if (requirePublic && rules.visibility !== "public") throw new ApiError(404, "object_not_found", "Object not found");
  const metadata = await prisma.fileObject.findUnique({ where: { object_key: `${bucket}/${objectPath}` } });
  if (!metadata || metadata.deleted_at || metadata.status !== "ready") throw new ApiError(404, "object_not_found", "Object not found");
  if (rules.visibility === "private" && await privateObjectRevoked(bucket, objectPath)) throw new ApiError(404, "object_not_found", "Object not found");
  try { return { bytes: await readObjectBytes(`${bucket}/${objectPath}`), mime: metadata.mime_type, name: metadata.original_name }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { name?: string }).name === "NoSuchKey") throw new ApiError(404, "object_not_found", "Object not found");
    throw error;
  }
}

export async function removeObjects(bucket: string, paths: string[], ctx: RequestContext): Promise<Array<{ path: string }>> {
  policy(bucket);
  if (paths.length > 100) throw new ApiError(400, "too_many_objects", "At most 100 objects can be removed at once");
  const removed: Array<{ path: string }> = [];
  for (const raw of paths) {
    const objectPath = safeObjectPath(raw);
    const metadata = await prisma.fileObject.findUnique({ where: { object_key: `${bucket}/${objectPath}` } });
    if (!metadata || metadata.deleted_at) continue;
    if (metadata.uploaded_by !== ctx.auth.id && !admin(ctx)) throw new ApiError(403, "file_access_denied", "You cannot remove this file");
    if (await objectHasActiveReference(bucket, objectPath)) {
      throw new ApiError(409, "object_in_use", "Attached content cannot be deleted; delete the content first");
    }
    if (bucket === "verification-documents") {
      const submissions = await prisma.legacyRecord.findMany({ where: {
        table_name: "document_verifications",
        data: { path: "$.document_path", equals: objectPath },
      }, select: { data: true } });
      if (submissions.some((record) => verificationEvidenceIsLocked(record.data as Record<string, unknown>, objectPath))) {
        throw new ApiError(409, "verification_evidence_locked", "Verification evidence under review or already approved cannot be deleted");
      }
    }
    try { await deleteObjectBytes(`${bucket}/${objectPath}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as { name?: string }).name !== "NoSuchKey") throw error; }
    await prisma.fileObject.update({ where: { id: metadata.id }, data: { status: "deleted", deleted_at: new Date() } });
    removed.push({ path: objectPath });
  }
  return removed;
}
