# Cirkle React budget AWS hosting

This is the independent `cirkle-react` deployment. It does not delete or modify the existing Supabase project, the existing EC2 deployment, `cirkle.world`, or `www.cirkle.world`. AppSync is disabled for this deployment.

## Live topology

```text
Browser
  -> Cloudflare Pages: https://cirkle-react.cirkle.world
  -> HTTPS API/Socket.IO: https://api-react.cirkle.world
       -> Lightsail instance cirkle-react-api (Mumbai, $7 bundle)
       -> Lightsail managed MySQL 8.4 cirkle-react-mysql (private, $15 bundle)
       -> private encrypted/versioned S3 bucket
```

- The API server is a 1 GiB/2-vCPU Lightsail instance with a static IP, Nginx, Let's Encrypt TLS, Node 22, a memory-bounded systemd service, 2 GiB swap, bounded journald/log rotation, a restrictive firewall, and CPU/status alarms.
- MySQL is the managed Lightsail 1 GiB plan. It is private to the Lightsail network, retains automatic backups, and is not exposed on port 3306. AWS lists the USD 15 standard tier as not providing managed-database storage encryption; the USD 30 tier is required if primary-volume encryption at rest is mandatory. Passwords/tokens remain hashed and application/provider secrets are never placed in this database.
- User bytes are stored in the private, AES-256-encrypted, versioned S3 bucket `cirkle-react-media-mediabucket-phet4t6hharr`. S3 public access is blocked.
- Text, relationships, metadata, object paths, hashes, permissions, and audit records live in MySQL. Image/file bytes do not live in MySQL.
- Socket.IO is the realtime transport. AppSync values are absent from the Pages build and API environment, so hidden browser tabs do not accumulate AppSync connection-minute charges.
- Secrets are held in AWS Secrets Manager and installed as root-owned host environment files. Secrets must never be stored in MySQL or exposed through `VITE_*` browser variables.

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

## Reproducible resources and deployment

- `aws/hosting/bootstrap-lightsail.sh`: host packages, Node, Nginx, TLS automation, swap, systemd hardening, bounded logs.
- `aws/hosting/setup-lightsail-db.sh`: idempotent database/app-user creation with least-privilege schema grants.
- `aws/hosting/cirkle-react-media.yaml`: retained private S3 media, optional CloudFront OAC/signed delivery, least-privilege media IAM user.
- `aws/hosting/deploy-lightsail-release.sh`: immutable release build, migration, DB/storage preflight, atomic symlink switch, health wait, rollback.
- `aws/hosting/backup-managed-mysql.sh` and `install-managed-backup.sh`: daily consistent encrypted logical dumps to the separate deployment bucket, with locking and monitored systemd execution.

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
| Lightsail managed MySQL | 1 GiB, 2 vCPU, 40 GB, automatic backups; primary storage not encrypted on this tier | 15.00 |
| Secrets Manager | 3 secrets | 1.20 plus requests |
| S3 | current media and logical backups | 0.10-0.50 initially |
| Cloudflare Pages | frontend | 0.00 on current plan |
| AppSync | disabled | 0.00 |
| CloudFront | blocked pending account verification; normally usage/free-tier dependent | 0.00 currently |

The existing EC2 deployment, retained RDS snapshots, old buckets, and old secrets were intentionally left intact, so the AWS invoice is temporarily higher than this target architecture. Decommission them only after explicit approval and a proven rollback window. Upgrade the API to the 2 GiB bundle if sustained memory is above 70-75%, swap activity is persistent, or latency/error alarms trigger.

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
5. Decide whether the budget constraint or encrypted primary MySQL storage wins: keep the private USD 15 tier with encrypted off-boundary dumps, or upgrade to the USD 30 encrypted tier.
6. Confirm the AWS alert email, allow the API burst balance to recover after release builds, and restore one fresh S3 backup into an isolated MySQL instance before declaring disaster recovery rehearsed.
