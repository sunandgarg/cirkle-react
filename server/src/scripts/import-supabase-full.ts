import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { legacyTables } from "../services/data.js";
import { putObjectNew, readObjectBytes } from "../services/objectStore.js";
import { publicStorageObjectUrl } from "../services/storage.js";
import {
  assertCompleteManifest,
  assertAnonymousAuthorMappings,
  buildAnonymousAuthorMap,
  buildPasswordHashMap,
  createSupabaseStorageUrlRewriter,
  deletedMessageUsersByMessage,
  googleProviderSubject,
  importedLegacyTableName,
  importedPostAuthor,
  legacyRecordIdFor,
  MIGRATION_ARTIFACT_TABLE,
  PRIVATE_ARCHIVE_TABLES,
  SOURCE_SNAPSHOT_TABLE,
  SUPABASE_SOURCE_TABLES,
  withDeletedMessageUsers,
} from "./supabaseImportSupport.js";

type Row = Record<string, unknown>;
type Manifest = {
  export_version: number;
  exported_at: string;
  project_url: string;
  source_content_sha256: string;
  source_schema_tables: string[];
  users: Row[];
  password_migration_mode: "bcrypt" | "forced_reset";
  email_provider_users: number;
  password_hashes: Row[];
  tables: Record<string, Row[]>;
  buckets: Array<{ id: string; public?: boolean }>;
  storage: Record<string, Array<Row & { path: string; export_size_bytes?: number; export_sha256?: string }>>;
};

const source = process.argv.find((value) => value.startsWith("--file="))?.slice(7);
const apply = process.argv.includes("--apply");
const uploadObjects = process.argv.includes("--upload-objects");
const applyPasswordHashes = process.argv.includes("--apply-password-hashes");
const allowForcedPasswordReset = process.argv.includes("--allow-forced-password-reset");
const anonymousOrphansArgument = process.argv.find((value) => value.startsWith("--allow-anonymous-orphans="));
const allowedAnonymousOrphans = anonymousOrphansArgument ? Number(anonymousOrphansArgument.slice("--allow-anonymous-orphans=".length)) : 0;
if (!Number.isSafeInteger(allowedAnonymousOrphans) || allowedAnonymousOrphans < 0) throw new Error("--allow-anonymous-orphans must be a non-negative integer");
if (!source) throw new Error("Usage: tsx server/src/scripts/import-supabase-full.ts --file=/absolute/manifest.json [--apply] [--upload-objects] [--apply-password-hashes | --allow-forced-password-reset] [--allow-anonymous-orphans=N]");
const manifestPath = path.resolve(source);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const storageRoot = path.join(path.dirname(manifestPath), "storage");
if (!Array.isArray(manifest.users) || !manifest.tables || !manifest.storage) throw new Error("Invalid Supabase export manifest");
assertCompleteManifest(manifest);
if (!new Set(["bcrypt", "forced_reset"]).has(manifest.password_migration_mode) || !Array.isArray(manifest.password_hashes)) {
  throw new Error("Manifest has no explicit password migration policy");
}
if (manifest.password_migration_mode === "bcrypt" && apply && !applyPasswordHashes) {
  throw new Error("This manifest contains password verifiers; --apply-password-hashes is required to install them deliberately");
}
if (manifest.password_migration_mode === "forced_reset" && apply && manifest.email_provider_users > 0 && !allowForcedPasswordReset) {
  throw new Error("This manifest resets source email-password access; --allow-forced-password-reset is required deliberately");
}
if (applyPasswordHashes && manifest.password_migration_mode !== "bcrypt") throw new Error("--apply-password-hashes requires a bcrypt manifest");
if (allowForcedPasswordReset && manifest.password_migration_mode !== "forced_reset") throw new Error("--allow-forced-password-reset requires a forced-reset manifest");
if (manifest.password_migration_mode === "forced_reset" && manifest.password_hashes.length) {
  throw new Error("Forced-reset manifest must not contain password verifiers");
}

const date = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid exported date: ${value}`);
  return parsed;
};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const bool = (value: unknown, fallback = false): boolean => typeof value === "boolean" ? value : fallback;
const json = (value: unknown): Prisma.InputJsonValue | undefined => value === null || value === undefined ? undefined : value as Prisma.InputJsonValue;
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Row).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
};
const jsonSha256 = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const actualSourceContentSha256 = jsonSha256({
  project_url: manifest.project_url,
  source_schema_tables: manifest.source_schema_tables,
  users: manifest.users,
  password_migration_mode: manifest.password_migration_mode,
  email_provider_users: manifest.email_provider_users,
  password_hashes: manifest.password_hashes,
  tables: manifest.tables,
  buckets: manifest.buckets,
  storage: manifest.storage,
});
if (!/^[a-f0-9]{64}$/.test(manifest.source_content_sha256) || manifest.source_content_sha256 !== actualSourceContentSha256) {
  throw new Error("Supabase manifest content digest is missing or invalid");
}
const rows = (table: string): Row[] => manifest.tables[table] || [];
const knownUsers = new Set(manifest.users.map((user) => String(user.id)));
if (knownUsers.size !== manifest.users.length || knownUsers.has("undefined")) throw new Error("Supabase auth export contains duplicate or missing user IDs");
const emailProviderUserIds = new Set(manifest.users.filter((user) => user.app_metadata && typeof user.app_metadata === "object"
  && Array.isArray((user.app_metadata as Row).providers) && ((user.app_metadata as Row).providers as unknown[]).includes("email"))
  .map((user) => String(user.id)));
const passwordHashes = buildPasswordHashMap(manifest.password_hashes, knownUsers, emailProviderUserIds);
if (manifest.email_provider_users !== emailProviderUserIds.size) throw new Error("Manifest email-provider user count does not match its auth export");
if (manifest.password_migration_mode === "bcrypt" && passwordHashes.size !== emailProviderUserIds.size) {
  throw new Error(`Password verifier set is incomplete: expected ${emailProviderUserIds.size}, received ${passwordHashes.size}`);
}
const ownerRole = new Map<string, string>();
const rolePriority = new Map([["member", 0], ["user", 0], ["moderator", 1], ["admin", 2], ["owner", 3]]);
const rememberRole = (userId: string, sourceRole: string): void => {
  if (!knownUsers.has(userId)) throw new Error(`Role assignment references missing user ${userId}`);
  const role = sourceRole === "user" ? "member" : sourceRole;
  if (!rolePriority.has(role)) throw new Error(`Unsupported source role ${sourceRole}`);
  const current = ownerRole.get(userId);
  if (!current || (rolePriority.get(role) ?? -1) > (rolePriority.get(current) ?? -1)) ownerRole.set(userId, role);
};
for (const row of rows("user_roles")) rememberRole(String(row.user_id), String(row.role || "member"));
for (const row of rows("platform_owners")) rememberRole(String(row.user_id), "owner");

const typedTables = new Set(["profiles", "posts", "comments", "reactions", "reports", "connections", "jobs", "applications", "events", "rsvps", "user_roles", "platform_owners"]);
for (const table of typedTables) {
  if (!Array.isArray(manifest.tables[table] || [])) throw new Error(`Missing typed table export: ${table}`);
}
const handledTables = new Set([...typedTables, ...legacyTables, ...PRIVATE_ARCHIVE_TABLES]);
const unhandledTables = SUPABASE_SOURCE_TABLES.filter((table) => !handledTables.has(table));
if (unhandledTables.length) throw new Error(`Importer has no handling policy for: ${unhandledTables.join(", ")}`);
const anonymousAuthors = buildAnonymousAuthorMap(rows("forum_anonymous_authors"), knownUsers);
assertAnonymousAuthorMappings(rows("posts"), anonymousAuthors);
const deletedMessageUsers = deletedMessageUsersByMessage(rows("message_deleted_for_user"), knownUsers);
const anonymousPostsWithoutOwner = rows("posts").filter((row) => row.is_anonymous === true
  && !importedPostAuthor(row, anonymousAuthors, knownUsers)).length;
if (apply && anonymousPostsWithoutOwner !== allowedAnonymousOrphans) {
  throw new Error(`Frozen source contains ${anonymousPostsWithoutOwner} anonymous post(s) without recoverable ownership; rerun only after remediation or explicit --allow-anonymous-orphans=${anonymousPostsWithoutOwner}`);
}

const storageEntries: Array<{
  bucket: string;
  object: Row & { path: string; export_size_bytes?: number; export_sha256?: string };
  objectPath: string;
  localPath: string;
  key: string;
  size: number;
  sha256: string;
}> = [];
const seenObjectKeys = new Set<string>();
for (const [bucket, objects] of Object.entries(manifest.storage)) {
  if (!manifest.buckets.some((candidate) => candidate.id === bucket)) throw new Error(`Storage export references unknown bucket ${bucket}`);
  for (const object of objects) {
    const objectPath = String(object.path || "");
    const parts = objectPath.split("/");
    if (!objectPath || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
      throw new Error(`Unsafe object path in bucket ${bucket}`);
    }
    const localPath = path.resolve(storageRoot, bucket, ...parts);
    const bucketRoot = path.resolve(storageRoot, bucket);
    if (!localPath.startsWith(`${bucketRoot}${path.sep}`)) throw new Error(`Object path escapes storage export root in bucket ${bucket}`);
    const bytes = await readFile(localPath);
    const info = await stat(localPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (object.export_size_bytes !== info.size || object.export_sha256 !== sha256) {
      throw new Error(`Exported object integrity mismatch in bucket ${bucket}`);
    }
    const key = `${bucket}/${objectPath}`;
    if (seenObjectKeys.has(key)) throw new Error(`Storage export contains duplicate object key ${key}`);
    seenObjectKeys.add(key);
    storageEntries.push({ bucket, object, objectPath, localPath, key, size: info.size, sha256 });
  }
}

const storageUrlRewriter = createSupabaseStorageUrlRewriter({
  projectUrl: manifest.project_url,
  buckets: manifest.buckets,
  objects: storageEntries.map((entry) => ({ bucket: entry.bucket, path: entry.objectPath })),
  publicObjectUrl: publicStorageObjectUrl,
});
const operationalTables = Object.fromEntries(SUPABASE_SOURCE_TABLES.map((table) => [
  table,
  storageUrlRewriter.rewrite(rows(table)),
])) as Record<string, Row[]>;
const operationalRows = (table: string): Row[] => operationalTables[table] || [];
const ownershipFields: Record<string, string[]> = {
  messages: ["sender_id"], message_deleted_for_user: ["user_id"], chat_members: ["user_id"], call_participants: ["user_id"], consultations: ["client_id"], blog_comments: ["author_id"], blog_bookmarks: ["user_id"], blog_likes: ["user_id"], client_error_logs: ["user_id"], course_verification_requests: ["user_id"], document_verifications: ["user_id"], education: ["user_id"], forum_anonymous_authors: ["author_id"], forum_deleted_for_user: ["user_id"], forum_room_state: ["user_id"], job_engagement_events: ["user_id"], job_scan_sources: ["created_by"], notifications: ["user_id"], onboarding_progress: ["user_id"], pending_profile_options: ["user_id"], professional_experience: ["user_id"], saved_views: ["user_id"], stories: ["user_id", "author_id"], user_activity_daily: ["user_id"], user_activity_sessions: ["user_id"], user_pinned_messages: ["user_id"], user_roles: ["user_id"], verification_codes: ["user_id"], verifications: ["user_id"], verified_academic_affiliations: ["user_id"], poll_votes: ["user_id"], polls: ["created_by"],
};

const sourceSnapshots = [
  ...SUPABASE_SOURCE_TABLES.map((table) => ({
    recordId: `public.${table}`,
    kind: "public_table",
    rowCount: rows(table).length,
    payload: rows(table),
  })),
  { recordId: "auth.users", kind: "auth_users", rowCount: manifest.users.length, payload: manifest.users },
  {
    recordId: "storage.catalog",
    kind: "storage_catalog",
    rowCount: storageEntries.length,
    payload: { buckets: manifest.buckets, objects: manifest.storage },
  },
].map((snapshot) => ({
  ...snapshot,
  sha256: jsonSha256(snapshot.payload),
  data: {
    export_version: manifest.export_version,
    exported_at: manifest.exported_at,
    source_project_url: manifest.project_url ?? null,
    kind: snapshot.kind,
    row_count: snapshot.rowCount,
    sha256: jsonSha256(snapshot.payload),
    payload: snapshot.payload,
  } as Prisma.InputJsonValue,
}));

const assertSourceSubset = (label: string, expectedValues: string[], actualValues: string[]): void => {
  const expected = new Set(expectedValues);
  const actual = new Set(actualValues);
  if (expected.size !== expectedValues.length) throw new Error(`Frozen ${label} export contains duplicate identities`);
  const missing = [...expected].filter((value) => !actual.has(value));
  if (missing.length) throw new Error(`Destination reconciliation is missing ${missing.length} ${label} record(s)`);
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requiredUuid = (row: Row, field: string, label: string): string => {
  const value = text(row[field]);
  if (!value || !uuidPattern.test(value)) throw new Error(`${label} has no valid ${field}`);
  return value;
};
const optionalKnownUser = (row: Row, field: string, label: string): void => {
  const value = text(row[field]);
  if (value && !knownUsers.has(value)) throw new Error(`${label} references missing user ${value}`);
};
const requiredKnownUser = (row: Row, field: string, label: string): string => {
  const value = requiredUuid(row, field, label);
  if (!knownUsers.has(value)) throw new Error(`${label} references missing user ${value}`);
  return value;
};

// Everything that depends only on the frozen artifact is validated before the
// plan exits or immutable S3 objects are staged. Apply must not be the first
// time malformed identities, relationships, dates or numeric values are seen.
for (const sourceUser of manifest.users) {
  requiredUuid(sourceUser, "id", "Supabase auth user");
  if (!text(sourceUser.email)) throw new Error("Supabase auth user is missing an email");
  const providers = sourceUser.app_metadata && typeof sourceUser.app_metadata === "object" && Array.isArray((sourceUser.app_metadata as Row).providers)
    ? (sourceUser.app_metadata as Row).providers as unknown[] : [];
  if (providers.includes("google") && !googleProviderSubject(sourceUser)) throw new Error(`Google user ${sourceUser.id} has no exported provider subject`);
  for (const [field, value] of Object.entries(sourceUser)) {
    if (value != null && field.endsWith("_at") && (typeof value !== "string" || !date(value))) {
      throw new Error(`auth.users.${field} contains an invalid date`);
    }
  }
}
for (const [table, values] of Object.entries(manifest.tables)) {
  for (const row of values) {
    for (const [field, value] of Object.entries(row)) {
      if (value != null && (field.endsWith("_at") || field.endsWith("_date") || field === "date_of_birth" || field === "start_time" || field === "end_time")) {
        if (typeof value !== "string" || !date(value)) throw new Error(`${table}.${field} contains an invalid date`);
      }
    }
  }
}

const typedIdentityFields: Record<string, string> = {
  profiles: "user_id", posts: "id", comments: "id", reactions: "id", reports: "id", connections: "id",
  jobs: "id", applications: "id", events: "id", rsvps: "id",
};
for (const [table, field] of Object.entries(typedIdentityFields)) {
  const identities = operationalRows(table).map((row) => requiredUuid(row, field, table));
  assertSourceSubset(table, identities, identities);
}
const postIds = new Set(operationalRows("posts").map((row) => String(row.id)));
const commentIds = new Set(operationalRows("comments").map((row) => String(row.id)));
const jobIds = new Set(operationalRows("jobs").map((row) => String(row.id)));
const eventIds = new Set(operationalRows("events").map((row) => String(row.id)));
for (const row of operationalRows("profiles")) requiredKnownUser(row, "user_id", "Profile");
for (const row of operationalRows("connections")) {
  requiredKnownUser(row, "requester_id", `Connection ${row.id}`);
  requiredKnownUser(row, "receiver_id", `Connection ${row.id}`);
}
for (const row of operationalRows("posts")) {
  importedPostAuthor(row, anonymousAuthors, knownUsers);
  optionalKnownUser(row, "deleted_by_user_id", `Post ${row.id}`);
  for (const field of ["reply_to_id", "reshared_post_id"]) {
    const linked = text(row[field]);
    if (linked && !postIds.has(linked)) throw new Error(`Post ${row.id} references missing ${field} ${linked}`);
  }
  if (row.file_size != null) {
    try { BigInt(String(row.file_size)); } catch { throw new Error(`Post ${row.id} has an invalid file_size`); }
  }
  if (row.voice_duration != null && (!Number.isSafeInteger(Number(row.voice_duration)) || Number(row.voice_duration) < 0)) {
    throw new Error(`Post ${row.id} has an invalid voice_duration`);
  }
}
for (const row of operationalRows("comments")) {
  optionalKnownUser(row, "author_id", `Comment ${row.id}`);
  if (!postIds.has(String(row.post_id))) throw new Error(`Comment ${row.id} references missing post ${row.post_id}`);
  const parent = text(row.parent_comment_id);
  if (parent && !commentIds.has(parent)) throw new Error(`Comment ${row.id} references missing parent ${parent}`);
}
for (const row of operationalRows("reactions")) requiredKnownUser(row, "user_id", `Reaction ${row.id}`);
for (const row of operationalRows("reports")) {
  requiredKnownUser(row, "reporter_id", `Report ${row.id}`);
  optionalKnownUser(row, "resolved_by", `Report ${row.id}`);
}
for (const row of operationalRows("jobs")) requiredKnownUser(row, "created_by", `Job ${row.id}`);
for (const row of operationalRows("applications")) {
  requiredKnownUser(row, "applicant_id", `Application ${row.id}`);
  if (!jobIds.has(String(row.job_id))) throw new Error(`Application ${row.id} references missing job ${row.job_id}`);
}
for (const row of operationalRows("events")) {
  requiredKnownUser(row, "created_by", `Event ${row.id}`);
  if (!date(row.start_time)) throw new Error(`Event ${row.id} has no start_time`);
}
for (const row of operationalRows("rsvps")) {
  requiredKnownUser(row, "user_id", `RSVP ${row.id}`);
  if (!eventIds.has(String(row.event_id))) throw new Error(`RSVP ${row.id} references missing event ${row.event_id}`);
}
for (const table of SUPABASE_SOURCE_TABLES) {
  if (!legacyTables.has(table) && !PRIVATE_ARCHIVE_TABLES.has(table)) continue;
  const values = operationalRows(table);
  const identities = values.map((row) => legacyRecordIdFor(table, row));
  assertSourceSubset(`${table} compatibility`, identities, identities);
  for (let index = 0; index < values.length; index += 1) {
    const owner = (ownershipFields[table] || []).map((field) => text(values[index]![field])).find(Boolean);
    if (owner && !knownUsers.has(owner)) throw new Error(`${table}/${identities[index]} references missing owner ${owner}`);
  }
}

const summary = {
  users: manifest.users.length,
  email_provider_users: manifest.email_provider_users,
  password_migration_mode: manifest.password_migration_mode,
  password_hashes: passwordHashes.size,
  profiles: rows("profiles").length,
  posts: rows("posts").length,
  connections: rows("connections").length,
  comments: rows("comments").length,
  reactions: rows("reactions").length,
  reports: rows("reports").length,
  jobs: rows("jobs").length,
  applications: rows("applications").length,
  events: rows("events").length,
  legacy: Object.entries(manifest.tables).filter(([table]) => legacyTables.has(table) || PRIVATE_ARCHIVE_TABLES.has(table)).reduce((sum, [, values]) => sum + values.length, 0),
  source_tables: manifest.source_schema_tables.length,
  source_public_rows: Object.values(manifest.tables).reduce((sum, values) => sum + values.length, 0),
  anonymous_author_mappings: anonymousAuthors.size,
  anonymous_posts_without_owner: anonymousPostsWithoutOwner,
  objects: Object.values(manifest.storage).reduce((sum, values) => sum + values.length, 0),
  object_bytes: storageEntries.reduce((sum, entry) => sum + entry.size, 0),
  rewritten_storage_urls: storageUrlRewriter.rewriteCount,
  source_snapshot_records: sourceSnapshots.length,
};
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: "plan", ...summary }, null, 2)}\n`);
  await prisma.$disconnect();
  process.exit(0);
}

// Stage and verify immutable object bytes before changing database state. A
// database failure may leave harmless unreferenced objects, while an object
// failure can never leave the relational cutover partially committed.
for (const entry of storageEntries) {
  if (uploadObjects) {
    const bytes = await readFile(entry.localPath);
    const metadata = entry.object.metadata && typeof entry.object.metadata === "object" ? entry.object.metadata as Row : {};
    try {
      await putObjectNew(entry.key, bytes, text(metadata.mimetype));
    } catch (error) {
      const detail = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
      if (detail.code !== "EEXIST" && detail.name !== "PreconditionFailed" && detail.$metadata?.httpStatusCode !== 412) throw error;
    }
  }
  const storedBytes = await readObjectBytes(entry.key);
  const storedSha256 = createHash("sha256").update(storedBytes).digest("hex");
  if (storedBytes.length !== entry.size || storedSha256 !== entry.sha256) {
    throw new Error(`Existing destination object differs from frozen export for ${entry.key}`);
  }
}

const publicBuckets = new Set(manifest.buckets.filter((bucket) => bucket.public).map((bucket) => bucket.id));
const reconcileInsideTransaction = async (tx: Prisma.TransactionClient): Promise<void> => {
  const importedUsers = await tx.user.findMany({
    where: { id: { in: [...knownUsers] } },
    select: { id: true, password_hash: true },
  });
  assertSourceSubset("auth user", [...knownUsers], importedUsers.map((user) => user.id));
  for (const user of importedUsers) {
    if (user.password_hash !== (passwordHashes.get(user.id) ?? null)) {
      throw new Error("Destination password-verifier reconciliation failed");
    }
  }

  const expectedGoogleIdentities = new Map(manifest.users.flatMap((user) => {
    const providers = user.app_metadata && typeof user.app_metadata === "object" && Array.isArray((user.app_metadata as Row).providers)
      ? (user.app_metadata as Row).providers as unknown[] : [];
    if (!providers.includes("google")) return [];
    const subject = googleProviderSubject(user);
    if (!subject) throw new Error(`Google user ${user.id} has no exported provider subject`);
    return [[String(user.id), subject] as const];
  }));
  const importedGoogleIdentities = await tx.authIdentity.findMany({
    where: { provider: "google", user_id: { in: [...expectedGoogleIdentities.keys()] } },
    select: { user_id: true, provider_subject: true },
  });
  for (const [userId, subject] of expectedGoogleIdentities) {
    if (!importedGoogleIdentities.some((identity) => identity.user_id === userId && identity.provider_subject === subject)) {
      throw new Error("Destination Google-identity reconciliation failed");
    }
  }

  const normalizedChecks: Array<[string, string[], string[]]> = [
    ["profile", rows("profiles").map((row) => String(row.user_id)), (await tx.profile.findMany({ where: { user_id: { in: rows("profiles").map((row) => String(row.user_id)) } }, select: { user_id: true } })).map((row) => row.user_id)],
    ["post", rows("posts").map((row) => String(row.id)), (await tx.post.findMany({ where: { id: { in: rows("posts").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["comment", rows("comments").map((row) => String(row.id)), (await tx.comment.findMany({ where: { id: { in: rows("comments").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["reaction", rows("reactions").map((row) => String(row.id)), (await tx.reaction.findMany({ where: { id: { in: rows("reactions").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["report", rows("reports").map((row) => String(row.id)), (await tx.report.findMany({ where: { id: { in: rows("reports").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["connection", rows("connections").map((row) => String(row.id)), (await tx.connection.findMany({ where: { id: { in: rows("connections").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["job", rows("jobs").map((row) => String(row.id)), (await tx.job.findMany({ where: { id: { in: rows("jobs").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["application", rows("applications").map((row) => String(row.id)), (await tx.application.findMany({ where: { id: { in: rows("applications").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["event", rows("events").map((row) => String(row.id)), (await tx.event.findMany({ where: { id: { in: rows("events").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
    ["RSVP", rows("rsvps").map((row) => String(row.id)), (await tx.rsvp.findMany({ where: { id: { in: rows("rsvps").map((row) => String(row.id)) } }, select: { id: true } })).map((row) => row.id)],
  ];
  for (const [label, expected, actual] of normalizedChecks) assertSourceSubset(label, expected, actual);

  const assertMappedUrlFields = (
    label: string,
    expectedRows: Row[],
    actualRows: Row[],
    identityField: string,
    urlFields: string[],
  ): void => {
    const actualById = new Map(actualRows.map((row) => [String(row[identityField]), row]));
    for (const expected of expectedRows) {
      const actual = actualById.get(String(expected[identityField]));
      if (!actual || urlFields.some((field) => (actual[field] ?? null) !== (expected[field] ?? null))) {
        throw new Error(`Destination ${label} storage-URL reconciliation failed`);
      }
    }
  };
  assertMappedUrlFields("profile", operationalRows("profiles"), await tx.profile.findMany({
    where: { user_id: { in: operationalRows("profiles").map((row) => String(row.user_id)) } },
    select: { user_id: true, avatar_url: true, cover_photo_url: true },
  }) as Row[], "user_id", ["avatar_url", "cover_photo_url"]);
  assertMappedUrlFields("post", operationalRows("posts"), await tx.post.findMany({
    where: { id: { in: operationalRows("posts").map((row) => String(row.id)) } },
    select: { id: true, image_url: true, media_url: true, file_url: true, voice_url: true },
  }) as Row[], "id", ["image_url", "media_url", "file_url", "voice_url"]);
  assertMappedUrlFields("job", operationalRows("jobs"), await tx.job.findMany({
    where: { id: { in: operationalRows("jobs").map((row) => String(row.id)) } },
    select: { id: true, company_logo_url: true },
  }) as Row[], "id", ["company_logo_url"]);
  assertMappedUrlFields("application", operationalRows("applications"), await tx.application.findMany({
    where: { id: { in: operationalRows("applications").map((row) => String(row.id)) } },
    select: { id: true, resume_url: true },
  }) as Row[], "id", ["resume_url"]);
  assertMappedUrlFields("event", operationalRows("events"), await tx.event.findMany({
    where: { id: { in: operationalRows("events").map((row) => String(row.id)) } },
    select: { id: true, image_url: true },
  }) as Row[], "id", ["image_url"]);

  for (const table of SUPABASE_SOURCE_TABLES) {
    if (!legacyTables.has(table) && !PRIVATE_ARCHIVE_TABLES.has(table)) continue;
    const expected = rows(table).map((row) => legacyRecordIdFor(table, row));
    if (!expected.length) continue;
    const actual = await tx.legacyRecord.findMany({
      where: { table_name: importedLegacyTableName(table), record_id: { in: expected } },
      select: { record_id: true, data: true },
    });
    assertSourceSubset(`${table} compatibility`, expected, actual.map((row) => row.record_id));
    const actualById = new Map(actual.map((row) => [row.record_id, row.data]));
    for (const sourceRow of operationalRows(table)) {
      const recordId = legacyRecordIdFor(table, sourceRow);
      const expectedRow = table === "messages" ? withDeletedMessageUsers(sourceRow, deletedMessageUsers) : sourceRow;
      if (jsonSha256(actualById.get(recordId)) !== jsonSha256(expectedRow)) {
        throw new Error(`Destination ${table} compatibility payload reconciliation failed`);
      }
    }
  }

  const storedSnapshots = await tx.legacyRecord.findMany({
    where: { table_name: SOURCE_SNAPSHOT_TABLE, record_id: { in: sourceSnapshots.map((snapshot) => snapshot.recordId) } },
    select: { record_id: true, data: true },
  });
  assertSourceSubset("private source snapshot", sourceSnapshots.map((snapshot) => snapshot.recordId), storedSnapshots.map((snapshot) => snapshot.record_id));
  for (const expected of sourceSnapshots) {
    const stored = storedSnapshots.find((snapshot) => snapshot.record_id === expected.recordId)?.data;
    const storedRow = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Row : {};
    if (storedRow.sha256 !== expected.sha256 || jsonSha256(storedRow.payload) !== expected.sha256) {
      throw new Error(`Private source snapshot reconciliation failed for ${expected.recordId}`);
    }
  }

  const importedFiles = await tx.fileObject.findMany({
    where: { object_key: { in: storageEntries.map((entry) => entry.key) } },
    select: {
      object_key: true, uploaded_by: true, bucket: true, original_name: true, mime_type: true,
      size_bytes: true, visibility: true, sha256: true, status: true, deleted_at: true,
    },
  });
  assertSourceSubset("file metadata", storageEntries.map((entry) => entry.key), importedFiles.map((file) => file.object_key));
  for (const entry of storageEntries) {
    const file = importedFiles.find((candidate) => candidate.object_key === entry.key);
    const metadata = entry.object.metadata && typeof entry.object.metadata === "object" ? entry.object.metadata as Row : {};
    const firstSegment = entry.objectPath.split("/")[0] || "";
    const expectedUploader = knownUsers.has(firstSegment) ? firstSegment : null;
    if (!file
      || file.uploaded_by !== expectedUploader
      || file.bucket !== entry.bucket
      || file.original_name !== path.basename(entry.objectPath).slice(0, 255)
      || file.mime_type !== (text(metadata.mimetype) || "application/octet-stream")
      || file.size_bytes.toString() !== String(entry.size)
      || file.visibility !== (publicBuckets.has(entry.bucket) ? "public" : "private")
      || file.sha256 !== entry.sha256
      || file.status !== "ready"
      || file.deleted_at !== null) {
      throw new Error(`File metadata reconciliation failed for ${entry.key}`);
    }
  }
};

await prisma.$transaction(async (tx) => {
  for (const sourceUser of manifest.users) {
    const id = String(sourceUser.id);
    const email = text(sourceUser.email)?.toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(id) || !email) throw new Error("Supabase auth user is missing a stable UUID/email");
    const confirmed = date(sourceUser.email_confirmed_at ?? sourceUser.confirmed_at);
    const passwordHash = passwordHashes.get(id) ?? null;
    await tx.user.upsert({
      where: { id },
      create: { id, email, phone: text(sourceUser.phone), password_hash: passwordHash, role: ownerRole.get(id) || "member", status: confirmed ? "active" : "pending", email_verified_at: confirmed, last_login_at: date(sourceUser.last_sign_in_at), created_at: date(sourceUser.created_at), updated_at: date(sourceUser.updated_at) },
      update: { email, phone: text(sourceUser.phone), password_hash: passwordHash, role: ownerRole.get(id) || "member", status: confirmed ? "active" : "pending", email_verified_at: confirmed, last_login_at: date(sourceUser.last_sign_in_at) },
    });
    const providers = sourceUser.app_metadata && typeof sourceUser.app_metadata === "object" && Array.isArray((sourceUser.app_metadata as Row).providers)
      ? (sourceUser.app_metadata as Row).providers as unknown[] : [];
    if (providers.includes("google")) {
      const subject = googleProviderSubject(sourceUser);
      if (!subject) throw new Error(`Google user ${id} has no exported provider subject`);
      await tx.authIdentity.upsert({
        where: { provider_provider_subject: { provider: "google", provider_subject: subject } },
        create: { user_id: id, provider: "google", provider_subject: subject, provider_email: email },
        update: { user_id: id, provider_email: email },
      });
    }
  }

  for (const row of operationalRows("profiles")) {
    const userId = String(row.user_id);
    if (!knownUsers.has(userId)) throw new Error(`Profile references missing user ${userId}`);
    const data = {
      name: text(row.name), slug: text(row.slug), avatar_url: text(row.avatar_url), cover_photo_url: text(row.cover_photo_url),
      headline: text(row.headline), bio: text(row.bio), location: text(row.location), date_of_birth: date(row.date_of_birth),
      phone_country_code: text(row.phone_country_code), phone_number: text(row.phone_number), phone_full: text(row.phone_full),
      iit_email: text(row.iit_email)?.toLowerCase(), iit_name: text(row.iit_name), student_status: text(row.student_status),
      community_id: text(row.community_id) || "iit-community", role: ownerRole.get(userId) || text(row.role) || "member",
      is_verified: bool(row.is_verified), onboarding_completed: bool(row.onboarding_completed), is_mentor: bool(row.is_mentor),
      mentor_category: text(row.mentor_category), mentor_price_chat: row.mentor_price_chat == null ? undefined : String(row.mentor_price_chat), mentor_price_audio: row.mentor_price_audio == null ? undefined : String(row.mentor_price_audio), mentor_price_video: row.mentor_price_video == null ? undefined : String(row.mentor_price_video),
      expertise: json(row.expertise), skills: json(row.skills), experience: json(row.experience), social_links: json(row.social_links),
      primary_education_id: text(row.primary_education_id), slug_updated_at: date(row.slug_updated_at), created_at: date(row.created_at),
    };
    await tx.profile.upsert({ where: { user_id: userId }, create: { user_id: userId, ...data }, update: data });
  }

  for (const row of operationalRows("connections")) {
    const requester = String(row.requester_id); const receiver = String(row.receiver_id);
    if (!knownUsers.has(requester) || !knownUsers.has(receiver)) throw new Error(`Connection ${row.id} references a missing user`);
    const data = { requester_id: requester, receiver_id: receiver, pair_key: [requester, receiver].sort().join(":"), status: String(row.status || "pending"), note: text(row.note), responded_at: date(row.responded_at ?? row.withdrawn_at), created_at: date(row.created_at) };
    await tx.connection.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }

  for (const row of operationalRows("posts")) {
    const data = { author_id: importedPostAuthor(row, anonymousAuthors, knownUsers), content: String(row.content || ""), community_id: text(row.community_id) || "iit-community", channel: text(row.channel), scope_type: text(row.scope_type) || "GLOBAL", scope_key: text(row.scope_key) || "IIT_ALL", is_anonymous: bool(row.is_anonymous), tags: json(row.tags), campus_filter: text(row.campus_filter), degree_filter: text(row.degree_filter), branch_filter: text(row.branch_filter), batch_filter: text(row.batch_filter), cohort_filter: text(row.cohort_filter), student_status_filter: text(row.student_status_filter), image_url: text(row.image_url), image_path: text(row.image_path), media_url: text(row.media_url), media_type: text(row.media_type), media_path: text(row.media_path), media_metadata: json(row.media_metadata), file_url: text(row.file_url), file_path: text(row.file_path), file_name: text(row.file_name), file_type: text(row.file_type), file_size: row.file_size == null ? undefined : BigInt(String(row.file_size)), voice_url: text(row.voice_url), voice_path: text(row.voice_path), voice_duration: row.voice_duration == null ? undefined : Number(row.voice_duration), client_id: text(row.client_id), message_type: text(row.message_type), is_deleted_for_everyone: bool(row.is_deleted_for_everyone), deleted_by_user_id: text(row.deleted_by_user_id), deleted_for_users: json(row.deleted_for_users), seen_by: json(row.seen_by), deleted_at: date(row.deleted_at), edited_at: date(row.edited_at), pinned_at: date(row.pinned_at), created_at: date(row.created_at), updated_at: date(row.updated_at) };
    await tx.post.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of operationalRows("posts")) await tx.post.update({ where: { id: String(row.id) }, data: { reply_to_id: text(row.reply_to_id), reshared_post_id: text(row.reshared_post_id) } });

  for (const row of operationalRows("comments")) {
    const authorId = text(row.author_id);
    if (authorId && !knownUsers.has(authorId)) throw new Error(`Comment ${row.id} references missing user ${authorId}`);
    const data = { post_id: String(row.post_id), author_id: authorId, content: String(row.content || ""), edited_at: date(row.edited_at), created_at: date(row.created_at), updated_at: date(row.updated_at) };
    await tx.comment.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of operationalRows("comments")) {
    await tx.comment.update({ where: { id: String(row.id) }, data: { parent_comment_id: text(row.parent_comment_id) } });
  }

  for (const row of operationalRows("reactions")) {
    const userId = String(row.user_id);
    if (!knownUsers.has(userId)) throw new Error(`Reaction ${row.id} references missing user ${userId}`);
    const data = { entity_id: String(row.entity_id), user_id: userId, entity_type: text(row.entity_type) || "post", emoji: String(row.emoji || ""), created_at: date(row.created_at) };
    await tx.reaction.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }

  for (const row of operationalRows("reports")) {
    const reporterId = String(row.reporter_id);
    if (!knownUsers.has(reporterId)) throw new Error(`Report ${row.id} references missing user ${reporterId}`);
    const data = { entity_id: String(row.entity_id), reporter_id: reporterId, entity_type: text(row.entity_type) || "forum_msg", reason: String(row.reason || ""), status: text(row.status) || "open", resolved_at: date(row.resolved_at), resolved_by: text(row.resolved_by), created_at: date(row.created_at) };
    await tx.report.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }

  for (const row of operationalRows("jobs")) {
    const data = { title: String(row.title || "Untitled role"), created_by: text(row.created_by), community_id: text(row.community_id) || "iit-community", company: String(row.company || "Unknown"), company_logo_url: text(row.company_logo_url), location: text(row.location), job_type: text(row.job_type), category: text(row.category), experience: text(row.experience), experience_level: text(row.experience_level), easy_apply: bool(row.easy_apply), description: text(row.description), application_url: text(row.application_url), apply_url: text(row.apply_url), source_url: text(row.source_url), source_type: text(row.source_type), status: text(row.status) || "published", salary_min: row.salary_min == null ? undefined : String(row.salary_min), salary_max: row.salary_max == null ? undefined : String(row.salary_max), salary_currency: text(row.salary_currency), salary_text: text(row.salary_text), skills: json(row.skills), source_fingerprint: text(row.source_fingerprint), scan_run_id: text(row.scan_run_id), discovered_at: date(row.discovered_at), last_seen_at: date(row.last_seen_at), expires_at: date(row.expires_at), published_at: date(row.published_at), created_at: date(row.created_at), updated_at: date(row.updated_at) };
    await tx.job.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of operationalRows("applications")) {
    const applicantId = String(row.applicant_id);
    if (!knownUsers.has(applicantId)) throw new Error(`Application ${row.id} references missing user ${applicantId}`);
    const data = { job_id: String(row.job_id), applicant_id: applicantId, note: text(row.note), resume_url: text(row.resume_url), status: text(row.status) || "submitted", created_at: date(row.created_at), updated_at: date(row.updated_at) };
    await tx.application.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of operationalRows("events")) {
    const start = date(row.start_time); if (!start) throw new Error(`Event ${row.id} has no start_time`);
    const data = { title: String(row.title || "Untitled event"), description: text(row.description), location: text(row.location), start_time: start, end_time: date(row.end_time), image_url: text(row.image_url), registration_url: text(row.registration_url), organizer_name: text(row.organizer_name), organizer: text(row.organizer), source_iit: text(row.source_iit), audience_type: text(row.audience_type), audience_targets: json(row.audience_targets), audience_mode: text(row.audience_mode), target_iits: json(row.target_iits), target_courses: json(row.target_courses), target_specialisations: json(row.target_specialisations), source_url: text(row.source_url), source_fingerprint: text(row.source_fingerprint), scan_run_id: text(row.scan_run_id), source_type: text(row.source_type), status: text(row.status) || "draft", community_id: text(row.community_id) || "iit-community", created_by: text(row.created_by), published_at: date(row.published_at), created_at: date(row.created_at), updated_at: date(row.updated_at) };
    await tx.event.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }
  for (const row of operationalRows("rsvps")) {
    const data = { event_id: String(row.event_id), user_id: String(row.user_id), status: text(row.status) || "going", created_at: date(row.created_at), updated_at: date(row.updated_at) };
    await tx.rsvp.upsert({ where: { id: String(row.id) }, create: { id: String(row.id), ...data }, update: data });
  }

  // Older importers could expose source control-plane/security rows under
  // their active compatibility names. Relocate every such row atomically.
  // If an existing private row (or a changed frozen row) would overwrite the
  // old payload, retain the old row as a private migration artifact instead.
  for (const table of PRIVATE_ARCHIVE_TABLES) {
    const activeRows = await tx.legacyRecord.findMany({ where: { table_name: table } });
    const privateTable = importedLegacyTableName(table);
    const incomingById = new Map(operationalRows(table).map((row) => [legacyRecordIdFor(table, row), row]));
    for (const old of activeRows) {
      const collision = await tx.legacyRecord.findUnique({
        where: { table_name_record_id: { table_name: privateTable, record_id: old.record_id } },
        select: { id: true },
      });
      const incoming = incomingById.get(old.record_id);
      const wouldOverwriteDifferentPayload = incoming !== undefined && jsonSha256(incoming) !== jsonSha256(old.data);
      await tx.legacyRecord.update({
        where: { id: old.id },
        data: collision || wouldOverwriteDifferentPayload
          ? { table_name: MIGRATION_ARTIFACT_TABLE, record_id: old.id }
          : { table_name: privateTable },
      });
    }
  }
  // Preserve (rather than delete) records made by the earlier importer, which
  // incorrectly used only the second half of this composite source key.
  const oldSpecialisations = await tx.legacyRecord.findMany({
    where: { table_name: "academic_specialisations", NOT: { record_id: { contains: ":" } } },
  });
  for (const old of oldSpecialisations) {
    const oldData = old.data && typeof old.data === "object" && !Array.isArray(old.data) ? old.data as Row : {};
    let correctedId: string | undefined;
    try {
      correctedId = legacyRecordIdFor("academic_specialisations", oldData);
    } catch {
      // An unidentifiable old row remains available as an internal migration
      // artifact instead of contaminating the active compatibility table.
    }
    const collision = correctedId ? await tx.legacyRecord.findUnique({
      where: { table_name_record_id: { table_name: "academic_specialisations", record_id: correctedId } },
      select: { id: true },
    }) : null;
    await tx.legacyRecord.update({
      where: { id: old.id },
      data: collision && collision.id !== old.id
        ? { table_name: MIGRATION_ARTIFACT_TABLE, record_id: old.id }
        : correctedId ? { record_id: correctedId } : { table_name: MIGRATION_ARTIFACT_TABLE, record_id: old.id },
    });
  }
  const seenLegacyKeys = new Set<string>();
  for (const [table, values] of Object.entries(operationalTables)) {
    if (!legacyTables.has(table) && !PRIVATE_ARCHIVE_TABLES.has(table)) continue;
    for (const row of values) {
      const recordId = legacyRecordIdFor(table, row);
      const destinationTable = importedLegacyTableName(table);
      const legacyKey = `${destinationTable}\0${recordId}`;
      if (seenLegacyKeys.has(legacyKey)) throw new Error(`${table} contains duplicate source identity ${recordId}`);
      seenLegacyKeys.add(legacyKey);
      const owner = (ownershipFields[table] || []).map((field) => text(row[field])).find(Boolean);
      if (owner && !knownUsers.has(owner)) throw new Error(`${table}/${recordId} references missing owner ${owner}`);
      const importedRow = table === "messages" ? withDeletedMessageUsers(row, deletedMessageUsers) : row;
      await tx.legacyRecord.upsert({
        where: { table_name_record_id: { table_name: destinationTable, record_id: recordId } },
        create: { table_name: destinationTable, record_id: recordId, owner_id: owner, community_id: text(importedRow.community_id), data: importedRow as Prisma.InputJsonValue, created_at: date(importedRow.created_at) },
        update: { owner_id: owner, community_id: text(importedRow.community_id), data: importedRow as Prisma.InputJsonValue },
      });
    }
  }

  // Keep an exact private, API-inaccessible source snapshot as the lossless
  // backstop for columns that have no normalized MySQL equivalent. Password
  // verifiers are deliberately excluded and exist only in users.password_hash.
  for (const snapshot of sourceSnapshots) {
    await tx.legacyRecord.upsert({
      where: { table_name_record_id: { table_name: SOURCE_SNAPSHOT_TABLE, record_id: snapshot.recordId } },
      create: {
        table_name: SOURCE_SNAPSHOT_TABLE,
        record_id: snapshot.recordId,
        data: snapshot.data,
        created_at: date(manifest.exported_at),
      },
      update: { owner_id: null, community_id: null, data: snapshot.data },
    });
  }

  for (const entry of storageEntries) {
    const metadata = entry.object.metadata && typeof entry.object.metadata === "object" ? entry.object.metadata as Row : {};
    const firstSegment = entry.objectPath.split("/")[0] || "";
    const uploadedBy = knownUsers.has(firstSegment) ? firstSegment : null;
    const originalName = path.basename(entry.objectPath).slice(0, 255);
    const mimeType = text(metadata.mimetype) || "application/octet-stream";
    const visibility = publicBuckets.has(entry.bucket) ? "public" : "private";
    await tx.fileObject.upsert({
      where: { object_key: entry.key },
      create: { uploaded_by: uploadedBy, bucket: entry.bucket, object_key: entry.key, original_name: originalName, mime_type: mimeType, size_bytes: entry.size, visibility, sha256: entry.sha256 },
      update: { uploaded_by: uploadedBy, bucket: entry.bucket, original_name: originalName, mime_type: mimeType, size_bytes: entry.size, visibility, sha256: entry.sha256, status: "ready", deleted_at: null },
    });
  }
  await reconcileInsideTransaction(tx);
}, { timeout: 600_000 });

process.stdout.write(`${JSON.stringify({ mode: "applied", upload_objects: uploadObjects, reconciliation: "passed", ...summary }, null, 2)}\n`);
await prisma.$disconnect();
