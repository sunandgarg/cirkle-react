# Cirkle React budget AWS hosting

This is the AWS-backed `cirkle-react` production deployment. The apex and
`www` hostnames completed their cutover to the Cloudflare Pages project
`cirkle-react` on 6 September 2026; the API, managed MySQL database, and private
S3 storage are live on AWS. The existing Supabase project and legacy
Cloudflare Pages project remain intact as rollback sources; the cutover did not
delete either one. AppSync is disabled for this deployment.

## Live topology

```text
Browser
  -> Cloudflare Pages project cirkle-react
       https://cirkle.world (canonical)
       https://www.cirkle.world
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

The production version-2 Supabase export was imported into AWS and its final
automatic reconciliation returned `passed`. The authoritative cutover totals
recorded on 6 September 2026 are:

| Data | Count |
| --- | ---: |
| Source `public` tables | 64 |
| Source `public` rows | 2,395 |
| Auth users | 35 |
| Imported bcrypt password verifiers | 14 |
| S3 media objects | 8 |
| S3 media bytes | 1,368,387 |

The final post-domain-cutover version-2 content-digest prefix is `bd4d1c45...`.
Two consecutive exports matched exactly. Compared with the initially imported
`2b376887...` snapshot, only the archived legacy
`realtime_delivery_outbox` control/retry payload changed; no user/content table,
auth record, bucket, or object changed. The stable final snapshot was applied
idempotently with API writes paused and reconciliation again returned `passed`.
Its restricted, versioned, AES-256-encrypted archive is
`migration-archives/2026-09-06/cirkle-supabase-v2-bd4d1c45.tar.gz` in the
private media bucket. Preserve the
complete manifest and digest in the restricted migration evidence; do not infer
or publish the omitted digest suffix. The eight copied objects were verified by
count, byte total, and object hash before the database transaction committed.
The private source snapshot and compatibility records preserve tables that do
not have first-class runtime models.

Fourteen valid bcrypt verifiers were imported through the protected migration
path. Users without a portable verifier must use password reset. Supabase
access/refresh sessions, OTPs, and reset challenges were not imported, so every
user must establish a fresh Cirkle session. Google identities retain their
provider subject. Never invent passwords or migrate live challenges.

The database-transport rollout was bracketed by two verified, encrypted,
checksummed logical backups in
`cirkle-react-deploymentbucket-vs0hxjf6smax`:

- Pre-change: `backups/mysql/cirkle-20260905T182055Z.sql.gz`
- Post-change: `backups/mysql/cirkle-20260905T182415Z.sql.gz`

The final version-2 import was separately bracketed by:

- Pre-import: `backups/mysql/cirkle-20260905T182721Z.sql.gz`
- Post-import: `backups/mysql/cirkle-20260905T182818Z.sql.gz`

The final stable outbox-archive reconciliation was bracketed by:

- Pre-delta: `backups/mysql/cirkle-20260905T185002Z.sql.gz`
- Post-delta: `backups/mysql/cirkle-20260905T185232Z.sql.gz`

The production frontend no longer depends on Supabase. The Supabase project and
legacy `cirkle.pages.dev` frontend nevertheless remain reachable because the
cutover requirement prohibited changing or deleting them. The matching final
exports prove source stability during that observation window, but do not prove
an independently enforced global write freeze. Treat the legacy system as
rollback-only, keep the protected version-2 export for the agreed evidence
window, and do not accept independent writes on both systems or attempt an
ad-hoc merge.

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
legacy `t4g.small` EC2 deployment, its 20-GiB gp3 volume and public IPv4,
retained RDS snapshots, and old buckets make the temporary whole-account
run-rate approximately **USD 37.70-42/month** before tax, credits, and traffic.
That is not the intended production-stack cost in the table above. In
particular,
`cirkle-react-deploymentbucket-vs0hxjf6smax` is still the new database-backup
destination even though the older `cirkle-react` CloudFormation stack owns it;
do not delete that stack wholesale. Decommission resources only after explicit
approval, dependency review, and a proven rollback window. Upgrade the API to
the 2 GiB bundle if sustained memory is above 70-75%, swap activity is
persistent, or latency/error alarms trigger.

Current cost/health guardrails are the USD 23/month
`Cirkle-Monthly-Cost` budget (80% forecast and 100% actual notifications) and
six Lightsail API/database alarms. All six alarms were `OK` at the 6 September
audit. The Gmail Lightsail contact confirmation link was accepted, although
the Lightsail API still reported `PendingVerification` afterward. A budget
sends notifications; it is not a hard service limit. The retained rollback
resources are expected to trigger the USD 23 budget until they are explicitly
decommissioned.

## Completed provider checks and remaining operational items

Completed on 5-6 September 2026: replacement ZeptoMail India and Google OAuth
credentials were confirmed in the Lightsail application secret, and the
credentials pasted into development chat were no longer active. Google OAuth
completed end to end on the live custom domain. ZeptoMail India delivery also
completed end to end to the deliverable `sunandgarg@gmail.com` mailbox:
Gmail received the branded sign-in-code message from `noreply@cirkle.world`
with its inline logo. A separate test to `sunandgarg@cirkle.world` hard-bounced
because that custom-domain mailbox was not deliverable. The exposed original
KLIPY key was revoked and replaced inside the already-approved `cirkle.world`
PRODUCTION platform; provider search/share and the live Cirkle GIF picker passed
with the replacement before the TESTING credential left the live environment.
The three database identities were also rolled out with verified
AWS-CA TLS, `require_secure_transport=1` was activated by a controlled managed
database reboot, and both the pre-change and post-change encrypted/checksummed
S3 backups succeeded. Lightsail returned to `available`/`in-sync`, every scoped
identity reported `TLS_AES_256_GCM_SHA384`, and API database/storage readiness
passed afterward. The unused `aws.cirkle.world` ACM certificate is now
`ISSUED`: two stale NameBright child-zone NS records were removed after their
values were recorded, allowing the retained Cloudflare validation CNAME to
resolve authoritatively.

1. Create/fix the `sunandgarg@cirkle.world` mailbox if that address should receive mail; the ZeptoMail India transport and branded login template are already live-verified with a deliverable Gmail recipient.
2. Monitor the open CloudFront account-verification case. After AWS removes the account hold, deploy the conditional distribution and test signed/private/public media behavior and cache headers.
3. Monitor Amazon SES production-access reconsideration. The `cirkle.world` SES identity and DKIM are verified, but do not use SES until AWS approves regional production access and delivery/bounce/complaint acceptance passes.
4. Configure and live-test OpenAI, Gemini, and Daily credentials where those features are required.
5. Confirm that Lightsail changes the Gmail contact from `PendingVerification` to `Valid`, allow the API burst balance to recover after release builds, and restore one fresh S3 backup into an isolated MySQL instance before declaring disaster recovery rehearsed.
6. Enroll root MFA/passkey, configure IAM Identity Center with a scoped operator permission set, switch routine CLI use to `aws configure sso`, and stop using the browser-backed root CLI session. Do not create a permanent root access key.
7. Retain the complete version-2 manifest, digest, reconciliation output, source-freeze/change-control evidence, and object-hash report in restricted storage. The digest and reconciliation result alone do not prove that every source writer was frozen.
8. Keep the legacy Pages project, Supabase project, prior API release, old EC2 resources, retained buckets, and rollback secrets until the rollback window is explicitly closed. Review ownership first: the older `cirkle-react` CloudFormation stack still owns the active database-backup bucket, so the stack must not be deleted wholesale.

## Apex cutover and rollback

The apex and `www` production hostnames are now attached to Cloudflare Pages
project `cirkle-react`; `https://cirkle.world` is the canonical frontend. The
API allowlist contains
`https://cirkle.world`, `https://www.cirkle.world`,
`https://cirkle-react.cirkle.world`, and `https://cirkle-react.pages.dev`.
Keep both hostnames associated through the Pages custom-domain workflow;
changing a CNAME alone can leave a hostname associated with the wrong Pages
project. `www` currently serves the same verified Pages artifact as the apex;
no redirect is configured. If a canonical redirect is added later, verify that
it preserves paths and query parameters. Retain the legacy `cirkle` Pages
project, its default `cirkle.pages.dev` hostname, and the last known-good
`cirkle-react` deployment throughout the rollback window.

For frontend rollback, reattach `www` and then the apex to the legacy Pages
project through its custom-domain workflow and verify DNS/SSL before declaring
recovery. Do not delete or rewrite AWS/Supabase data during a frontend rollback.
The `cirkle-react.cirkle.world` hostname remains available to diagnose the AWS
path independently. See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the ordered gate.
