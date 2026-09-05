import type { Post } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assertSupabaseSourceSchema,
  canonicalJson,
  emailProviderUserIds as exportedEmailProviderUserIds,
  SUPABASE_EXPORT_VERSION as EXPORT_VERSION,
  SUPABASE_SOURCE_TABLES as EXPORTED_TABLES,
  validatePasswordHashRows,
} from "../../scripts/lib/supabase-export-config.mjs";
import {
  assertAnonymousAuthorMappings,
  assertCompleteManifest,
  buildAnonymousAuthorMap,
  buildPasswordHashMap,
  createSupabaseStorageUrlRewriter,
  deletedMessageUsersByMessage,
  googleProviderSubject,
  importedLegacyTableName,
  importedPostAuthor,
  legacyRecordIdFor,
  PRIVATE_ARCHIVE_TABLES,
  SUPABASE_EXPORT_VERSION as IMPORT_VERSION,
  SUPABASE_SOURCE_TABLES as IMPORTED_TABLES,
  withDeletedMessageUsers,
} from "../src/scripts/supabaseImportSupport.js";
import { legacyTables } from "../src/services/data.js";
import { buildForumPostDto } from "../src/services/forum.js";

const userOne = "11111111-1111-4111-8111-111111111111";
const userTwo = "22222222-2222-4222-8222-222222222222";
const postOne = "33333333-3333-4333-8333-333333333333";
const bcrypt = `$2b$12$${"A".repeat(53)}`;

describe("Supabase cutover contract", () => {
  it("keeps exporter and importer on the same reviewed 64-table schema", () => {
    expect(EXPORT_VERSION).toBe(IMPORT_VERSION);
    expect(EXPORTED_TABLES).toEqual(IMPORTED_TABLES);
    expect(EXPORTED_TABLES).toHaveLength(64);
    expect(EXPORTED_TABLES).toEqual(expect.arrayContaining([
      "client_error_logs", "email_provider_daily_usage", "forum_anonymous_authors", "forum_deleted_for_user",
      "iit_recruiters", "job_engagement_events", "job_scan_sources", "login_otp_rate_limits",
      "message_deleted_for_user", "onboarding_progress", "pending_profile_options", "realtime_channel_registry",
      "realtime_delivery_outbox", "user_activity_daily", "user_activity_sessions",
    ]));
    expect([...PRIVATE_ARCHIVE_TABLES].sort()).toEqual([
      "forum_anonymous_authors", "login_otp_rate_limits", "message_deleted_for_user", "realtime_delivery_outbox", "verification_codes",
    ]);
    expect(importedLegacyTableName("realtime_delivery_outbox"))
      .toBe("supabase_private_archive:realtime_delivery_outbox");
    expect(importedLegacyTableName("messages")).toBe("messages");
    expect(importedLegacyTableName("verification_codes"))
      .toBe("supabase_private_archive:verification_codes");
    for (const table of PRIVATE_ARCHIVE_TABLES) expect(legacyTables.has(table)).toBe(false);
  });

  it("fails closed when live schema or a manifest drifts", () => {
    expect(assertSupabaseSourceSchema(EXPORTED_TABLES)).toEqual(EXPORTED_TABLES);
    expect(() => assertSupabaseSourceSchema([...EXPORTED_TABLES, "unreviewed_table"])).toThrow(/schema drift/i);
    expect(() => assertCompleteManifest({
      export_version: IMPORT_VERSION,
      source_schema_tables: EXPORTED_TABLES,
      tables: Object.fromEntries(EXPORTED_TABLES.slice(1).map((table) => [table, []])),
    })).toThrow(/incomplete/i);
    expect(() => assertCompleteManifest({
      export_version: IMPORT_VERSION - 1,
      source_schema_tables: EXPORTED_TABLES,
      tables: Object.fromEntries(EXPORTED_TABLES.map((table) => [table, []])),
    })).toThrow(/fresh frozen-source export/i);
    expect(() => assertCompleteManifest({
      export_version: IMPORT_VERSION,
      source_schema_tables: EXPORTED_TABLES,
      tables: Object.fromEntries(EXPORTED_TABLES.map((table) => [table, []])),
    })).not.toThrow();
  });

  it("canonicalizes equivalent JSON independently of object key order", () => {
    expect(canonicalJson({ b: [2, { y: true, x: null }], a: 1 }))
      .toBe(canonicalJson({ a: 1, b: [2, { x: null, y: true }] }));
  });

  it.each([
    ["client_error_logs", { event_id: postOne }, postOne],
    ["email_provider_daily_usage", { provider: "zeptomail", usage_date: "2026-09-05" }, "zeptomail:2026-09-05"],
    ["forum_anonymous_authors", { post_id: postOne }, postOne],
    ["forum_deleted_for_user", { id: postOne }, postOne],
    ["iit_recruiters", { id: postOne }, postOne],
    ["job_engagement_events", { id: postOne }, postOne],
    ["job_scan_sources", { id: postOne }, postOne],
    ["login_otp_rate_limits", { id: 17 }, "17"],
    ["message_deleted_for_user", { id: postOne }, postOne],
    ["onboarding_progress", { user_id: userOne }, userOne],
    ["pending_profile_options", { user_id: userOne, field: "location" }, `${userOne}:location`],
    ["realtime_channel_registry", { channel: "/forum/global/abcd" }, "/forum/global/abcd"],
    ["realtime_delivery_outbox", { id: 124 }, "124"],
    ["user_activity_daily", { user_id: userOne, activity_date: "2026-09-05" }, `${userOne}:2026-09-05`],
    ["user_activity_sessions", { user_id: userOne, session_id: "session-123" }, `${userOne}:session-123`],
  ])("uses a stable archive identity for %s", (table, row, expected) => {
    expect(legacyRecordIdFor(table, row)).toBe(expected);
  });
});

describe("Supabase Storage URL cutover", () => {
  const sourceOrigin = "https://bugwubrwvlqayxwcazfd.supabase.co";
  const objectPath = `${userOne}/avatar photo.webp`;
  const sourceUrl = `${sourceOrigin}/storage/v1/object/public/avatars/${userOne}/avatar%20photo.webp`;
  const destinationUrl = `https://api-react.cirkle.world/api/storage/public/avatars/${userOne}/avatar%20photo.webp`;
  const createRewriter = (overrides: Partial<Parameters<typeof createSupabaseStorageUrlRewriter>[0]> = {}) => createSupabaseStorageUrlRewriter({
    projectUrl: sourceOrigin,
    buckets: [{ id: "avatars", public: true }, { id: "verification-documents", public: false }],
    objects: [{ bucket: "avatars", path: objectPath }, { bucket: "verification-documents", path: `${userOne}/proof.pdf` }],
    publicObjectUrl: (bucket, path) => `https://api-react.cirkle.world/api/storage/public/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`,
    ...overrides,
  });

  it("recursively rewrites exact exported public URLs without changing the raw source", () => {
    const raw = {
      avatar_url: sourceUrl,
      nested: [{ logo_url: sourceUrl }],
      external_url: "https://other-project.supabase.co/storage/v1/object/public/avatars/external.webp",
    };
    const rewriter = createRewriter();
    const operational = rewriter.rewrite(raw);
    expect(operational).toEqual({
      avatar_url: destinationUrl,
      nested: [{ logo_url: destinationUrl }],
      external_url: raw.external_url,
    });
    expect(raw.avatar_url).toBe(sourceUrl);
    expect(raw.nested[0]!.logo_url).toBe(sourceUrl);
    expect(rewriter.rewriteCount).toBe(2);
  });

  it("fails closed for missing, private, signed, queried, or malformed source-host objects", () => {
    const rewriter = createRewriter();
    expect(() => rewriter.rewrite(`${sourceOrigin}/storage/v1/object/public/avatars/${userOne}/missing.webp`)).toThrow(/no hash-verified/i);
    expect(() => rewriter.rewrite(`${sourceOrigin}/storage/v1/object/public/verification-documents/${userOne}/proof.pdf`)).toThrow(/no hash-verified/i);
    expect(() => rewriter.rewrite(`${sourceOrigin}/storage/v1/object/sign/avatars/${userOne}/avatar.webp`)).toThrow(/unsupported/i);
    expect(() => rewriter.rewrite(`${sourceUrl}?download=1`)).toThrow(/unsupported/i);
    expect(() => rewriter.rewrite(`${sourceOrigin}/storage/v1/object/public/avatars/%ZZ`)).toThrow(/encoding/i);
  });

  it("rejects a destination URL that still points at Supabase", () => {
    const rewriter = createRewriter({ publicObjectUrl: () => sourceUrl });
    expect(() => rewriter.rewrite(sourceUrl)).toThrow(/destination public-storage URL/i);
  });
});

describe("private ownership preservation", () => {
  it("restores anonymous ownership internally while the forum DTO redacts it", () => {
    const users = new Set([userOne]);
    const sourcePosts = [{ id: postOne, author_id: null, is_anonymous: true }];
    const authors = buildAnonymousAuthorMap([{ post_id: postOne, author_id: userOne }], users);
    expect(() => assertAnonymousAuthorMappings(sourcePosts, authors)).not.toThrow();
    const authorId = importedPostAuthor(sourcePosts[0]!, authors, users);
    expect(authorId).toBe(userOne);

    const post = {
      ...sourcePosts[0], author_id: authorId, content: "anonymous", community_id: "iit-community",
      scope_type: "GLOBAL", scope_key: "IIT_ALL", created_at: new Date(), updated_at: new Date(),
    } as unknown as Post;
    expect(buildForumPostDto(post, userTwo, "member").author_id).toBeNull();
    expect(buildForumPostDto(post, userOne, "member")).toMatchObject({ author_id: userOne, viewer_is_author: true });
  });

  it("keeps a genuinely unmapped source orphan ownerless and rejects corrupt mappings", () => {
    const users = new Set([userOne, userTwo]);
    expect(importedPostAuthor({ id: postOne, author_id: null, is_anonymous: true }, new Map(), users)).toBeUndefined();
    expect(() => assertAnonymousAuthorMappings([], new Map([[postOne, userOne]]))).toThrow(/missing post/i);
    expect(() => assertAnonymousAuthorMappings(
      [{ id: postOne, author_id: null, is_anonymous: false }], new Map([[postOne, userOne]]),
    )).toThrow(/non-anonymous/i);
    expect(() => importedPostAuthor(
      { id: postOne, author_id: userTwo, is_anonymous: true }, new Map([[postOne, userOne]]), users,
    )).toThrow(/conflicting owners/i);
  });

  it("folds per-user message deletions into the private message record", () => {
    const users = new Set([userOne, userTwo]);
    const deleted = deletedMessageUsersByMessage([
      { message_id: postOne, user_id: userTwo },
      { message_id: postOne, user_id: userOne },
      { message_id: postOne, user_id: userOne },
    ], users);
    expect(withDeletedMessageUsers({ id: postOne, deleted_for_users: [userTwo] }, deleted))
      .toMatchObject({ deleted_for_users: [userOne, userTwo] });
  });
});

describe("auth parity", () => {
  const users = [
    { id: userOne, app_metadata: { providers: ["email", "google"] } },
    { id: userTwo, app_metadata: { providers: ["google"] } },
  ];

  it("accepts exactly one valid bcrypt verifier for every email-provider user", () => {
    expect(exportedEmailProviderUserIds(users)).toEqual(new Set([userOne]));
    const validated = validatePasswordHashRows(users, [{ id: userOne, encrypted_password: bcrypt }]);
    expect(validated).toEqual([{ user_id: userOne, password_hash: bcrypt }]);
    expect(buildPasswordHashMap(validated, new Set([userOne, userTwo]), new Set([userOne])).get(userOne)).toBe(bcrypt);
  });

  it("rejects incomplete, duplicate, malformed, unknown, or Google-only password rows", () => {
    expect(() => validatePasswordHashRows(users, [])).toThrow(/incomplete/i);
    expect(() => validatePasswordHashRows(users, [
      { user_id: userOne, password_hash: bcrypt }, { user_id: userOne, password_hash: bcrypt },
    ])).toThrow(/duplicate/i);
    expect(() => validatePasswordHashRows(users, [{ user_id: userOne, password_hash: "plaintext" }])).toThrow(/bcrypt/i);
    expect(() => validatePasswordHashRows(users, [{ user_id: userTwo, password_hash: bcrypt }])).toThrow(/non-email/i);
  });

  it("uses the Google identity subject rather than assuming it equals the Cirkle user ID", () => {
    expect(googleProviderSubject({
      identities: [{ id: "identity-row-id", provider: "google", identity_data: { sub: "google-subject" } }],
      user_metadata: { provider_id: "metadata-fallback" },
    })).toBe("google-subject");
  });
});
