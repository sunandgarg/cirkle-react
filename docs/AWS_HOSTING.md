# AWS hosting and Supabase migration

The `cirkle-react` deployment is intentionally independent from the existing Cloudflare/Supabase production site. It copies source data without deleting it. AppSync is not created by this stack and remains disabled until the separately owned AppSync account is connected.

## Architecture

- An AWS Application Load Balancer terminates TLS for the React SPA, `/api/*`, and `/socket.io/*`; Nginx serves the built SPA and proxies API/realtime traffic to one hardened Node 22 systemd service.
- A private, encrypted, versioned S3 deployment bucket retains source/build artifacts for 30 days. CloudFront is intentionally absent because this account currently rejects new distributions pending AWS Support verification.
- RDS MySQL is encrypted, private, deletion-protected, and reachable only from the API security group.
- Uploaded bytes are private, encrypted and versioned in S3. Authorization and signed application URLs remain enforced by the Node API.
- EC2 uses an IAM role; there are no long-lived AWS access keys on the host.
- Database credentials and application/provider configuration are held in Secrets Manager. Never store provider secrets in MySQL or `VITE_*` variables.
- The host is administered with Systems Manager Session Manager; SSH is not exposed.

## Create the isolated stack

The first infrastructure attempt retained its encrypted/deletion-protected RDS database and two subnets. `cirkle-react.yaml` deliberately references those existing resources and creates only the independent application layer; it never deletes or replaces the database.

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
    ExistingDatabaseSecurityGroupId='sg-...' \
    ExistingDatabaseEndpoint='database.ap-south-1.rds.amazonaws.com' \
    ExistingDatabaseSecretArn='arn:aws:secretsmanager:ap-south-1:ACCOUNT:secret:rds!...' \
    ApplicationDomain=cirkle-react.cirkle.world \
    CertificateArn='arn:aws:acm:ap-south-1:ACCOUNT:certificate/CERTIFICATE_ID'
```

The current AWS India free plan caps automated RDS backup retention at one day. Upgrade the account plan and raise `BackupRetentionPeriod` to at least seven days before production cutover. Also configure encrypted cross-region/off-account backups and prove a restore.

## Build frontend

The AWS load balancer is same-origin, so the browser receives no infrastructure secret and no separate API hostname is required.

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
- Database: the retained private/deletion-protected MySQL `db.t4g.micro` instance from the first non-destructive stack attempt
- Object storage: private, encrypted and versioned S3
- Realtime: Socket.IO only; AppSync is deliberately excluded from this AWS account
- Backup: one-day automated RDS retention under the current AWS plan plus manual snapshot `cirkle-react-initial-20260905`

The verified source copy contained 35 auth users, 638 public rows, and eight Storage objects (1,368,387 bytes). Destination reconciliation found 35 users, 17 profiles, 106 posts, seven connections, 40 jobs, 126 events, two RSVPs, 338 legacy records, and eight S3 objects with the same total byte size. Supabase was read only and remains unchanged.

## Estimated monthly AWS cost

The low-traffic, single-instance estimate for Mumbai is approximately **USD 57-63 per month**, before tax, outbound data transfer and third-party provider usage:

| Service | Assumption | Approx. USD/month |
| --- | --- | ---: |
| EC2 | one `t4g.small`, 730 hours | 8.18 |
| RDS MySQL | one Single-AZ `db.t4g.micro`, 730 hours | 15.33 |
| Application Load Balancer | 730 hours | 17.45 |
| ALB capacity | low traffic, up to one average LCU | 0-5.84 |
| EC2 gp3 | 20 GiB | 1.82 |
| RDS gp3 | 20 GiB | 2.62 |
| Public IPv4 | approximately three address-hours | 10.95 |
| Secrets Manager | two secrets | 0.80 plus requests |
| S3 | current objects and deployment artifacts | less than 0.10 plus requests |

Usage, backups, logs, object growth and internet egress increase this estimate. AWS credits may reduce the invoice while eligible, but are not treated as a durability or architecture dependency.
