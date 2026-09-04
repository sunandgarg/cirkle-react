# Cirkle API

The API is an Express/TypeScript service backed by Prisma and MySQL. It keeps the existing frontend's Supabase-shaped interface while enforcing authorization in the server. The production entry point is `server/dist/index.js`; it binds to `HOST` (default `127.0.0.1`) and `PORT` (default `3001`). AWS AppSync Events is the production realtime fan-out transport; Socket.IO at `/api/socket.io` remains the authorized local/failure fallback.

## Local startup

1. Copy the repository environment example and set every required secret. In particular, use independent random values of at least 32 characters for both JWT secrets.
2. Start MySQL, create the database named by `DATABASE_URL`, then run `pnpm db:migrate:deploy` and `pnpm db:seed`.
3. Run `pnpm dev:api` (or `pnpm dev` for API and Vite together).
4. Check `http://127.0.0.1:3001/healthz` and `http://127.0.0.1:3001/readyz`.

The seed is intentionally inert unless `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are set. It creates or updates one verified, onboarding-complete platform owner.

## Environment contract

Required: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `STORAGE_SIGNING_SECRET`.

Production settings: `NODE_ENV`, `HOST`, `PORT`, `TRUST_PROXY_HOPS`, `CORS_ORIGINS`, `APP_BASE_URL`, `FRONTEND_URL`, `DEFAULT_COMMUNITY_ID`, `COOKIE_SECURE`, `IP_HASH_SECRET`, `OTP_PEPPER`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `STORAGE_ROOT`, `MAX_UPLOAD_BYTES`, and `LOG_LEVEL`. Keep `COOKIE_DOMAIN` unset so refresh cookies remain host-only.

The API process must bind to loopback behind Nginx. Keep the `api.cirkle.world` DNS record in DNS-only mode (not Cloudflare-proxied), leave `TRUST_PROXY_HOPS=1`, and have Nginx overwrite `X-Forwarded-For` with `$remote_addr`. This keeps Express IP rate limits keyed to the actual client rather than a shared edge address. Request logs intentionally record only the URL pathname; OAuth codes, state values, storage signatures, and all other query parameters are excluded.

Provider integrations are optional in development and test. Production startup fails fast when credentials for any visible provider below are missing; `DAILY_DOMAIN` remains optional because Daily normally returns the room URL.

- ZeptoMail: `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_API_URL`, `ZEPTOMAIL_FROM_EMAIL`, `ZEPTOMAIL_FROM_NAME`. The checked production configuration uses the India REST endpoint and `noreply@cirkle.world`; SMTP credentials are not used. A 2xx response records provider acceptance, not final inbox delivery, and delivery/bounce webhooks still require a separate authenticated receiver.
- Google OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
- AI extraction: `OPENAI_API_KEY`, `OPENAI_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`.
- GIF and calling: `KLIPY_API_KEY`, `DAILY_API_KEY`, optionally `DAILY_DOMAIN`.
- AppSync Events: `APPSYNC_ENABLED=true`, `APPSYNC_HTTP_ENDPOINT`, and distinct
  server-only `APPSYNC_PUBLISH_TOKEN`/`APPSYNC_AUTHORIZER_SECRET` values. The
  Node API does not need an AWS access key.
- Local-only phone testing: `MOBILE_TEST_MODE=true` and an explicit comma-separated `MOBILE_TEST_PHONES` allowlist. This path is disabled in production.
- Test data: `ENABLE_SEED_DATA=true`; always disabled in production.

Missing optional provider credentials return an explicit `503`; provider failures return a non-secret `502` response.

## HTTP compatibility API

- Auth: `GET|POST /api/auth/session`, `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/otp`, `POST /api/auth/verify-otp`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `PUT /api/auth/user`, `GET /api/auth/google`, `GET /api/auth/google/callback`, `POST /api/auth/oauth/exchange`, `POST /api/auth/password-reset/request`, and `POST /api/auth/password-reset/complete`.
- Data: `POST /api/data/query` with `{ table, operation, columns, values, filters, order, limit, range, cardinality, options }`. Tables and columns are allowlisted; user/community ownership is always added server-side.
- RPC: `POST /api/rpc/:name` with the existing RPC argument object.
- Functions: `POST /api/functions/:name` for login/reset/verification mail, user administration, scanners, KLIPY, Daily, and related workflows.
- Storage: multipart `POST /api/storage/upload`; `POST /signed-url`, `/signed-urls`, `/remove`; public and signed-private download paths.
- Health: `/healthz` is liveness; `/readyz` verifies MySQL and performs a create/read/delete probe in `STORAGE_ROOT`.

Refresh tokens rotate in an HTTP-only cookie. The checked configuration keeps a
signed-in browser for up to one year while continuing to rotate the token on
use. A ten-second, same-browser grace window returns the already-issued
successor during parallel tab refreshes; reuse outside that narrowly bound
window revokes the whole token family. Google OAuth state is additionally bound
to the initiating browser by a short-lived, host-only HTTP-only nonce cookie.
Token exchange and ID-token verification share a retry-disabled 20-second
provider deadline. The state is atomically claimed before the one-use Google
code leaves the server, preventing parallel callback races; any provider
failure clears the nonce and requires a fresh Google sign-in. Access JWTs are
short-lived. OTPs, OAuth callback codes, password reset tokens, and refresh
tokens are stored only as hashes. CORS uses an exact origin allowlist. Upload
buckets constrain path ownership, MIME type, and size.

Password-reset links are never exchanged for a login session on page load. The frontend holds the one-time token only long enough to submit `{ token, password }` to `POST /api/auth/password-reset/complete`; the API atomically claims the token, updates the password, and revokes existing refresh sessions.

Email, institute-email, and local development phone codes reserve each attempt with a conditional database update. The verified action atomically claims the still-unused code before changing identity or creating a session, so concurrent verification requests cannot reuse one challenge.

Connection requests are created only through the RPC workflow. It serializes each member pair, enforces 50 sent invitations per rolling week, at most 100 pending sent invitations, and a 21-day retry cooldown after a declined or withdrawn request. Accept, decline, and withdraw transitions conditionally update only a still-pending row in the same transaction as their notification change. Forum slow-mode settings are also enforced during server-side post creation; a member-row lock prevents parallel requests from bypassing the configured interval.

## Realtime

In production, browsers authenticate AppSync Events with their short-lived
access JWT. A minimal Lambda authorizer calls this API to verify every requested
forum, thread, chat, or inbox channel. Typing/presence remains on the revocable
Socket.IO path; browsers never receive the server publisher token and cannot
publish raw database envelopes. Node records content-free row-ID invalidations in a
MySQL-backed retry outbox and publishes them to the AppSync HTTP endpoint.
Clients refetch changed rows through this API, so current account/scope/room
authorization is checked before durable content reaches the UI. MySQL remains
authoritative, and the clients reconcile missed events through cursor reads.

Socket.IO is retained as the local and outage fallback. It authenticates the
same access token and subscribes with `realtime:subscribe` plus
`{ channel, bindings }`. The server verifies profile, forum-scope, or chat-room
membership before joining a room and limits each socket to 50 subscriptions.
Client relay accepts only rate-limited, identity-derived typing/presence—not
arbitrary database events.

## Supabase import

No live Supabase migration runs automatically. Export and validate data first, retain an immutable backup, and rehearse on staging. The provided script only imports tables intentionally retained in `LegacyRecord`:

```sh
pnpm exec tsx server/src/scripts/import-supabase.ts --file=/absolute/export.json
pnpm exec tsx server/src/scripts/import-supabase.ts --file=/absolute/export.json --apply
```

The JSON shape is `{ "tables": { "education": [{ "id": "existing-uuid", ... }] } }`. It refuses missing IDs and never manufactures replacements, so source UUIDs remain stable. Typed core tables and authentication identities require a reviewed ETL mapping; Supabase password hashes and active sessions are not portable and users should use password recovery or Google sign-in after cutover.

## Explicit current limitations

- Object bytes use hardened local filesystem storage under `STORAGE_ROOT`. The routes and metadata model are ready for a provider adapter, but AWS S3 upload/signing is not implemented in this service yet.
- Production SMS/Fast2SMS is not enabled; only an allowlisted, non-production phone OTP path exists. Email OTP and recovery use ZeptoMail.
- OpenAI and Gemini extract only evidence grounded in supplied, SSRF-checked HTTPS documents. Grounded OpenAI discovery is enabled only for a reviewed web-search-capable configured model; unsupported configurations report `openai_web_discovery: false` instead of generating unverified listings.
- AI scans have a 50-second end-to-end ceiling: source retrieval is capped at 12 seconds, provider calls at 30 seconds with retries disabled, and all item/run/audit writes commit in one bounded transaction. A timeout imports nothing and returns an explicit `504` before Nginx's request ceiling.
- `LegacyRecord` exists for UI compatibility, not as the long-term domain model. Chat membership, inbox, message-history, and exact scalar compatibility filters are scoped in MySQL rather than sampled from a global row window. Queries requiring flexible JSON sorting or non-exact predicates may still materialize their matching logical table in the API process; promote every high-volume compatibility table to an indexed typed Prisma model before large-scale traffic.
- Background source scanning needs an external scheduler (for example EventBridge or cron). The API process itself runs expired-auth cleanup and reconciles verified graduates to alumni at startup and at each midnight in India Standard Time.

Run `pnpm typecheck:api`, `pnpm test:server`, `pnpm db:validate`, and `pnpm build:api` before deployment.
