# Cirkle

Cirkle is a mobile-first, invite-only community network with scoped forums,
member discovery, jobs, events, mentoring, direct chat, moderation, and admin
workflows.

## Stack

- Frontend: React 18, TypeScript, Vite, Tailwind CSS, shadcn/Radix
- API: Node.js, TypeScript, Express
- Database: MySQL with Prisma ORM
- Authentication: short-lived JWT access tokens, rotating refresh sessions,
  Google OpenID Connect, email OTP, and password recovery
- Transactional email: Zoho ZeptoMail
- AI: OpenAI Responses API and the Google Gemini API
- Realtime: AWS AppSync Events in production, with authorized Socket.IO fallback
- Frontend hosting: Cloudflare Pages
- API hosting: Nginx and PM2

The React pages, components, routes, and styling are intentionally preserved.
`src/integrations/supabase/client.ts` is now only a compatibility export for the
new Cirkle API client; it does not initialize or contact Supabase. This keeps the
large existing UI stable while the data/security boundary lives in Node.

The former PostgreSQL migrations and Edge Functions remain under `supabase/` as
a read-only migration reference. They are not part of the running application.

## Local development

Requirements:

- Node.js 22
- pnpm 11
- MySQL 8.4+ (or Docker)

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d mysql
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

The combined development command starts:

- Web app: `http://localhost:8080`
- API: `http://localhost:3001`
- API health: `http://localhost:3001/healthz`
- API readiness: `http://localhost:3001/readyz`

Vite proxies `/api` (including Socket.IO) to the local API, so the browser uses
the same origin in development. Local development defaults to Socket.IO and
does not require AWS.

The seed is opt-in. Set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (12+ chars),
and the optional `SEED_ADMIN_*` profile fields before running `pnpm db:seed`.
Defaults create a complete IIT Delhi/BTech demo identity so the verified owner
never lands in an impossible partial-onboarding state.

## Environment configuration

Copy `.env.example` for the API and local frontend. Never prefix a secret with
`VITE_`; Vite variables are public browser values.

Core values:

- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `FRONTEND_URL`
- `VITE_API_URL` (empty locally; public API origin in production)

External integrations are enabled only when configured:

- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI`
- ZeptoMail: `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_API_URL`,
  `ZEPTOMAIL_FROM_EMAIL`, `ZEPTOMAIL_FROM_NAME` (India REST endpoint;
  `noreply@cirkle.world`; no SMTP runtime)
- OpenAI: `OPENAI_API_KEY`, optionally `OPENAI_MODEL`
- Gemini: `GEMINI_API_KEY`, optionally `GEMINI_MODEL`
- Daily calls: `DAILY_API_KEY`
- GIF search: `KLIPY_API_KEY`
- AppSync Events: `APPSYNC_ENABLED`, `APPSYNC_HTTP_ENDPOINT`,
  `APPSYNC_PUBLISH_TOKEN`, `APPSYNC_AUTHORIZER_SECRET` (the last two are
  server-only secrets)

Production startup rejects placeholder or undersized secrets. Development OTP
responses include a test code for local acceptance tests; production responses
never expose that code.

## Database commands

```sh
pnpm db:generate       # generate Prisma Client
pnpm db:validate       # validate the Prisma schema
pnpm db:push           # synchronize a local/dev database
pnpm db:migrate        # create/apply a migration in local development
pnpm db:migrate:deploy # apply committed migrations in production
pnpm db:seed           # create the explicitly configured owner account
pnpm db:studio         # inspect local data
```

Do not point `db:push` at production. Production releases use reviewed Prisma
migrations, a verified backup, and the rollback procedure in
`docs/DEPLOYMENT.md`.

Existing Supabase user passwords cannot be exported. Preserve user UUIDs and
provider subjects during an approved data import, then require migrated
password users to use the password-reset flow. A production import cannot be
run until an owner-supplied database/storage export is available.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:server
pnpm build
pnpm verify
```

`pnpm verify` is the release gate. It validates Prisma, checks both TypeScript
targets, runs frontend and backend tests, lints the repository, and builds both
artifacts. Database integration and browser tests require a running local MySQL
instance.

## Deployment

Cloudflare Pages settings:

- Project: `cirkle-world` (`https://cirkle-world.pages.dev`)
- Build command: `pnpm build:pages`
- Output directory: `dist`
- Production branch: `pages-production` (advance only after the same commit's API passes `/readyz`)
- Public environment value: `VITE_API_URL=https://api.cirkle.world`
- Public environment value: `VITE_CHAT_REALTIME_PROVIDER=appsync`
- Public environment value: `VITE_APPSYNC_HTTP_ENDPOINT=<stack HTTP output>`
- Public environment value: `VITE_APPSYNC_REALTIME_ENDPOINT=<stack WebSocket output>`
- Public environment value: `VITE_DAILY_CALLS_ENABLED=true`
- Build environment value: `PNPM_VERSION=11.19.0`

The repository also includes `wrangler.jsonc`, SPA redirects, static security
headers, a PM2 ecosystem file, an Nginx site template, MySQL backup helpers, and
an atomic API deployment procedure under `deploy/`.

Never place MySQL, JWT, Google client secret, ZeptoMail, OpenAI, Gemini, or the
AppSync publisher/authorizer secrets in Cloudflare Pages browser variables.
Those belong only on the API server. AWS is used only for the AppSync Event API
and its minimal Lambda authorizer; frontend, API, and database hosting do not
move to AWS. See `aws/realtime/README.md`.

## Safety and migration

- Back up the Supabase database and storage before a production cutover.
- Import into a separate MySQL environment and compare table counts, UUIDs,
  ownership, anonymous-author visibility, and media references.
- Keep the existing production system available until the documented parity
  and browser acceptance checks pass.
- Do not run a live load test against production data.

The code does not silently fall back to Supabase. Missing database, email, AI,
OAuth, storage, or realtime configuration is surfaced through startup checks,
health/readiness responses, API errors, and logs.
