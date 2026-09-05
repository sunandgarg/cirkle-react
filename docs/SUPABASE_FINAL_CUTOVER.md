# Supabase to AWS final cutover

This is a copy-and-reconcile migration. It does not delete or mutate Supabase data. The old Supabase export (50 tables / 638 public rows) is not a cutover artifact: version 2 deliberately rejects it.

## What version 2 preserves

- All 64 reviewed `public` tables, not only the original 50.
- Every Auth Admin user plus Google provider subjects.
- Every email-provider user's bcrypt verifier, when supplied by the protected SQL export below. Verifiers are installed only with an explicit importer flag and are never printed.
- All Storage buckets, object metadata, object bytes, byte counts and SHA-256 digests.
- Exact source-host public Storage URLs are rewritten in operational typed and compatibility records to the AWS public-storage URL only when the bucket is public and the referenced object was exported and hash-verified. Unsupported or missing source-host Storage references stop the migration. The private raw snapshot remains byte-for-byte semantically faithful to Supabase.
- Normalized MySQL records for profiles, forum posts/comments/reactions/reports, connections, jobs/applications, events/RSVPs and auth users.
- Compatibility records for the remaining application tables.
- A lossless private snapshot of all 64 source tables, Auth Admin metadata and the Storage catalog in `legacy_records.table_name = 'supabase_source_snapshot_v2'`. This table name is not accepted by the public data API.
- Anonymous forum ownership from `forum_anonymous_authors` is restored only to the internal `posts.author_id`. Existing forum DTO authorization continues to hide it from other members.
- `message_deleted_for_user` markers are folded into each private message's `deleted_for_users` list so deleted messages do not reappear.
- Source `realtime_delivery_outbox` rows are written only under `supabase_private_archive:realtime_delivery_outbox` and the lossless snapshot. They are never written under the Node runtime table name and must never be replayed.
- Legacy plaintext `verification_codes` rows are moved out of the API namespace without deletion and imported only under `supabase_private_archive:verification_codes` plus the private snapshot. The Node API does not allow `verification_codes` compatibility queries.

The importer is additive/upserting. It does not remove unrelated AWS-created rows. An obsolete single-column academic-specialisation record is moved to its correct composite identity, or preserved under `supabase_migration_artifact` if it conflicts; it is not deleted.

## Audited starting point (2026-09-05)

These are diagnostics, not hard-coded acceptance totals. The final frozen export is authoritative.

| Area | Audited source |
| --- | ---: |
| Auth users | 35 |
| Google-provider users | 23 |
| Email-provider users / bcrypt verifiers | 14 / 14 |
| MFA users/factors | 0 / 0 |
| Public tables / rows | 64 / 2,389 |
| Storage buckets / objects / bytes | 9 / 8 / 1,368,387 |
| Anonymous posts / recoverable private mappings | 7 / 6 |
| Realtime outbox | 124 (104 delivered, 20 failed) |
| Legacy plaintext verification codes | 28 (5 unused, all expired at audit) |

The one anonymous post with no mapping is already orphaned in Supabase. Its owner cannot be reconstructed honestly. The importer reports it and refuses apply unless the operator explicitly acknowledges the exact orphan count.

## Gate 1: freeze every source writer

Count equality is not a write freeze. The REST exporter reads tables sequentially, while Storage and Auth are separate services. Do all of the following in one maintenance window:

1. Put every Cirkle frontend URL in maintenance mode, including old Pages URLs; changing only `cirkle.world` is insufficient because an old tab can still call Supabase directly.
2. Stop the old API, Supabase Edge Functions, cron jobs, webhooks, scanners and any script holding a service-role key.
3. Temporarily disable Auth sign-ups and all application login entry points.
4. Temporarily deny `INSERT`, `UPDATE`, `DELETE` and mutating RPC/storage operations for `anon`, `authenticated` and service writers while retaining read access for the export. Capture the provider configuration/grants first so this can be reversed exactly. Do not improvise grant changes during cutover; rehearse them against a staging project.
5. Wait for in-flight requests to finish. Confirm there are no active writers or scheduled jobs.
6. Freeze AWS application writers too. The source manifest must be the only authority during import.

Run two complete exports under that same freeze. Their `source_content_sha256` values must match. If they differ, a writer is still active or the source was not frozen; do not import.

## Gate 2: obtain password verifiers read-only

The Supabase Auth Admin API intentionally does not return `encrypted_password`. Use a direct, read-only SQL connection as a privileged operator. Do not paste the output into a terminal, ticket, chat, Git, logs or an unencrypted artifact.

```sh
set +x
umask 077
PASSWORD_HASHES_FILE="$(mktemp /private/tmp/cirkle-password-hashes.XXXXXX.json)"
psql "$SUPABASE_DB_URL" --no-psqlrc --tuples-only --no-align \
  --command="COPY (SELECT COALESCE(json_agg(json_build_object('id', id::text, 'encrypted_password', encrypted_password) ORDER BY id), '[]'::json)::text FROM auth.users WHERE encrypted_password IS NOT NULL AND encrypted_password <> '') TO STDOUT" \
  > "$PASSWORD_HASHES_FILE"
chmod 600 "$PASSWORD_HASHES_FILE"
```

Only the file owner should be able to read this file. Version 2 accepts only known email-provider user IDs and syntactically valid bcrypt values; it rejects duplicates, Google-only users and an incomplete set. The audited source must yield 14 rows. Do not commit this file. Destroy the temporary copy securely after verified cutover and backup retention are settled.

If direct SQL access is unavailable, the only safe alternative is an explicit forced-reset migration. Set `SUPABASE_ALLOW_PASSWORD_RESET_ONLY=true` for export and later apply with `--allow-forced-password-reset`. All users must sign in again and all email-password users must use password reset. Never silently substitute this fallback.

Supabase refresh/access sessions cannot be converted to Cirkle Node sessions. A fresh sign-in is required in either mode. There were no source MFA factors at audit time; if the final audit finds any, MFA enrollment requires a separate migration or recovery plan before cutover.

## Gate 3: create two version-2 exports

Use a service-role key only through a protected environment variable. The following paths are examples; keep both output directories outside Git.

```sh
set +x
umask 077
export SUPABASE_URL='https://bugwubrwvlqayxwcazfd.supabase.co'
read -r -s SUPABASE_SERVICE_ROLE_KEY
export SUPABASE_SERVICE_ROLE_KEY
export SUPABASE_PASSWORD_HASHES_FILE="$PASSWORD_HASHES_FILE"

export SUPABASE_EXPORT_DIR=/private/tmp/cirkle-final-export-a
node scripts/export-supabase.mjs

export SUPABASE_EXPORT_DIR=/private/tmp/cirkle-final-export-b
node scripts/export-supabase.mjs

DIGEST_A="$(jq -r .source_content_sha256 /private/tmp/cirkle-final-export-a/manifest.json)"
DIGEST_B="$(jq -r .source_content_sha256 /private/tmp/cirkle-final-export-b/manifest.json)"
test "$DIGEST_A" = "$DIGEST_B"
```

Each run must report export version 2, 64 source tables, the current public-row total, 35 or more users as appropriate at freeze time, `password_migration_mode: bcrypt`, and one verifier per final email-provider user. The second directory is the final artifact. A manifest-content digest mismatch is a hard stop.

Archive the frozen directory in a private encrypted location with tightly scoped IAM. It contains personal data and bcrypt verifiers. Never place it in the frontend bundle or a public deployment bucket.

## Gate 4: back up and plan AWS

Before importing:

1. Take and verify a managed-MySQL backup outside the database's primary failure boundary.
2. Confirm the target S3 bucket is private, versioned/encrypted and has no broad read policy.
3. Deploy the release containing the version-2 importer.
4. Copy the entire final export directory to a protected path on the API instance. Keep `manifest.json` adjacent to `storage/`.
5. Run the plan without mutation:

```sh
cd /srv/cirkle/current
./node_modules/.bin/tsx server/src/scripts/import-supabase-full.ts \
  --file=/protected/cirkle-final-export-b/manifest.json
```

The plan validates the 64-table contract, whole-manifest digest, complete password set, typed and compatibility identities/relationships, dates and numeric media fields, anonymous mappings, Storage URL references and every local media hash. For the audited source it must report six recovered anonymous mappings, one anonymous orphan and six rewritten Storage URL occurrences. Investigate any different count before proceeding.

## Gate 5: apply once and reconcile automatically

For the audited single historical orphan, the deliberate apply command is:

```sh
cd /srv/cirkle/current
./node_modules/.bin/tsx server/src/scripts/import-supabase-full.ts \
  --file=/protected/cirkle-final-export-b/manifest.json \
  --apply \
  --upload-objects \
  --apply-password-hashes \
  --allow-anonymous-orphans=1
```

If the plan reports zero or a different known count, use that exact count; never copy `1` blindly. The importer:

- uploads with create-only semantics and rejects any existing S3 object whose bytes differ;
- verifies every destination object before changing MySQL;
- applies normalized and compatibility records and runs every deterministic database reconciliation inside one MySQL transaction; any reconciliation exception rolls the whole database transaction back;
- installs bcrypt verifiers only with the explicit flag;
- stores and rereads all 66 private snapshot records (64 public tables, Auth users, Storage catalog);
- verifies all source auth/Google identities, typed record IDs and mapped media URLs, exact compatibility payloads, complete file metadata and snapshot SHA-256 values before commit.

Success is only the final JSON result containing `"reconciliation": "passed"`. A non-zero exit or missing reconciliation result is a failed cutover, even if some immutable S3 objects were staged. The command is idempotent and can be rerun after correcting the failure.

## Gate 6: functional acceptance before DNS

Keep both systems frozen while testing the AWS origin directly:

- Sign in with Google using a migrated Google account.
- Sign in with a known authorized email/password test account; also test password reset delivery.
- Confirm all users must establish new Cirkle sessions.
- As the author of a recovered anonymous post, edit/delete it. As another member, verify author ID/profile/media paths remain hidden.
- Confirm the one acknowledged orphan is readable but has no fabricated owner.
- Confirm messages hidden through per-user deletion stay hidden.
- Check forum posts/replies/comments/reactions/reports, profiles/connections, jobs/applications, events/RSVPs, chat attachments and verification workflows.
- Confirm all eight audited media objects (or the final frozen count) download only through authorized API/CloudFront paths.
- Confirm imported Supabase outbox rows exist only under `supabase_private_archive:realtime_delivery_outbox`; do not replay the 20 historical failures.
- Confirm no operational profile/logo/media field references `bugwubrwvlqayxwcazfd.supabase.co`, while the private source snapshot still preserves the original source rows.
- Confirm `verification_codes` is rejected by the compatibility API and the 28 historical rows exist only in the private archive/snapshot.

Only after these pass should DNS/frontend API configuration move to AWS. Keep Supabase intact and read-only for an agreed rollback period. If rollback is needed, stop AWS writers before re-enabling Supabase; never permit independent writes to both systems and attempt an ad-hoc merge.
