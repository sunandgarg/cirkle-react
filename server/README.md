# Cirkle API

The API is an Express/TypeScript service backed by Prisma and MySQL. It keeps the existing frontend's Supabase-shaped interface while enforcing authorization in the server. The production entry point is `server/dist/index.js`; it binds to `HOST` (default `127.0.0.1`) and `PORT` (default `3001`). Socket.IO uses `/api/socket.io`.

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

- ZeptoMail: `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_API_URL`, `ZEPTOMAIL_FROM_EMAIL`, `ZEPTOMAIL_FROM_NAME`. Use the regional API endpoint assigned to the ZeptoMail account.
- Google OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
- AI extraction: `OPENAI_API_KEY`, `OPENAI_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`.
- GIF and calling: `KLIPY_API_KEY`, `DAILY_API_KEY`, optionally `DAILY_DOMAIN`.
- Local-only phone testing: `MOBILE_TEST_MODE=true` and an explicit comma-separated `MOBILE_TEST_PHONES` allowlist. This path is disabled in production.
- Test data: `ENABLE_SEED_DATA=true`; always disabled in production.

Missing optional provider credentials return an explicit `503`; provider failures return a non-secret `502` response.

## HTTP compatibility API

- Auth: `GET|POST /api/auth/session`, `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/otp`, `POST /api/auth/verify-otp`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `PUT /api/auth/user`, `GET /api/auth/google`, `GET /api/auth/google/callback`, `POST /api/auth/oauth/exchange`, and `POST /api/auth/recovery/verify`.
- Data: `POST /api/data/query` with `{ table, operation, columns, values, filters, order, limit, range, cardinality, options }`. Tables and columns are allowlisted; user/community ownership is always added server-side.
- RPC: `POST /api/rpc/:name` with the existing RPC argument object.
- Functions: `POST /api/functions/:name` for login/reset/verification mail, user administration, scanners, KLIPY, Daily, and related workflows.
- Storage: multipart `POST /api/storage/upload`; `POST /signed-url`, `/signed-urls`, `/remove`; public and signed-private download paths.
- Health: `/healthz` is liveness; `/readyz` verifies MySQL and performs a create/read/delete probe in `STORAGE_ROOT`.

Refresh tokens rotate in an HTTP-only cookie. A ten-second, same-browser grace window returns the already-issued successor during parallel tab refreshes; reuse outside that narrowly bound window revokes the whole token family. Google OAuth state is additionally bound to the initiating browser by a short-lived, host-only HTTP-only nonce cookie. Token exchange and ID-token verification share a retry-disabled 20-second provider deadline. The state is atomically claimed before the one-use Google code leaves the server, preventing parallel callback races; any provider failure clears the nonce and requires a fresh Google sign-in. Access JWTs are short-lived. OTPs, OAuth callback codes, password reset tokens, and refresh tokens are stored only as hashes. CORS uses an exact origin allowlist. Upload buckets constrain path ownership, MIME type, and size.

Password-reset links are never exchanged for a login session on page load. The frontend holds the one-time token only long enough to submit `{ token, password }` to `POST /api/auth/password-reset/complete`; the API atomically claims the token, updates the password, and revokes existing refresh sessions.

## Realtime

Clients authenticate Socket.IO with an access token and subscribe using `realtime:subscribe` with `{ channel, bindings }`. The server verifies profile, forum-scope, or chat-room membership before joining a room. Changes are sent as Supabase-compatible `postgres_changes` or `broadcast` envelopes on `realtime:event`. Presence uses `realtime:track`.

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
- AI scanners extract from supplied, SSRF-checked HTTPS pages. Ungrounded “discover the web” is deliberately reported as unavailable (`openai_web_discovery: false`) instead of generating unverified listings.
- AI scans have a 50-second end-to-end ceiling: source retrieval is capped at 12 seconds, provider calls at 30 seconds with retries disabled, and all item/run/audit writes commit in one bounded transaction. A timeout imports nothing and returns an explicit `504` before Nginx's request ceiling.
- `LegacyRecord` exists for UI compatibility, not as the long-term domain model. Chat membership, inbox, and message-history reads are scoped in MySQL by member or room and do not use the generic global window. Other generic legacy queries inspect at most 2,000 recent records per logical table; promote any newly high-volume compatibility table to a typed Prisma model before that threshold.
- Background source scanning needs an external scheduler (for example EventBridge or cron); only expired-auth cleanup runs inside the process.

Run `pnpm typecheck:api`, `pnpm test:server`, `pnpm db:validate`, and `pnpm build:api` before deployment.
