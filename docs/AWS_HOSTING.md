# Cirkle React budget AWS hosting

This is the AWS-backed `cirkle-react` deployment selected for the
`cirkle.world` cutover. The existing Supabase project and legacy Cloudflare
Pages project remain intact as rollback sources; the cutover does not delete
either one. AppSync is disabled for this deployment.

## Live topology

```text
Browser
  -> Cloudflare Pages: https://cirkle.world
       (rollout/rollback origin: https://cirkle-react.cirkle.world)
  -> HTTPS API/Socket.IO: https://api-react.cirkle.world
       -> Lightsail instance cirkle-react-api (Mumbai, $7 bundle)
       -> Lightsail managed MySQL 8.4 cirkle-react-mysql (private, $15 bundle)
       -> private encrypted/versioned S3 bucket
```

- The API server is a 1 GiB/2-vCPU Lightsail instance with a static IP, Nginx, Let's Encrypt TLS, Node 22, a memory-bounded systemd service, 2 GiB swap, bounded journald/log rotation, a restrictive firewall, and CPU/status alarms.
- MySQL is the managed Lightsail 1 GiB plan. It is private to the Lightsail network, retains automatic backups, and is not exposed on port 3306. The AWS Lightsail API reports the selected `micro_2_0` database bundle as encrypted; the USD 30 `micro_ha_2_0` tier adds high availability, not the first encrypted tier. Passwords/tokens remain hashed and application/provider secrets are never placed in this database.
- User bytes are stored in the private, AES-256-encrypted, versioned S3 bucket `cirkle-react-media-mediabucket-phet4t6hharr`. S3 public access is blocked.
- Text, relationships, metadata, object paths, hashes, permissions, and audit records live in MySQL. Image/file bytes do not live in MySQL.
- Socket.IO is the realtime transport. AppSync values are absent from the Pages build and API environment, so hidden browser tabs do not accumulate AppSync connection-minute charges.
- Secrets are held in AWS Secrets Manager and installed as root-owned host environment files. Secrets must never be stored in MySQL or exposed through `VITE_*` browser variables.
- Audio/video calls remain hidden while `DAILY_API_KEY` is absent. Even after
  Pages opts in, the UI enables calls only when `GET /api/features` confirms
  that the server-side provider is configured.

## Media flow and immutability

```text
Upload:   Browser -> Node authorization/type/size checks -> private S3
Metadata: Node -> MySQL (key, owner, size, MIME, hash, references/permissions)
Download: Browser -> Node authorization -> short-lived URL or authorized stream
```

The browser compresses ordinary images to WebP and iteratively targets at most 800 KiB before upload. The server still enforces the absolute request/file cap. Published private content uses immutable object keys: a different payload cannot overwrite an existing key, and referenced content cannot be independently deleted while its post, message, story, logo, or verification record remains active.

CloudFront signed URLs and Origin Access Control are implemented in `aws/hosting/cirkle-react-media.yaml` and the API storage service. This AWS account currently returns `403 Your account must be verified before you can add new CloudFront resources`, so the deployed stack uses the safe private-S3/API-streaming fallback. After AWS removes that account hold, update the same stack with `EnableCloudFront=true`, store the private signing key only in the application secret, redeploy the API, and run an authorized/private-media acceptance test. Do not make the bucket public as a workaround.

## Browser activity and recovery

When a Cirkle tab becomes hidden—because the user selects another tab, another browser, or another application—the client immediately closes its Socket.IO/AppSync-compatible realtime connection and reports inactive presence. There is no 30-second grace period. When visible again, it reconnects and invalidates/refetches durable forum/chat/notification state from MySQL, so realtime is an optimization rather than the source of truth.

Operating systems can freeze background processes before JavaScript receives a visibility event. The server heartbeat timeout and reconnect/refetch path remain the authoritative fallback for that unavoidable browser/OS case.

## Managed MySQL identities and transport security

Every database connection verifies the AWS CA and database hostname. Prisma
URLs must contain an absolute `sslcert` path and `sslaccept=strict`; command-line
clients use `--ssl-ca` plus `--ssl-verify-server-cert`. `REQUIRE SSL` on each
account is a server-side backstop, not a replacement for client certificate and
hostname verification.

The credentials are deliberately split:

| Identity | Consumer | Grants on `cirkle.*` |
| --- | --- | --- |
| `cirkle_app` | Long-running Node API | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `cirkle_migrate` | Release-time Prisma migrations only | Runtime grants plus reviewed schema-change grants |
| `cirkle_backup` | Daily logical dump only | `SELECT`, `SHOW VIEW`, `TRIGGER` |

Use independent passwords and the examples in `aws/hosting/`. The API file is
root-owned and group-readable only by `cirkle`; migration and backup files are
root-only mode `0600`. Provisioning rekeys all three identities, so rerunning it
requires an ordered credential rollout. Keep the pre-existing broad database
identity during the rollback window under the instruction not to delete
existing resources; remove or lock it only after the new paths are proven and
explicit decommission approval is given.

## Reproducible resources and deployment

- `aws/hosting/bootstrap-lightsail.sh`: host packages, Node, Nginx, TLS automation, swap, systemd hardening, bounded logs.
- `aws/hosting/setup-lightsail-db.sh`: idempotent TLS-only runtime, migration, and backup identity provisioning with least-privilege grants.
- `aws/hosting/cirkle-react-media.yaml`: retained private S3 media, optional CloudFront OAC/signed delivery, least-privilege media IAM user.
- `aws/hosting/deploy-lightsail-release.sh`: immutable release build, mandatory verified backup, migration-only DDL identity, DB/storage preflight, atomic code/config switch, health wait, and code/config rollback.
- `aws/hosting/backup-managed-mysql.sh` and `install-managed-backup.sh`: daily consistent logical dumps over verified TLS to encrypted S3, including locking, SHA-256 metadata, upload verification, and monitored systemd execution.

Example media-stack update after CloudFront approval:

```bash
aws cloudformation deploy \
  --region ap-south-1 \
  --stack-name cirkle-react-media \
  --template-file aws/hosting/cirkle-react-media.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    BackupBucketName=cirkle-react-deploymentbucket-vs0hxjf6smax \
    EnableCloudFront=true \
    MediaSigningPublicKey="$(cat /protected/path/public.pem)"
```

## Source copy and reconciliation

The original source remains intact. A consistent source MySQL dump was restored into the managed database, copied into the separate encrypted backup bucket, and verified table-by-table. The media copy was verified by object count and total bytes.

Verified destination snapshot:

| Data | Count |
| --- | ---: |
| Users | 35 |
| Profiles | 17 |
| Auth identities | 23 |
| Posts | 106 |
| Connections | 7 |
| Jobs | 40 |
| Events | 126 |
| RSVPs | 2 |
| Legacy records | 338 |
| S3 media objects | 8 (1,368,387 bytes) |

Email/password hashes and active Supabase sessions are not portable through the Supabase Admin API. Any user imported without a portable password must use Cirkle's password-reset flow. Google identities retain their provider subject. Never invent passwords or import active OTP/reset challenges.

## Estimated base monthly cost

The intended low-traffic base is approximately **USD 23.30-23.70/month before tax and usage overages**:

| Service | Configuration | Approx. USD/month |
| --- | --- | ---: |
| Lightsail API | 1 GiB, 2 vCPU, 40 GB SSD, static IP, 1 TB Mumbai transfer | 7.00 |
| Lightsail managed MySQL | 1 GiB, 2 vCPU, 40 GB, encryption and automatic backups; single availability zone | 15.00 |
| Secrets Manager | 3 active Lightsail secrets | 1.20 plus requests |
| S3 | current media and logical backups | 0.10-0.50 initially |
| Cloudflare Pages | frontend | 0.00 on current plan |
| AppSync | disabled | 0.00 |
| CloudFront | blocked pending account verification; normally usage/free-tier dependent | 0.00 currently |

The account currently has five Cirkle secrets: the three active Lightsail
secrets plus retained `cirkle/staging/api` and `cirkle-react/application`, so
Secrets Manager is currently about USD 2/month before requests. The running
legacy EC2 deployment, retained RDS snapshots, and old buckets also make the
AWS invoice temporarily higher than the target table. In particular,
`cirkle-react-deploymentbucket-vs0hxjf6smax` is still the new database-backup
destination even though the older `cirkle-react` CloudFormation stack owns it;
do not delete that stack wholesale. Decommission resources only after explicit
approval, dependency review, and a proven rollback window. Upgrade the API to
the 2 GiB bundle if sustained memory is above 70-75%, swap activity is
persistent, or latency/error alarms trigger.

Current cost/health guardrails are the USD 40/month
`Cirkle-Monthly-Cost` budget (80% forecast and 100% actual notifications) and
three Lightsail alarms: `cirkle-react-api-burst-low`,
`cirkle-react-api-status-failed`, and `cirkle-react-api-cpu-high`. All three
alarms were `OK` at the last audit, but the Lightsail email contact was still
`PendingVerification`; alarms cannot reliably notify anyone until that email is
confirmed. A budget alerts after spend; it is not a hard service limit.

## Remaining production acceptance gates

Completed on 5 September 2026: a fresh ZeptoMail India send token, Google OAuth
client secret, and KLIPY key were stored only in the Lightsail application
secret; the API was restarted through a validated environment preflight. Google
OAuth completed end to end on the live custom domain. ZeptoMail accepted the
live OTP request, but `sunandgarg@cirkle.world` hard-bounced because that mailbox
was not deliverable. KLIPY search works with the new key, which remains in the
provider's TESTING state until its production-review form and product video are
submitted.

1. Create/fix the `sunandgarg@cirkle.world` mailbox (or explicitly choose a valid test recipient), then verify every live email template and delivery outcome.
2. Submit KLIPY's production request with category, monthly-active-user estimate, product video, and required attribution.
3. Ask AWS Support to verify the account for CloudFront, deploy the conditional distribution, then test signed/private/public media behavior and cache headers.
4. Configure and live-test OpenAI, Gemini, and Daily credentials where those features are required.
5. Roll out the three TLS-only database identities in backup, migration, then runtime order; prove a non-empty TLS cipher for each and retain the old broad identity only for the rollback window.
6. Confirm the AWS alert email, allow the API burst balance to recover after release builds, and restore one fresh S3 backup into an isolated MySQL instance before declaring disaster recovery rehearsed.

## Apex cutover and rollback

Before moving a custom domain, the API allowlist must contain
`https://cirkle.world`, `https://www.cirkle.world`,
`https://cirkle-react.cirkle.world`, and `https://cirkle-react.pages.dev`.
Move domains through the Cloudflare Pages custom-domain workflow; changing a
CNAME alone can leave the hostname associated with the wrong Pages project.

Use `www` as the canary first, confirm certificate status and the browser
acceptance suite, then move the apex. After apex is proven, make `www` a
path-and-query-preserving redirect to `https://cirkle.world`. Retain the legacy
`cirkle` Pages project, its default `cirkle.pages.dev` hostname, and the last
known-good `cirkle-react` deployment throughout the rollback window.

For frontend rollback, reattach `www` and then the apex to the legacy Pages
project through its custom-domain workflow and verify DNS/SSL before declaring
recovery. Do not delete or rewrite AWS/Supabase data during a frontend rollback.
The `cirkle-react.cirkle.world` hostname remains available to diagnose the AWS
path independently. See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the ordered gate.
