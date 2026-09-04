# Cirkle deployment runbook

This runbook deploys the React/Vite frontend to Cloudflare Pages and the Node
API to one Linux host behind Nginx and PM2. MySQL 8.4 is private to the API
host. Commands assume the production domains below:

- Canonical frontend: `https://cirkle.world`
- Alternate frontend: `https://www.cirkle.world`
- API and authorized Socket.IO fallback: `https://api.cirkle.world`
- Realtime fan-out: one AWS AppSync Event API in `ap-south-1`

The `api.cirkle.world` record must be **DNS-only (grey cloud)** in Cloudflare.
The production API deliberately trusts exactly one proxy hop: Nginx.

Change all domain-specific configuration together if these names change. Do
not deploy a partially changed set.

## Request path

```text
Browser -> Cloudflare Pages (React dist/)
        <-> AWS AppSync Events (realtime transport only)
        -> api.cirkle.world (HTTPS)
        -> Nginx
        -> 127.0.0.1:3001 (one PM2 Node process)
        -> MySQL 8.4 on 127.0.0.1:3306

Node API -> AppSync HTTP publish endpoint
AppSync Lambda authorizer -> Node API channel authorization endpoint
```

AWS hosts only AppSync and its minimal Lambda authorizer—not the frontend, API,
database, uploads, or background jobs. MySQL is durable truth; AppSync is
low-latency delivery. Socket.IO at `/api/socket.io` remains the local/outage
fallback. The PM2 count stays at one because that fallback keeps subscriptions
in process memory; do not add API workers until a shared fallback adapter and
sticky-session plan are tested.

## Release gates

Never cut production over unless all of these are true:

1. The existing Supabase database and object storage have independent,
   restorable backups.
2. A migration rehearsal has preserved user UUIDs, identity provider subjects,
   ownership, anonymous-author visibility, timestamps, and media references.
3. The repository contains reviewed Prisma migrations under
   `prisma/migrations/`. Production never runs `prisma db push`.
4. `pnpm verify` succeeds on the exact commit being released.
5. Email/password, email OTP, password reset, Google login, uploads, core data
   writes, AppSync authorization/delivery/recovery, Socket.IO fallback, and
   owner/admin access have passed staging tests.
6. A rollback-compatible release and a fresh MySQL backup are available.

MySQL DDL can be non-transactional. Every schema migration must be backward
compatible with the immediately previous application release. The automated
rollback changes application code only; it never guesses how to reverse data.

## Local development

Requirements are Node.js 22, pnpm 11, and Docker with Compose:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d mysql
docker compose ps
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

Local endpoints:

- Frontend: `http://localhost:8080`
- API liveness: `http://localhost:3001/healthz`
- API/database/storage readiness: `http://localhost:3001/readyz`

Vite proxies `/api`, including `/api/socket.io`, to port 3001. Keep
`VITE_API_URL` empty locally so browser requests stay same-origin. Use
`docker compose down` to stop MySQL; do not add `--volumes` unless permanent
deletion of the local database is genuinely intended.

## Production secrets

Secrets belong on the API host, never in Cloudflare Pages variables or Git.
Before these commands, install Docker Engine with its Compose plugin as well
as Node.js 22, pnpm 11, PM2, Nginx, logrotate, a MySQL 8.4 client, `git`,
`curl`, `tar`, `gzip`, and `flock`. Verify `docker compose version` succeeds.

Create a dedicated service account and protected directories, then clone the
reviewed repository into a service-owned source directory. The remaining
relative paths in this runbook assume the shell is in that checkout:

```sh
sudo useradd --system --user-group --create-home --shell /bin/bash cirkle
# The top-level directory is traversable so the administrator can inspect the
# non-secret source checkout; releases, uploads, and logs remain mode 0750.
sudo install -d -o cirkle -g cirkle -m 0755 /srv/cirkle
sudo install -d -o cirkle -g cirkle -m 0750 /srv/cirkle/releases
sudo install -d -o cirkle -g cirkle -m 0750 /srv/cirkle/shared
sudo install -d -o cirkle -g cirkle -m 0750 /srv/cirkle/shared/storage
sudo install -d -o cirkle -g cirkle -m 0750 /srv/cirkle/shared/logs
sudo install -d -o cirkle -g cirkle -m 0750 /var/backups/cirkle/mysql
sudo -H -u cirkle git clone https://github.com/sunandgarg/cirkle-react.git /srv/cirkle/source
cd /srv/cirkle/source
sudo install -d -o root -g cirkle -m 0750 /etc/cirkle
sudo install -o root -g cirkle -m 0640 .env.production.example /etc/cirkle/api.env
sudo install -o root -g cirkle -m 0640 deploy/backup.env.example /etc/cirkle/backup.env
sudo install -o root -g root -m 0600 deploy/mysql.env.example /etc/cirkle/mysql.env
sudoedit /etc/cirkle/api.env
sudoedit /etc/cirkle/backup.env
sudoedit /etc/cirkle/mysql.env
```

`/etc/cirkle/api.env` contains only Node runtime values;
`/etc/cirkle/backup.env` contains only a least-privilege dump account; and
root-only `/etc/cirkle/mysql.env` contains Docker bootstrap credentials,
including the MySQL root password. The first two remain root-owned and
group-readable by `cirkle`; the MySQL file must remain root:root mode 0600.
All are sourced by trusted scripts, so quote shell metacharacters.

Generate independent high-entropy values for every JWT, hashing, pepper,
storage, AppSync authorizer, and AppSync publisher secret. Do not reuse
database, Google, ZeptoMail, OpenAI, Gemini, or AppSync credentials. A password
inside `DATABASE_URL` must be URL-encoded.

Production-critical values include:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
TRUST_PROXY_HOPS=1
CORS_ORIGINS=https://cirkle.world,https://www.cirkle.world
APP_BASE_URL=https://api.cirkle.world
FRONTEND_URL=https://cirkle.world
COOKIE_SECURE=true
MOBILE_TEST_MODE=false
ENABLE_SEED_DATA=false
GOOGLE_REDIRECT_URI=https://api.cirkle.world/api/auth/google/callback
APPSYNC_ENABLED=true
APPSYNC_HTTP_ENDPOINT=https://API_ID.appsync-api.ap-south-1.amazonaws.com/event
```

Leave `COOKIE_DOMAIN` unset. That creates a narrower, host-only refresh cookie
for `api.cirkle.world`. The cookie is `Secure`, `HttpOnly`, and scoped by the
API to `/api/auth`.

The deploy script refuses placeholders and requires the Google, ZeptoMail,
OpenAI, Gemini, KLIPY, and Daily credentials. This is deliberate: a release
must not appear healthy while a visible production integration is silently
absent.

### External provider setup

- Google Cloud: register exactly
  `https://api.cirkle.world/api/auth/google/callback` as an authorized redirect
  URI. Use `https://cirkle.world` as the application origin and consent-screen
  home page.
- Zoho ZeptoMail: verify `cirkle.world` and `noreply@cirkle.world`, configure its
  current SPF/DKIM records and bounce subdomain, publish a DMARC policy, and use
  a rotated server-side Send Mail API key. The current India Agent requires
  `ZEPTOMAIL_API_URL=https://api.zeptomail.in/v1.1/email`; SMTP credentials are
  not used by the Node service. A successful send response proves provider
  acceptance only. ZeptoMail delivery/bounce webhooks are not yet persisted by
  this application, so inspect processed-email logs during acceptance testing.
- OpenAI and Gemini: use separate restricted production keys with billing and
  usage alerts. These keys are server-only; no key name may start with `VITE_`.
- KLIPY: use a production API key and verify search, trending, and share
  attribution behavior with a normal member account.
- Daily: use a production API key. `DAILY_DOMAIN` is optional and should contain
  only the assigned room hostname (for example, `your-team.daily.co`) when a
  fallback URL is needed.
- AWS AppSync Events: activate the AWS account, deploy only
  `aws/realtime/template.yaml` in `ap-south-1`, and copy its endpoints to the
  API/Pages settings exactly as documented in `aws/realtime/README.md`. Keep
  `APPSYNC_PUBLISH_TOKEN` and `APPSYNC_AUTHORIZER_SECRET` only in the protected
  API environment; they are never `VITE_` values. The Node host requires no AWS
  access key for runtime publishing.

Provider dashboards and DNS records change independently of this repository.
Verify them directly before launch and after any credential rotation.

## MySQL 8.4

For a single-host launch, start the MySQL 8.4 LTS major series through Compose while
keeping its port bound to loopback:

```sh
sudo docker compose --env-file /etc/cirkle/mysql.env up -d mysql
sudo docker compose --env-file /etc/cirkle/mysql.env ps
```

The named `cirkle_mysql_data` volume survives normal container replacement.
Changing `MYSQL_USER`, `MYSQL_PASSWORD`, or `MYSQL_ROOT_PASSWORD` after the
volume is initialized does not rotate existing database credentials.

Create a least-privilege backup account. On MySQL 8.4, the dump options in the
repository need read access to tables, views, and triggers:

```sql
CREATE USER 'cirkle_backup'@'%' IDENTIFIED BY 'a-separate-long-random-password';
GRANT SELECT, SHOW VIEW, TRIGGER ON cirkle.* TO 'cirkle_backup'@'%';
```

The current Prisma schema defines no stored routines or MySQL events, so the
backup deliberately does not request them. If either is introduced later, add
the corresponding dump flags and global privileges in the same reviewed change.

Put that account only in the `MYSQL_BACKUP_*` settings. Test a backup before
the first release:

```sh
sudo -H -u cirkle CIRKLE_ENV_FILE=/etc/cirkle/backup.env bash deploy/scripts/backup-mysql.sh
```

Each successful dump is written atomically, gzip-tested, and accompanied by a
SHA-256 file. A failed or unverified backup stops deployment. Set
`MYSQL_BACKUP_RETENTION_DAYS=0` to disable automatic expiry. When retention is
positive, the script prints every expired file it removes.

Copy backups to encrypted off-host storage and perform recurring restore drills
on an isolated non-production MySQL instance or container. The dump contains a
`CREATE DATABASE`/`USE` statement for the production database name, so an empty
schema on the production server is not a safe restore target. Never test a
restore against the live MySQL instance and never treat a Docker volume as the
only backup.

## API host, TLS, and Nginx

The host prerequisites, including Docker Engine and the Compose plugin, were
installed and verified before the checkout above. Point the `api.cirkle.world`
DNS record at this host as a Cloudflare **DNS-only (grey-cloud)** record. Nginx
is the sole proxy between public clients and Node, matching
`TRUST_PROXY_HOPS=1`.

Nginx expects these files:

```text
/etc/cirkle/tls/fullchain.pem
/etc/cirkle/tls/privkey.pem
```

Install a publicly trusted certificate. A Cloudflare Origin CA certificate is
not valid for this DNS-only API origin. For Let's Encrypt HTTP validation,
obtain the first certificate before enabling the TLS site, then point the two
paths above at the managed certificate. The port 80 server already exposes
`/.well-known/acme-challenge/` from `/var/www/certbot` for renewal. Test the
configured renewal method; do not assume it works.

Protect the private key and enable the site:

```sh
sudo install -d -o root -g root -m 0755 /etc/cirkle/tls /var/www/certbot
sudo chmod 0600 /etc/cirkle/tls/privkey.pem
sudo install -o root -g root -m 0644 deploy/nginx/cirkle.conf /etc/nginx/sites-available/cirkle.conf
sudo install -o root -g root -m 0644 deploy/logrotate/cirkle /etc/logrotate.d/cirkle
sudo ln -s /etc/nginx/sites-available/cirkle.conf /etc/nginx/sites-enabled/cirkle.conf
sudo nginx -t
sudo logrotate --debug /etc/logrotate.d/cirkle
sudo systemctl enable --now logrotate.timer
sudo systemctl status logrotate.timer
sudo systemctl reload nginx
```

If the enabled-site symlink already exists, inspect it instead of overwriting
it. Permit public inbound TCP 80/443 only; never expose ports 3001 or 3306.
Restrict SSH. Because the API is DNS-only, public clients must reach Nginx on
HTTPS directly; ports 3001 and 3306 remain loopback-only.

Nginx overwrites inbound `X-Forwarded-For` with `$remote_addr`, preventing a
caller from injecting a trusted proxy chain. Its dedicated access-log format
uses `$uri` (pathname) and never `$request`, `$request_uri`, `$args`, or the
referrer, so OAuth codes and signed-storage query credentials are not written
to access logs. Nginx error logging is critical-only because upstream errors can
embed a full request line; sanitized application errors remain available in
PM2. `/readyz` is loopback-only because it exercises MySQL and storage, while
the cheap `/healthz` liveness endpoint may remain public.

Nginx does not emit `Access-Control-Allow-Origin`. Node owns CORS so there is
exactly one credential-aware policy. Adding a second CORS layer can create
duplicate headers and break refresh cookies.

## Deploy the API

The deployment helper exports the current committed `HEAD`; it never copies
working-tree edits, `.env`, or `.env.production`. It then installs locked
dependencies, validates and generates Prisma, builds the server, runs server
tests, creates a verified database backup, applies committed migrations,
atomically switches `/srv/cirkle/current`, reloads PM2, and waits for database
readiness. A failed readiness check restores the prior application release.

Update the service-owned checkout and deploy from it. Run Git and the release
script as `cirkle`; an administrator account must not write files into this
checkout under its own ownership:

```sh
sudo -H -u cirkle git -C /srv/cirkle/source fetch --prune origin
sudo -H -u cirkle git -C /srv/cirkle/source switch main
sudo -H -u cirkle git -C /srv/cirkle/source pull --ff-only origin main
sudo -H -u cirkle bash -lc 'cd /srv/cirkle/source && CIRKLE_ENV_FILE=/etc/cirkle/api.env CIRKLE_OPS_ENV_FILE=/etc/cirkle/backup.env bash deploy/scripts/deploy-backend.sh'
```

Do not set `CIRKLE_RUN_SERVER_TESTS=false` for a normal production release. It
exists only for a documented incident response when the exact tests have
already passed on the same commit.

After the first healthy release, configure PM2 resurrection while logged in as
the `cirkle` user:

```sh
pm2 status
pm2 save
pm2 startup
```

Run the exact privileged command printed by `pm2 startup`, then verify a reboot
in a maintenance window. PM2 loads secrets directly from
`/etc/cirkle/api.env` through Node's `--env-file` support; no secret is copied
into a release. PM2 writes to `/srv/cirkle/shared/logs`; the installed logrotate
policy rotates daily or at 25 MiB, retains 14 compressed rotations, and prevents
unbounded growth. Monitor disk usage and alert well before capacity.

Old releases are intentionally not deleted automatically. Remove them only
after backup verification, rollback-window expiry, and disk-space review.

To create the first owner, stop the API, temporarily expose the bootstrap file
only to the dedicated service group, run all repository code as `cirkle`, then
delete the file before restarting:

```sh
(
set -Eeuo pipefail
sudo -H -u cirkle pm2 stop cirkle-api
bootstrap_file=/etc/cirkle/bootstrap.env
sudo install -o root -g cirkle -m 0640 deploy/bootstrap.env.example "${bootstrap_file}"
trap 'sudo rm -f -- "${bootstrap_file}"' EXIT
sudoedit "${bootstrap_file}"
sudo -H -u cirkle CIRKLE_ENV_FILE=/etc/cirkle/api.env CIRKLE_BOOTSTRAP_ENV_FILE="${bootstrap_file}" bash /srv/cirkle/current/deploy/scripts/seed-owner.sh
sudo rm -- "${bootstrap_file}"
trap - EXIT
sudo -H -u cirkle CIRKLE_ENV_FILE=/etc/cirkle/api.env CIRKLE_LOG_DIR=/srv/cirkle/shared/logs pm2 startOrReload /srv/cirkle/current/ecosystem.config.cjs --env production --update-env
)
```

No service process runs while the temporary seed password is group-readable,
and no service-user-writable release file is ever executed as root. The script
exports only `DATABASE_URL` and seed fields to Prisma.

### Roll back application code

By default the rollback helper selects `/srv/cirkle/previous`. An explicit
target must be a release basename from `/srv/cirkle/releases`:

```sh
sudo -H -u cirkle CIRKLE_ENV_FILE=/etc/cirkle/api.env bash deploy/scripts/rollback-backend.sh
sudo -H -u cirkle CIRKLE_ENV_FILE=/etc/cirkle/api.env bash deploy/scripts/rollback-backend.sh 20260904T120000Z-abcdef123456
```

The helper atomically switches the symlink, reloads PM2, checks `/readyz`, and
restores the current release if the rollback target fails. It does not reverse
MySQL migrations. A database restore is a separate, destructive incident
procedure requiring an outage, an independently verified backup, and explicit
operator approval.

## Cloudflare Pages

Use the separate Pages project named `cirkle-world`; its production URL is
`https://cirkle-world.pages.dev`. The legacy `cirkle` project and its domains
must remain untouched until the API and data cutover is complete. Use:

```text
Production branch: pages-production
Build command: pnpm build:pages
Build output directory: dist
Root directory: repository root
Node version: 22
PNPM_VERSION: 11.19.0
```

Set only these public build variables unless another reviewed frontend value is
needed:

```dotenv
VITE_API_URL=https://api.cirkle.world
VITE_CHAT_REALTIME_PROVIDER=appsync
VITE_APPSYNC_HTTP_ENDPOINT=https://API_ID.appsync-api.ap-south-1.amazonaws.com/event
VITE_APPSYNC_REALTIME_ENDPOINT=wss://API_ID.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime
VITE_DAILY_CALLS_ENABLED=true
PNPM_VERSION=11.19.0
```

Never add `DATABASE_URL`, JWT secrets, Google client secret, ZeptoMail token,
OpenAI/Gemini keys, AppSync publisher/authorizer secrets, or the storage signing
secret to Pages. AppSync endpoints are public identifiers and are safe there;
the browser authenticates them with its short-lived Cirkle access JWT. Vite
embeds every `VITE_` value in downloadable browser JavaScript.

Connect both `cirkle.world` and `www.cirkle.world` as Pages custom domains and
choose the apex as canonical. Do not configure `main` as the Pages production
branch: the API migration and healthy backend must land before its matching UI.

In the Cloudflare dashboard, give `www.cirkle.world` a proxied DNS record, then
create an account-level Bulk Redirect list entry with source
`www.cirkle.world` and target `https://cirkle.world`. Enable **Subpath
matching**, **Preserve path suffix**, and **Preserve query string**; leave
**Include subdomains** off unless that broader redirect is intentional. Bulk
Redirects are static and do not accept `${path}` replacement expressions. Test
a nested path and OAuth return parameter. Adding both Pages custom domains
alone does not create this canonical redirect. Follow Cloudflare's [Bulk
Redirect guide](https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/create-dashboard/).

For each release, require green CI on the exact commit, deploy that commit to
the API host first, and wait for `/readyz`. Only then fast-forward the protected
`pages-production` branch to the same commit (or perform the direct upload below
from that exact checkout). This ordering is safe during the migration because
the old frontend continues using the untouched legacy production service until
the new Node API is healthy. Future API changes must remain backward-compatible
for at least one frontend release.

Direct-upload releases use the same checked-in configuration. The command
refuses tracked, staged, or untracked project changes, prints the exact Git
revision, validates the production build variables, and explicitly targets the
Pages production branch:

```sh
VITE_API_URL=https://api.cirkle.world \
VITE_CHAT_REALTIME_PROVIDER=appsync \
VITE_APPSYNC_HTTP_ENDPOINT=https://API_ID.appsync-api.ap-south-1.amazonaws.com/event \
VITE_APPSYNC_REALTIME_ENDPOINT=wss://API_ID.appsync-realtime-api.ap-south-1.amazonaws.com/event/realtime \
VITE_DAILY_CALLS_ENABLED=true pnpm pages:deploy
```

If frontend publication fails, leave the healthy backward-compatible API in
place and redeploy the prior Pages commit. Never publish a frontend that expects
an API migration which has not passed readiness.

Cloudflare Pages supplies its native SPA fallback because this build contains
root `index.html` and no root `404.html`. `public/_redirects` records why no
catch-all rewrite is present: current Pages rejects `/* /index.html 200` as an
infinite loop. `public/_headers` supplies static security and cache headers.
Vite copies both files into `dist` during the build. See Cloudflare's current
[Serving Pages documentation](https://developers.cloudflare.com/pages/configuration/serving-pages/)
for this fallback behavior.

Pages preview origins are not accepted by production CORS by default. If a
preview must use the production API, add that exact HTTPS origin temporarily
to `CORS_ORIGINS`; never use `*` with credentialed requests. A separate staging
API and database is safer.

## Browser policy

Production CORS must contain the two explicit origins:

```text
https://cirkle.world
https://www.cirkle.world
```

Additional origins, if any, must be explicit HTTPS origins with no path and no
wildcard. The Pages CSP permits:

- API/fallback traffic only to `https://api.cirkle.world` and
  `wss://api.cirkle.world`.
- AppSync Event API traffic only to the `ap-south-1` HTTPS and realtime AWS
  domains emitted by the reviewed stack.
- Daily call connections/frames only on `*.daily.co`.
- HTTPS images and media because user avatars, posts, GIFs, company logos, and
  call media can have externally hosted URLs.
- Local/data fonts, local/blob workers, and inline styles used by the current
  React component stack.

Legacy Supabase origins are intentionally absent. Tightening the
broad HTTPS image/media allowance requires first proxying or migrating all
external user content; doing it prematurely would visibly break existing
posts and profiles.

## Production verification

Check the service path from both the host and the public network:

```sh
curl --fail --show-error http://127.0.0.1:3001/healthz
curl --fail --show-error http://127.0.0.1:3001/readyz
curl --fail --show-error https://api.cirkle.world/healthz
test "$(curl --silent --output /dev/null --write-out '%{http_code}' https://api.cirkle.world/readyz)" = 403
curl --fail --show-error 'https://api.cirkle.world/api/socket.io/?EIO=4&transport=polling'
pm2 status
pm2 logs cirkle-api --lines 100
sudo nginx -t
```

Verify allowed and rejected CORS behavior. The first request should return the
exact allowed origin and credentials header; the second must not:

```sh
curl -i -X OPTIONS https://api.cirkle.world/api/auth/me \
  -H 'Origin: https://cirkle.world' \
  -H 'Access-Control-Request-Method: GET'

curl -i -X OPTIONS https://api.cirkle.world/api/auth/me \
  -H 'Origin: https://attacker.example' \
  -H 'Access-Control-Request-Method: GET'
```

Complete a real-browser acceptance pass on desktop and mobile:

1. Open a deep link directly and refresh it to verify the SPA fallback.
2. Register with email/password, receive a ZeptoMail message, verify the OTP,
   log out, log in, refresh the page, and reset the password.
3. Complete Google login and confirm the callback returns only to the allowed
   frontend origin.
4. Create, update, and delete test content; verify permissions with a second
   non-admin account.
5. Send forum and direct messages in two browsers; confirm AppSync denies an
   unauthorized room, reconnects after JWT refresh/network loss, and recovers
   missed MySQL rows. Then force the AppSync endpoint unavailable and verify the
   authorized Socket.IO fallback instead of silent message loss.
6. Upload and retrieve an image, audio attachment, and permitted document near
   (but below) the configured size limit.
7. Exercise the product flows that invoke OpenAI and Gemini and confirm errors
   are surfaced without exposing provider payloads or keys.
8. Start and end an audio/video call and check camera/microphone permission and
   Daily iframe behavior against the deployed CSP.
9. Review API, Nginx, PM2, MySQL, Cloudflare, AppSync/Lambda, ZeptoMail, OpenAI,
   and Gemini logs or dashboards for errors and unexpected cost.

Do not mark the release complete merely because `/healthz` is green. Liveness
proves the Node process is running; loopback-only `/readyz` adds database and
storage readiness; the browser pass proves the integrated product behavior.
