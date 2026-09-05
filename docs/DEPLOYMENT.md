# Cirkle production deployment and apex cutover

This runbook describes the selected production topology and the ordered move of
`cirkle.world` from the retained legacy Pages project to `cirkle-react`.

## Production topology

```text
Browser -> Cloudflare Pages project cirkle-react
           -> https://cirkle.world (canonical after cutover)
           -> https://www.cirkle.world (serves the same canonical-tagged artifact)
           -> https://cirkle-react.cirkle.world (rollback/diagnostic origin)
        -> https://api-react.cirkle.world
           -> Nginx -> one Node 22 systemd service on Lightsail
           -> private Lightsail managed MySQL 8.4
           -> private encrypted/versioned S3

Foreground realtime: authorized Socket.IO at /api/socket.io
Durable truth: MySQL; clients refetch after reconnect
AppSync: disabled
```

The legacy Cloudflare `cirkle` project, its `cirkle.pages.dev` hostname, and the
Supabase source remain intact during the rollback window. A cutover changes
routing; it does not authorize deletion from Supabase, the legacy Pages project,
or AWS.

## Release gates

Do not move a production hostname until all gates are satisfied:

1. `pnpm verify` succeeds on the exact commit selected for both API and Pages.
2. The API release is deployed first and its loopback `/readyz` passes.
3. Public `/healthz`, Socket.IO handshake, CORS, OAuth callback, email, GIF,
   storage, and two-browser forum/chat tests pass on
   `https://cirkle-react.cirkle.world`.
4. The final Supabase export has been applied idempotently and destination UUID,
   ownership, row-count, and S3 object-count parity is recorded.
5. A fresh encrypted database backup exists outside the managed database's
   primary failure boundary and its checksum is valid.
6. The old Pages project, previous `cirkle-react` deployment, and prior API
   release remain available for rollback.

MySQL schema changes must be backward-compatible with the immediately previous
API release. Frontend rollback never reverses database migrations.

## API configuration

The protected API environment is installed on the Lightsail host. Keep all
provider keys, database credentials, JWT secrets, storage signing material, and
OAuth client secrets out of Git and out of every `VITE_*` variable.

The domain-sensitive non-secret contract is:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
TRUST_PROXY_HOPS=1
DATABASE_URL=mysql://cirkle_app:<URL_ENCODED_PASSWORD>@<PRIVATE_DB_HOST>:3306/cirkle?sslcert=%2Fetc%2Fcirkle%2Fmysql-ca.pem&sslaccept=strict&connection_limit=5
CORS_ORIGINS=https://cirkle.world,https://www.cirkle.world,https://cirkle-react.cirkle.world,https://cirkle-react.pages.dev
APP_BASE_URL=https://api-react.cirkle.world
FRONTEND_URL=https://cirkle.world
GOOGLE_REDIRECT_URI=https://api-react.cirkle.world/api/auth/google/callback
COOKIE_SECURE=true
APPSYNC_ENABLED=false
STORAGE_DRIVER=s3
```

Leave `COOKIE_DOMAIN` unset so the refresh cookie remains host-only. Nginx is
the one trusted proxy hop and must replace, not append to, untrusted inbound
forwarded-address headers. `api-react.cirkle.world` remains DNS-only so Nginx
terminates publicly trusted TLS directly.

Provider credentials are optional only when the corresponding product feature
fails closed. The current API has no `DAILY_API_KEY`, so Pages must keep
`VITE_DAILY_CALLS_ENABLED=false`. Calls can be enabled later only when both
conditions are true:

1. The protected API environment contains a valid `DAILY_API_KEY` and
   `GET /api/features` reports `{ "daily_calls": true }`.
2. The reviewed Pages build sets `VITE_DAILY_CALLS_ENABLED=true`.

The UI defaults to disabled if either gate is false, the feature endpoint is
unavailable, or its response is malformed. The endpoint exposes capability
booleans only and never returns provider credentials.

## Managed MySQL TLS and credential split

Production accepts only the private AWS managed-database hostname with verified
TLS. Install the AWS database CA at `/etc/cirkle/mysql-ca.pem`; the file is
public trust material and must be readable by the `cirkle` service account.
Runtime, migration, and backup credentials must be distinct:

- `/etc/cirkle/api.env` uses `cirkle_app`, which has data read/write grants but
  no schema-change grants.
- `/etc/cirkle/migration.env` uses `cirkle_migrate`, is `root:root` mode `0600`,
  and is read only during a release.
- `/etc/cirkle/backup.env` uses read-only `cirkle_backup`, is `root:root` mode
  `0600`, and is read only by the backup service.

All Prisma URLs require `sslcert=%2Fetc%2Fcirkle%2Fmysql-ca.pem` and
`sslaccept=strict`. URL-encode passwords. Do not put the master or migration
credential in the runtime file, and do not store provider or database secrets
in MySQL.

Use this live rollout order; changing it can break backups or the running API:

1. Preserve the current API environment and release for rollback. Install and
   inspect the AWS CA bundle, then confirm the `cirkle` account can read it.
2. Create four protected password files: existing master plus newly generated,
   independent runtime, migration, and backup values. Keep every file mode
   `0600`; `openssl rand -hex 32` produces a compatible new value.
3. Copy `aws/hosting/database-provision.env.example` outside the checkout,
   replace only its host/user/file-path placeholders, protect it mode `0600`,
   export its values, and run `setup-lightsail-db.sh` as root. The script stops
   unless every account negotiates a non-empty TLS cipher.
4. Build `/root/cirkle-managed-backup.env` from
   `managed-backup.env.example`, then run:

   ```sh
   sudo env BACKUP_ENV_FILE=/root/cirkle-managed-backup.env \
     ./aws/hosting/install-managed-backup.sh
   ```

   Installation must finish a real dump and verify its encrypted S3 object and
   SHA-256 metadata. Do not continue after a failed backup.
5. Install the real migration file from `migration.env.example` as
   `/etc/cirkle/migration.env` with owner `root:root` and mode `0600`. Prepare a
   root-only candidate API environment using only `cirkle_app`.
6. Run the release helper with the reviewed archive, candidate API environment,
   and migration environment:

   ```sh
   sudo ./aws/hosting/deploy-lightsail-release.sh \
     /tmp/cirkle-react-source.tar.gz \
     /root/cirkle-react-api.env \
     /etc/cirkle/migration.env
   ```

   It requires another verified backup, applies migrations with
   `cirkle_migrate`, validates database and storage with staged `cirkle_app`,
   atomically switches code and configuration, and restores both on a failed
   readiness check.
7. Run the host and public checks below, inspect grants and TLS-session status,
   then complete the two-browser acceptance suite. Retain the old broad
   database user throughout the rollback window; disabling it is a later,
   explicitly approved decommission step.
8. After every active and rollback client has a strict-TLS URL, enable the
   managed database's global backstop:

   ```sh
   aws lightsail update-relational-database-parameters \
     --region ap-south-1 \
     --relational-database-name cirkle-react-mysql \
     --parameters parameterName=require_secure_transport,parameterValue=1,applyMethod=pending-reboot
   aws lightsail reboot-relational-database \
     --region ap-south-1 \
     --relational-database-name cirkle-react-mysql
   ```

   `REQUIRE SSL` on the three users is effective immediately and needs no
   reboot. The Lightsail `require_secure_transport` parameter is explicitly
   `pending-reboot`, so enabling it does require a controlled database restart
   and a brief API outage. Wait for database state `available`, then require
   `SELECT @@GLOBAL.require_secure_transport` to return `1`, a non-empty
   `Ssl_cipher` for all three identities, `/readyz`, a fresh backup, and the
   browser write/reconnect checks before apex cutover.

The following verification reads passwords from protected files and never puts
them on the command line or prints them:

```sh
sudo bash <<'VERIFY_DATABASE_TLS'
set -Eeuo pipefail
host=ls-54013416ec518334a0e5cfd04c3ff56124885af1.c9k2y2q446df.ap-south-1.rds.amazonaws.com
ca=/etc/cirkle/mysql-ca.pem
accounts=(
  "cirkle_app:/root/cirkle-db-app.password"
  "cirkle_migrate:/root/cirkle-db-migration.password"
  "cirkle_backup:/root/cirkle-db-backup.password"
)
for account in "${accounts[@]}"; do
  user="${account%%:*}"
  password_file="${account#*:}"
  result="$(MYSQL_PWD="$(<"${password_file}")" mysql --no-defaults \
    --protocol=tcp --host="${host}" --port=3306 --user="${user}" \
    --database=cirkle --ssl --ssl-ca="${ca}" --ssl-verify-server-cert \
    --batch --skip-column-names \
    --execute="SELECT CURRENT_USER(); SHOW SESSION STATUS LIKE 'Ssl_cipher';")"
  cipher="$(awk '$1 == "Ssl_cipher" { print $2 }' <<<"${result}")"
  [[ -n "${cipher}" ]] || { echo "${user}: TLS verification failed" >&2; exit 1; }
  echo "${user}: verified TLS (${cipher})"
done
global_setting="$(MYSQL_PWD="$(</root/cirkle-db-app.password)" mysql --no-defaults \
  --protocol=tcp --host="${host}" --port=3306 --user=cirkle_app \
  --database=cirkle --ssl --ssl-ca="${ca}" --ssl-verify-server-cert \
  --batch --skip-column-names --execute="SELECT @@GLOBAL.require_secure_transport;")"
[[ "${global_setting}" == "1" ]] || { echo "Global secure transport is not active" >&2; exit 1; }
VERIFY_DATABASE_TLS
```

## API release

Use the immutable Lightsail release helper in
`aws/hosting/deploy-lightsail-release.sh`. It installs locked dependencies,
validates and generates Prisma, builds the API, applies committed migrations,
checks database/storage readiness, atomically switches `/srv/cirkle/current`,
and restores the previous release if readiness fails.

Before activation:

```sh
pnpm install --frozen-lockfile
pnpm db:validate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Take and verify the managed-MySQL backup before migrations. Do not use
`prisma db push` against production. Do not put a plaintext export or protected
environment file in a source archive.

After activation, verify on the host:

```sh
curl --fail --show-error http://127.0.0.1:3001/healthz
curl --fail --show-error http://127.0.0.1:3001/readyz
sudo systemctl is-active cirkle-api
sudo journalctl -u cirkle-api --no-pager -n 100
sudo nginx -t
```

Then verify from the public network:

```sh
curl --fail --show-error https://api-react.cirkle.world/healthz
curl --fail --show-error 'https://api-react.cirkle.world/api/socket.io/?EIO=4&transport=polling'
curl --fail --show-error https://api-react.cirkle.world/api/features
```

`/readyz` is intentionally restricted at Nginx and should not be treated as a
public endpoint.

## Cloudflare Pages configuration

Use the existing `cirkle-react` project in Sunand's Cloudflare account:

```text
Project: cirkle-react
Default production URL: https://cirkle-react.pages.dev
Production branch: main
Build command: pnpm build:pages
Build output directory: dist
Root directory: repository root
Node version: 22
PNPM_VERSION: 11.19.0
```

The reviewed public build variables for the current release are:

```dotenv
VITE_API_URL=https://api-react.cirkle.world
VITE_CHAT_REALTIME_PROVIDER=socketio
VITE_DAILY_CALLS_ENABLED=false
PNPM_VERSION=11.19.0
```

Leave `VITE_APPSYNC_HTTP_ENDPOINT` and
`VITE_APPSYNC_REALTIME_ENDPOINT` absent. Vite embeds every `VITE_*` value in
downloadable JavaScript, so no secret can use that prefix.

`wrangler.jsonc`, `package.json`, and the Pages dashboard all use the same
project name and `main` production branch. A direct upload from a clean,
committed checkout is:

```sh
VITE_API_URL=https://api-react.cirkle.world \
VITE_CHAT_REALTIME_PROVIDER=socketio \
VITE_DAILY_CALLS_ENABLED=false \
pnpm pages:deploy
```

The command rejects a dirty checkout, unreviewed public variables, the old API
origin, AppSync endpoints, and ambiguous Daily flag values.

## Ordered apex and www rollout

Cloudflare Pages custom-domain ownership and DNS must move together. Do not
point a CNAME at `cirkle-react.pages.dev` while the hostname is still associated
with the legacy Pages project.

1. Confirm the API CORS allowlist contains apex, `www`, rollback subdomain, and
   Pages default origins. Test both accepted origins and an attacker origin.
2. Record the legacy project/deployment and current DNS values for rollback.
3. In the legacy `cirkle` Pages project, remove only the `www.cirkle.world`
   custom-domain association. Do not delete the project or deployment.
4. Add `www.cirkle.world` to `cirkle-react`, wait until Cloudflare reports the
   domain and certificate Active, and verify DNS points to the new Pages
   project.
5. Use `www` as a canary: hard-refresh, open a deep link, complete login and
   refresh, exercise an authenticated API read/write, upload/download media,
   and test two-browser Socket.IO delivery/recovery.
6. Repeat the custom-domain move for `cirkle.world`; wait for Active status and
   rerun the browser suite on the apex.
7. After the apex is proven, configure a Cloudflare redirect from `www` to the
   apex that preserves path and query string. Verify a nested URL with query
   parameters. Until that redirect is active, serving the same release on both
   domains is acceptable but not canonical.

Never remove `cirkle-react.cirkle.world` during rollout. It separates frontend
or API diagnosis from apex DNS and provides a stable acceptance origin.

## CORS checks

Each approved preflight must return its exact origin plus credentials support;
the unapproved origin must be rejected:

```sh
curl -i -X OPTIONS https://api-react.cirkle.world/api/auth/me \
  -H 'Origin: https://cirkle.world' \
  -H 'Access-Control-Request-Method: GET'

curl -i -X OPTIONS https://api-react.cirkle.world/api/auth/me \
  -H 'Origin: https://www.cirkle.world' \
  -H 'Access-Control-Request-Method: GET'

curl -i -X OPTIONS https://api-react.cirkle.world/api/auth/me \
  -H 'Origin: https://attacker.example' \
  -H 'Access-Control-Request-Method: GET'
```

Do not use `*` with credentialed requests. A preview deployment may use the
production API only after its exact HTTPS origin is temporarily allowlisted.

## Rollback

### Frontend/domain rollback

If the canary fails, move `www` back to the legacy `cirkle` Pages project
through the custom-domain UI and wait for DNS/certificate Active status. The
apex remains untouched.

If the apex fails after cutover:

1. Preserve logs and the failing deployment identifier.
2. Reattach the apex to the legacy `cirkle` Pages project through the
   custom-domain workflow; verify DNS and TLS.
3. Reattach or redirect `www` consistently with the restored apex.
4. Keep the AWS API/database/S3 and imported Supabase source unchanged unless a
   separate, explicitly authorized data incident requires action.

A frontend rollback can also redeploy the previous known-good `cirkle-react`
commit when the fault is limited to its newest bundle. Never delete the legacy
project until the rollback window has formally closed.

### API rollback

Atomically switch `/srv/cirkle/current` to the recorded previous release,
restart `cirkle-api`, and require loopback `/readyz` before declaring recovery.
Do not reverse MySQL migrations automatically. A database restore is a separate
destructive incident procedure requiring an outage, an independently verified
backup, and explicit approval.

## Integrated browser acceptance

Test at least these flows on desktop and mobile before declaring completion:

1. Apex, `www`, rollback-domain, deep-link refresh, canonical metadata, CSP,
   and service-worker update behavior.
2. Email/password login, email OTP, password reset, Google OAuth, logout, token
   refresh, and two-tab session recovery.
3. Forum post/comment/reaction/poll and direct-message writes with a second
   non-admin member; denied room access must remain denied.
4. Foreground Socket.IO delivery, immediate disconnect on page hide, and MySQL
   refetch/reconciliation on visibility return.
5. Private/public image, voice, and document upload/download authorization;
   object bytes must remain in S3 rather than MySQL.
6. GIF search and attribution. OpenAI/Gemini/Daily controls must be absent or
   explicitly unavailable while their server providers are unconfigured.
7. API, Nginx, systemd, MySQL, S3, Cloudflare, and provider logs plus alarms,
   backup timer status, and one isolated restore drill.

`/healthz` alone is not a release gate. It proves only that Node is running;
`/readyz` adds database/storage readiness, and the browser suite proves the
integrated product.
