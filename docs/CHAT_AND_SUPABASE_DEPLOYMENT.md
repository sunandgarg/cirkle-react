# Chat and Supabase deployment

## Current target

- Project ref: `bugwubrwvlqayxwcazfd`
- Client URL: `https://bugwubrwvlqayxwcazfd.supabase.co`
- The browser uses only the publishable key. Never put a secret/service-role key in `VITE_*` variables.

Fresh projects are reproducible from source control. `20260812000000_base_schema.sql`
creates the foundational tables, RLS policies, helper functions, storage buckets,
and grants before the feature migrations are applied.

## Apply the chat migration

Link the Supabase CLI with an authorized account and run:

```bash
supabase link --project-ref bugwubrwvlqayxwcazfd
supabase db push
```

## Verification and test-data functions

The IIT verification flow uses Zoho ZeptoMail as the primary transactional
provider, with Zavu and AWS SES as automatic fallbacks. Generate a unique pepper;
never reuse a frontend or database key.

```bash
supabase secrets set ZEPTOMAIL_API_KEY=... \
  EMAIL_PROVIDER_PRIMARY=zeptomail EMAIL_PROVIDER_FALLBACK=zavu,ses \
  VERIFICATION_CODE_PEPPER=... \
  'VERIFICATION_EMAIL_FROM=Cirkle <verify@cirkle.world>' SEED_DATA_ENABLED=true
supabase functions deploy send-verification-email
supabase functions deploy verify-iit-email
supabase functions deploy seed-data
```

`seed-data` remains admin-only even while enabled. Set `SEED_DATA_ENABLED=false`
before public launch after the test records have been purged.

The migration in `supabase/migrations/20260813000000_chat_performance.sql` adds:

- indexed, cursor-friendly message reads;
- idempotent message IDs to prevent duplicate sends;
- one-query inbox summaries and unread counts;
- atomic one-to-one room creation;
- validated group creation;
- one-write-per-room read state;
- chat membership RLS policies;
- a WebP-compatible storage bucket policy;
- Realtime publication for new messages.

## Performance model

- The client fetches 50 messages at a time and keeps the latest 200 per room in IndexedDB.
- Typing state uses ephemeral Realtime broadcast, so it does not write to Postgres.
- Chat images are converted to WebP before upload, stored with immutable cache headers, lazy-decoded, and cached by the service worker.
- The call SDK is loaded only when a call begins.
- Auth refresh is handled by Supabase only when required; the session and last profile remain locally available across restarts.

## Scale validation

No client implementation alone guarantees one million simultaneous users. Before a large launch, load-test message insert latency, Realtime fan-out, inbox RPC latency, database connections, storage/CDN egress, and reconnect storms against the selected Supabase plan. Large public rooms may need a dedicated fan-out service and message partitioning; one-to-one and normal-sized group rooms can use the included design.

## Product model

Use LinkedIn-style accepted connections as the gate for one-to-one chat. It limits spam while still fitting a community product whose main publishing surface is the forum. Posts do not need to be added to the Network screen for connection-based messaging to make sense.

## Optional test data

The `seed-data` Edge Function creates 20 demo members plus connections, forum threads, chats, jobs, polls, reactions, and a consultation. It is disabled by default and restricted to authenticated administrators.

For a non-production project only:

```bash
supabase secrets set SEED_DATA_ENABLED=true
supabase functions deploy seed-data
```

Then invoke `seed-data` while signed in as an administrator. The `test_seed_version` marker makes the completed seed idempotent. Disable it again afterward:

```bash
supabase secrets set SEED_DATA_ENABLED=false
```
