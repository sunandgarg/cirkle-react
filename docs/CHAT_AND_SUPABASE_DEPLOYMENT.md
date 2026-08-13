# Chat and Supabase deployment

## Current target

- Project ref: `bugwubrwvlqayxwcazfd`
- Client URL: `https://bugwubrwvlqayxwcazfd.supabase.co`
- The browser uses only the publishable key. Never put a secret/service-role key in `VITE_*` variables.

The supplied project currently has no `public.profiles` table. Import the application's existing base schema before applying the chat migration. The repository does not contain that original base migration.

## Apply the chat migration

After importing the base schema, link the Supabase CLI with an authorized account and run:

```bash
supabase link --project-ref bugwubrwvlqayxwcazfd
supabase db push
```

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
