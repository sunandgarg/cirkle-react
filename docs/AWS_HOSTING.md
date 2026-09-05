# AWS hosting and Supabase migration

The `cirkle-react` deployment is intentionally independent from the existing Cloudflare/Supabase production site. It copies source data without deleting it. AppSync is not created by this stack and remains disabled until the separately owned AppSync account is connected.

## Architecture

- A stable Elastic IP routes directly to Nginx on one EC2 instance. Nginx terminates Let's Encrypt TLS for the React SPA, `/api/*`, and `/socket.io/*`, then proxies API/realtime traffic to one hardened Node 22 systemd service.
- A private, encrypted, versioned S3 deployment bucket retains source/build artifacts for 30 days. CloudFront is intentionally absent because this account currently rejects new distributions pending AWS Support verification.
- MySQL 8.4 runs in a memory-bounded Docker container bound only to EC2 loopback. Its data resides on the instance's encrypted gp3 volume.
- Uploaded bytes are private, encrypted and versioned in S3. Authorization and signed application URLs remain enforced by the Node API.
- EC2 uses an IAM role; there are no long-lived AWS access keys on the host.
- Database credentials and application/provider configuration are held in Secrets Manager. Never store provider secrets in MySQL or `VITE_*` variables.
- The host is administered with Systems Manager Session Manager; SSH is not exposed.

## Create or update the isolated stack

`cirkle-react.yaml` represents the budget application layer. The Elastic IP is allocated separately with a retention tag so stack replacement cannot silently discard the public address.

```bash
aws cloudformation deploy \
  --region ap-south-1 \
  --stack-name cirkle-react \
  --template-file aws/hosting/cirkle-react.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ExistingVpcId='vpc-...' \
    ExistingPublicSubnetA='subnet-...' \
    ExistingPublicSubnetB='subnet-...' \
    StaticPublicIp='15.252.62.154' \
    ApplicationDomain=cirkle-react.cirkle.world \
    InstanceType=t4g.small
```

`migrate-rds-to-local.sh` performs a consistent source dump, restores it to loopback MySQL, switches the API only after readiness succeeds, and retains the dump. `backup-local-mysql.sh` runs daily through a hardened systemd timer and keeps 35 days of encrypted S3 backups. The encrypted RDS snapshots `cirkle-react-initial-20260905` and `cirkle-react-rds-final-20260905` remain available for disaster recovery.

## Build frontend

The direct Nginx topology is same-origin, so the browser receives no infrastructure secret and no separate API hostname is required.

```bash
VITE_API_URL='' \
VITE_CHAT_REALTIME_PROVIDER=socketio \
VITE_DAILY_CALLS_ENABLED=true \
pnpm build:aws
```

The deployment helper installs `dist/` on the Nginx host from the private `DeploymentBucketName`. The existing Cloudflare Pages project, `cirkle.world`, and `www.cirkle.world` must not be changed.

## Secrets

Populate the stack's `AppConfigSecretArn` using `aws secretsmanager put-secret-value` from a mode-0600 JSON file. Generate independent random values for JWT access, JWT refresh, IP hashing, OTP pepper, and storage signing. Provider values belong only in this secret or a dedicated provider secret.

The ZeptoMail token posted in chat must be rotated before use. Configure the replacement as `ZEPTOMAIL_TOKEN`, with `ZEPTOMAIL_API_URL=https://api.zeptomail.in/v1.1/email` and `ZEPTOMAIL_FROM_EMAIL=noreply@cirkle.world`.

## Supabase migration

`scripts/export-supabase.mjs` reads with a service-role key and writes a protected manifest plus every Storage object. It never mutates the source. `server/src/scripts/import-supabase-full.ts` imports the current relational and legacy models while preserving UUIDs, then uploads bytes to the configured object store.

```bash
SUPABASE_URL=https://bugwubrwvlqayxwcazfd.supabase.co \
SUPABASE_SERVICE_ROLE_KEY='read-from-a-protected-shell-secret' \
SUPABASE_EXPORT_DIR=/secure/cirkle-export \
pnpm supabase:export

DATABASE_URL='mysql://...' STORAGE_DRIVER=s3 AWS_REGION=ap-south-1 S3_BUCKET='...' \
pnpm supabase:import:full --file=/secure/cirkle-export/manifest.json --apply --upload-objects
```

Passwords and active Supabase sessions are not portable through the Admin API. Google identities retain their provider subject. Email/password-only users are imported without a password and must complete Cirkle's password-reset flow. Do not silently invent passwords or copy active OTP challenges.

This copy is not a cutover: Supabase remains intact and writable. Compare exact per-table/per-bucket counts and sampled ownership/media references, then test login, password recovery and two-browser Socket.IO behavior on `https://cirkle-react.cirkle.world` independently.

## Deployed copy (2026-09-05)

- URL: `https://cirkle-react.cirkle.world`
- CloudFormation stack: `cirkle-react` in `ap-south-1`
- Compute: one Graviton `t4g.small` EC2 instance, 20 GiB encrypted gp3, Nginx and Node 22
- Database: loopback-only MySQL 8.4 on encrypted EC2 storage, with a 768 MiB container memory ceiling and 2 GiB swap protection
- Object storage: private, encrypted and versioned S3
- Realtime: Socket.IO only; AppSync is deliberately excluded from this AWS account
- Backup: daily encrypted S3 MySQL dumps retained for 35 days, plus encrypted manual RDS snapshots `cirkle-react-initial-20260905` and `cirkle-react-rds-final-20260905`

The verified source copy contained 35 auth users, 638 public rows, and eight Storage objects (1,368,387 bytes). Destination reconciliation found 35 users, 17 profiles, 106 posts, seven connections, 40 jobs, 126 events, two RSVPs, 338 legacy records, and eight S3 objects with the same total byte size. Supabase was read only and remains unchanged.

## Estimated monthly AWS cost

The low-traffic, single-instance estimate for Mumbai is approximately **USD 15-18 per month**, before tax, outbound data transfer and third-party provider usage:

| Service | Assumption | Approx. USD/month |
| --- | --- | ---: |
| EC2 | one `t4g.small`, 730 hours | 8.18 |
| EC2 gp3 | 20 GiB | 1.82 |
| Elastic IPv4 | one attached address, 730 hours | 3.65 |
| Secrets Manager | one application secret | 0.40 plus requests |
| S3 | uploads, artifacts and 35-day database backups | approximately 0.10-0.50 initially |
| Retained RDS snapshot | approximately 20 GiB snapshot storage | approximately 1.90-2.60 |

Usage, backups, logs, object growth and internet egress increase this estimate. AWS credits may reduce the invoice while eligible, but are not treated as a durability or architecture dependency.
